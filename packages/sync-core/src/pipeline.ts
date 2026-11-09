import fs from 'node:fs';
import path from 'node:path';
import { WeChatClient, WeChatError } from '@md2posts/wechat-sdk';
import {
  HeyBoxClient,
  type HeyBoxPublishResult,
  type HeyBoxPreparedResult,
} from '@md2posts/heybox-sdk';
import { renderArticle, preprocessMarkdown } from '@md2posts/renderer';
import { FsSource, SourcePost, findGitRoot, resolveLocalAsset } from '@md2posts/sources';
import { StateStore } from './state-store.js';
import { ImageProcessor } from './image-processor.js';
import { normalizeWeChatTitle, normalizeWeChatDigest } from './normalize.js';
import { sendSyncNotification } from './notifier.js';
import {
  checkWeChatCredentials,
  checkHeyBoxSession,
  formatCredentialFailure,
  resolveTargets,
  type CredentialStatus,
  type PlatformTarget,
} from './preflight.js';
import type { AppConfig } from './config.js';

export interface CheckPostItem {
  id: string;
  title: string;
  normalizedTitle: string;
  status: 'new' | 'updated' | 'unchanged' | 'baselined' | 'draft';
  publishedAt?: string;
  imageCount: number;
  hasCover: boolean;
  warningsCount: number;
}

export interface CheckReport {
  total: number;
  published: number;
  drafts: number;
  newCount: number;
  updatedCount: number;
  baselinedCount: number;
  unchangedCount: number;
  items: CheckPostItem[];
}

export interface PushResult {
  id: string;
  title: string;
  normalizedTitle: string;
  mediaId: string;
  isUpdate: boolean;
  warnings: string[];
  wechat?: PushResult;
  heybox?: HeyBoxPublishResult;
}

export interface PipelinePreviewResult {
  post: SourcePost;
  target: 'wechat' | 'heybox';
  articleHtml?: string;
  fullPageHtml: string;
  warnings: string[];
  normalizedTitle: string;
  heybox?: { bundleDir: string; prepared: HeyBoxPreparedResult };
}

export interface SyncReport {
  scanned: number;
  pushed: PushResult[];
  failed: Array<{ id: string; error: string }>;
  skippedUpdatedCount: number;
  skippedDueToLimit: number;
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'image/jpeg';
  }
}

export class SyncPipeline {
  private readonly config: AppConfig;
  private readonly source: FsSource;
  private readonly stateStore: StateStore;
  private readonly imageProcessor: ImageProcessor;
  private readonly wechatClient: WeChatClient;
  private readonly heyboxPublisher: HeyBoxClient;

  constructor(
    config: AppConfig,
    wechatClient?: WeChatClient,
    heyboxPublisher?: HeyBoxClient
  ) {
    this.config = config;
    this.source = new FsSource(config.source);
    this.stateStore = new StateStore(config.sync.stateFile);
    this.imageProcessor = new ImageProcessor({
      downloadRemote: config.sync.downloadRemoteImages,
    });
    this.wechatClient =
      wechatClient ||
      new WeChatClient({
        appId: config.wechat.appId,
        appSecret: config.wechat.appSecret,
      });
    this.heyboxPublisher =
      heyboxPublisher ||
      new HeyBoxClient({
        assetRoots: config.source.assetRoots,
        defaultCoverPath: config.sync.defaultCover,
        sessionFile: config.heybox?.sessionFile,
        browserChannel: config.heybox?.browserChannel,
        headless: config.heybox?.headless,
        codeBlockMode: config.heybox?.codeBlockMode,
      });
  }

  /**
   * Fails fast when a requested target has no usable credentials.
   *
   * Runs before scan/pull so a misconfigured host does not burn API calls per post,
   * and so the process exits non-zero (systemd then reports a failed unit instead of
   * a successful no-op). Skipped for dry runs, which never touch the network.
   */
  /**
   * Resolves which platforms can actually run, based on credential readiness.
   *
   * A platform that is not ready is *skipped with a warning* so the other platform keeps
   * syncing; the run only aborts when every requested platform is unusable. This keeps a
   * missing HeyBox session from silently disabling WeChat (and vice versa).
   */
  private resolveReadyTargets(
    target: PlatformTarget | 'all',
    dryRun: boolean
  ): PlatformTarget | 'all' {
    // Dry runs never authenticate, so credentials cannot block them.
    if (dryRun) return target;

    const statuses: Record<PlatformTarget, CredentialStatus> = {
      wechat: this.wechatClient.isDryRun
        ? { ready: true, errors: [], warnings: [] }
        : checkWeChatCredentials(
            // Prefer the effective client (tests/programmatic use may inject one) over raw config.
            this.config.wechat.appId || this.wechatClient.appId,
            Boolean(this.config.wechat.appSecret) || this.wechatClient.hasAppSecret
          ),
      heybox: checkHeyBoxSession(
        this.heyboxPublisher.hasSession(),
        this.config.heybox?.sessionFile
      ),
    };

    for (const t of ['wechat', 'heybox'] as PlatformTarget[]) {
      for (const w of statuses[t].warnings) {
        console.warn(`[Preflight] ${w}`);
      }
    }

    const resolved = resolveTargets(target, statuses);

    if (resolved.blocked) {
      const messages = resolved.skipped.map(({ target: t, status }) =>
        formatCredentialFailure(t === 'wechat' ? '微信' : '小黑盒', status)
      );
      throw new Error(messages.join('\n'));
    }

    for (const { target: t, status } of resolved.skipped) {
      console.warn(
        formatCredentialFailure(t === 'wechat' ? '微信' : '小黑盒', status).replace(
          '已中止本次运行（未推送任何文章）',
          '本次已跳过该平台，其他平台继续运行'
        )
      );
    }

    return resolved.effective;
  }

  public async prepare(options: { forcePull?: boolean } = {}): Promise<void> {
    const lastPullAt = this.stateStore.getLastGitPullAt();
    await this.source.prepare?.({
      forcePull: options.forcePull,
      lastPullAt,
      onPullSuccess: (nowIso: string) => {
        this.stateStore.setLastGitPullAt(nowIso);
      },
    });
  }

  /**
   * Dry-run inspects all posts and returns status breakdown without making external API calls.
   */
  public async check(options: { forcePull?: boolean } = {}): Promise<CheckReport> {
    await this.prepare(options);
    const posts = await this.source.scanPosts();
    const items: CheckPostItem[] = [];

    let newCount = 0;
    let updatedCount = 0;
    let baselinedCount = 0;
    let unchangedCount = 0;
    let drafts = 0;

    for (const post of posts) {
      const pre = preprocessMarkdown(post.bodyMarkdown, {
        siteUrl: this.config.site.url,
        postCanonicalUrl: post.canonicalUrl,
        shiftBodyHeadings: this.config.render.shiftBodyHeadings,
        imageCaptionMode: this.config.render.imageCaptionMode,
      });

      const { title: normTitle } = normalizeWeChatTitle(post.title);
      const state = this.stateStore.getPost(post.id);

      let status: CheckPostItem['status'] = 'new';
      if (post.draft) {
        status = 'draft';
        drafts++;
      } else if (!state) {
        status = 'new';
        newCount++;
      } else if (state.status === 'baselined') {
        if (state.contentHash === post.contentHash) {
          status = 'baselined';
          baselinedCount++;
        } else {
          status = 'updated';
          updatedCount++;
        }
      } else if (state.contentHash === post.contentHash) {
        status = 'unchanged';
        unchangedCount++;
      } else {
        status = 'updated';
        updatedCount++;
      }

      items.push({
        id: post.id,
        title: post.title,
        normalizedTitle: normTitle,
        status,
        publishedAt: post.publishedAt,
        imageCount: pre.imageRefs.length,
        hasCover: Boolean(post.coverRaw || this.config.sync.defaultCover),
        warningsCount: pre.warnings.length,
      });
    }

    return {
      total: posts.length,
      published: posts.length - drafts,
      drafts,
      newCount,
      updatedCount,
      baselinedCount,
      unchangedCount,
      items,
    };
  }

  /**
   * Marks historical posts as baselined so routine sync ignores them.
   */
  public async baseline(
    options: {
      exceptSlug?: string;
      onlySlugs?: string[];
      beforeDate?: string;
      remote?: boolean;
    } = {}
  ): Promise<{
    baselinedCount: number;
    matchedDraftCount: number;
    matchedPublishedCount: number;
    publishListUnauthorized: boolean;
  }> {
    return await this.stateStore.withLock(async () => {
      await this.prepare();
      const posts = await this.source.scanPosts();

      if (options.remote) {
        let matchedDraftCount = 0;
        let matchedPublishedCount = 0;
        let publishListUnauthorized = false;
        const now = new Date().toISOString();
        const pageSize = 20;

        const urlToPost = new Map<string, SourcePost>();
        const titleToPost = new Map<string, SourcePost>();

        for (const post of posts) {
          if (post.canonicalUrl) {
            urlToPost.set(post.canonicalUrl.replace(/\/+$/, ''), post);
          }
          urlToPost.set(post.id, post);
          titleToPost.set(post.title.trim(), post);
          const { title: norm } = normalizeWeChatTitle(post.title);
          titleToPost.set(norm.trim(), post);
        }

        const matchLocalPost = (contentSourceUrl?: string, title?: string): SourcePost | undefined => {
          if (contentSourceUrl) {
            const clean = contentSourceUrl.replace(/\/+$/, '');
            if (urlToPost.has(clean)) return urlToPost.get(clean);
          }
          if (title) {
            const trimmed = title.trim();
            if (titleToPost.has(trimmed)) return titleToPost.get(trimmed);
          }
          return undefined;
        };

        let draftOffset = 0;
        while (true) {
          const batch = await this.wechatClient.draft.batchGet(draftOffset, pageSize, 1);
          const items = batch.item || [];
          if (items.length === 0) break;

          for (const draftItem of items) {
            const mediaId = draftItem.media_id;
            const newsItem = draftItem.content?.news_item?.[0];
            if (!mediaId || !newsItem) continue;

            const matchedPost = matchLocalPost(newsItem.content_source_url, newsItem.title);
            if (matchedPost) {
              this.stateStore.setPost(matchedPost.id, {
                contentHash: matchedPost.contentHash,
                title: matchedPost.title,
                draftMediaId: mediaId,
                status: 'synced',
                pushedAt: now,
              });
              matchedDraftCount++;
            }
          }

          draftOffset += items.length;
          if (draftOffset >= (batch.total_count || 0) || items.length < pageSize) {
            break;
          }
        }

        try {
          let pubOffset = 0;
          while (true) {
            const batch = await this.wechatClient.publish.batchGet(pubOffset, pageSize, 1);
            const items = batch.item || [];
            if (items.length === 0) break;

            for (const pubItem of items) {
              const newsItem = pubItem.content?.news_item?.[0];
              if (!newsItem) continue;

              const matchedPost = matchLocalPost(newsItem.content_source_url, newsItem.title);
              if (matchedPost && !this.stateStore.getPost(matchedPost.id)) {
                this.stateStore.setPost(matchedPost.id, {
                  contentHash: matchedPost.contentHash,
                  title: matchedPost.title,
                  status: 'synced',
                  pushedAt: now,
                });
                matchedPublishedCount++;
              }
            }

            pubOffset += items.length;
            if (pubOffset >= (batch.total_count || 0) || items.length < pageSize) {
              break;
            }
          }
        } catch (err: any) {
          if (err instanceof WeChatError && err.isUnauthorized()) {
            publishListUnauthorized = true;
          } else {
            throw err;
          }
        }

        this.stateStore.save();
        return {
          baselinedCount: 0,
          matchedDraftCount,
          matchedPublishedCount,
          publishListUnauthorized,
        };
      }

      const exceptSet = new Set(
        (options.exceptSlug || '')
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean)
      );
      const onlySet =
        options.onlySlugs && options.onlySlugs.length > 0
          ? new Set(options.onlySlugs)
          : null;

      const toBaseline: Array<{ id: string; title: string; contentHash: string }> = [];

      for (const post of posts) {
        if (post.draft) continue;
        if (exceptSet.has(post.id)) continue;
        if (onlySet && !onlySet.has(post.id)) continue;
        if (options.beforeDate && post.publishedAt && post.publishedAt >= options.beforeDate) continue;

        toBaseline.push({
          id: post.id,
          title: post.title,
          contentHash: post.contentHash,
        });
      }

      this.stateStore.markBaseline(toBaseline);
      return {
        baselinedCount: toBaseline.length,
        matchedDraftCount: 0,
        matchedPublishedCount: 0,
        publishListUnauthorized: false,
      };
    });
  }

  /**
   * Generates offline local preview for a post without external network requests.
   * Supports target: 'wechat' (default) or 'heybox'.
   */
  public async preview(
    slug: string,
    options: { to?: 'wechat' | 'heybox'; theme?: string; output?: string } = {}
  ): Promise<PipelinePreviewResult> {
    const target = (options.to || 'wechat').toLowerCase() as 'wechat' | 'heybox';

    const post = await this.source.getPost(slug);
    if (!post) {
      throw new Error(`[Pipeline] 未找到文章: ${slug}`);
    }

    // 1. HeyBox Preview
    if (target === 'heybox') {
      const { bundleDir, prepared } = await this.heyboxPublisher.exportPackage(post, options.output);
      return {
        post,
        target: 'heybox',
        fullPageHtml: prepared.previewHtml,
        warnings: [],
        normalizedTitle: prepared.title,
        heybox: { bundleDir, prepared },
      };
    }

    // 2. WeChat Preview
    const { title: normTitle } = normalizeWeChatTitle(post.title);
    const assetRoots = this.config.source.assetRoots || ['{postDir}'];

    const imageMap = new Map<string, string>();
    const preRes = preprocessMarkdown(post.bodyMarkdown, {
      siteUrl: this.config.site.url,
      postCanonicalUrl: post.canonicalUrl,
      shiftBodyHeadings: this.config.render.shiftBodyHeadings,
      imageCaptionMode: this.config.render.imageCaptionMode,
    });

    for (const ref of preRes.imageRefs) {
      const localPath = resolveLocalAsset(ref, post.postDir, assetRoots);
      if (localPath && fs.existsSync(localPath)) {
        try {
          const buf = fs.readFileSync(localPath);
          const mime = getMimeType(localPath);
          imageMap.set(ref, `data:${mime};base64,${buf.toString('base64')}`);
        } catch {
          imageMap.set(ref, ref);
        }
      }
    }

    const themeToUse = options.theme || this.config.render.theme;
    const renderRes = renderArticle(post.bodyMarkdown, {
      themeId: themeToUse,
      accent: this.config.render.accent,
      fontSize: this.config.render.fontSize,
      fontFamily: this.config.render.fontFamily,
      macCode: this.config.render.macCode,
      galleryMode: this.config.render.galleryMode,
      linksToFootnotes: this.config.render.linksToFootnotes,
      imageMap,
      headerCoverUrl: undefined,
      footerCard: this.config.render.appendCopyrightCard
        ? {
            title: post.title,
            author: this.config.site.author,
            canonicalUrl: post.canonicalUrl,
            licenseName: this.config.site.license,
            publishedAt: post.publishedAt,
          }
        : undefined,
      preprocess: {
        siteUrl: this.config.site.url,
        postCanonicalUrl: post.canonicalUrl,
        shiftBodyHeadings: this.config.render.shiftBodyHeadings,
        imageCaptionMode: this.config.render.imageCaptionMode,
      },
    });

    const fullPageHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtmlAttr(normTitle)} - 微信排版预览</title>
  <style>
    body {
      margin: 0;
      padding: 20px 10px;
      background: #f0f2f5;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .preview-header {
      width: 100%;
      max-width: 677px;
      margin-bottom: 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 14px;
      color: #666;
    }
    .preview-phone {
      width: 100%;
      max-width: 677px;
      background: #fff;
      border-radius: 8px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.08);
      box-sizing: border-box;
      padding: 20px 16px 40px;
      overflow-x: hidden;
    }
    .btn-copy {
      padding: 6px 14px;
      background: #07c160;
      color: #fff;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
    }
    .btn-copy:hover {
      background: #06ad56;
    }
  </style>
</head>
<body>
  <div class="preview-header">
    <div><strong>${escapeHtmlAttr(normTitle)}</strong> (${renderRes.theme.name})</div>
    <button class="btn-copy" onclick="copyContent()">一键复制富文本</button>
  </div>
  <div id="content-box" class="preview-phone">
    ${renderRes.html}
  </div>
  <script>
    async function copyContent() {
      const box = document.getElementById('content-box');
      try {
        const blob = new Blob([box.innerHTML], { type: 'text/html' });
        const textBlob = new Blob([box.innerText], { type: 'text/plain' });
        await navigator.clipboard.write([
          new ClipboardItem({ 'text/html': blob, 'text/plain': textBlob })
        ]);
        alert('富文本已复制成功！可直接在微信公众号后台编辑器中粘贴。');
      } catch (err) {
        alert('复制失败，请直接全选内容后手动复制。');
      }
    }
  </script>
</body>
</html>`;

    return {
      post,
      target: 'wechat',
      articleHtml: renderRes.html,
      fullPageHtml,
      warnings: renderRes.warnings.map((w) => w.detail),
      normalizedTitle: normTitle,
    };
  }

  /**
   * Pushes a single post to targeted platform(s): 'wechat' (default) | 'heybox' | 'all'.
   */
  public async push(
    slug: string,
    options: {
      to?: 'wechat' | 'heybox' | 'all';
      force?: boolean;
      dryRun?: boolean;
    } = {}
  ): Promise<PushResult> {
    return await this.stateStore.withLock(async () => {
      return await this.pushInternal(slug, options);
    });
  }

  private async pushInternal(
    slug: string,
    options: {
      to?: 'wechat' | 'heybox' | 'all';
      force?: boolean;
      dryRun?: boolean;
    } = {}
  ): Promise<PushResult> {
    const targetPlatform = (options.to || this.config.sync.target || 'wechat').toLowerCase() as
      | 'wechat'
      | 'heybox'
      | 'all';

    const effectiveTarget = this.resolveReadyTargets(
      targetPlatform,
      Boolean(options.dryRun)
    );

    const post = await this.source.getPost(slug);
    if (!post) {
      throw new Error(`[Pipeline] 未找到文章: ${slug}`);
    }

    let wechatRes: PushResult | undefined;
    let heyboxRes: HeyBoxPublishResult | undefined;

    // 1. WeChat Push
    if (effectiveTarget === 'wechat' || effectiveTarget === 'all') {
      wechatRes = await this.pushToWeChat(post, options);
    }

    // 2. HeyBox Push
    if (effectiveTarget === 'heybox' || effectiveTarget === 'all') {
      heyboxRes = await this.pushToHeyBox(post, options);
    }

    const primaryMediaId = wechatRes?.mediaId || heyboxRes?.draftId || '';
    const primaryTitle = wechatRes?.normalizedTitle || post.title;

    return {
      id: slug,
      title: post.title,
      normalizedTitle: primaryTitle,
      mediaId: primaryMediaId,
      isUpdate: wechatRes?.isUpdate ?? false,
      warnings: wechatRes?.warnings ?? [],
      wechat: wechatRes,
      heybox: heyboxRes,
    };
  }

  private async pushToHeyBox(
    post: SourcePost,
    options: { dryRun?: boolean } = {}
  ): Promise<HeyBoxPublishResult> {
    const res = await this.heyboxPublisher.publishDraft(post, { dryRun: options.dryRun });
    if (!options.dryRun && res.draftId) {
      const state = this.stateStore.getPost(post.id);
      if (state) {
        state.heyboxDraftId = res.draftId;
        state.heyboxSyncedAt = new Date().toISOString();
        this.stateStore.setPost(post.id, state);
        this.stateStore.save();
      }
    }
    return res;
  }

  private async pushToWeChat(
    post: SourcePost,
    options: { force?: boolean } = {}
  ): Promise<PushResult> {
    const slug = post.id;
    const { title: finalTitle } = normalizeWeChatTitle(post.title);
    const finalDigest = normalizeWeChatDigest(post.summary);
    const assetRoots = this.config.source.assetRoots || ['{postDir}'];

    const imageMap = new Map<string, string>();
    const warnings: string[] = [];

    const preRes = preprocessMarkdown(post.bodyMarkdown, {
      siteUrl: this.config.site.url,
      postCanonicalUrl: post.canonicalUrl,
      shiftBodyHeadings: this.config.render.shiftBodyHeadings,
      imageCaptionMode: this.config.render.imageCaptionMode,
    });

    for (const warn of preRes.warnings) {
      warnings.push(warn.detail);
    }

    for (const ref of preRes.imageRefs) {
      try {
        const wechatUrl = await this.imageProcessor.resolveAndUploadImage(
          ref,
          post.postDir,
          this.wechatClient,
          this.stateStore,
          assetRoots
        );
        if (wechatUrl) {
          imageMap.set(ref, wechatUrl);
        } else {
          warnings.push(`图片未找到或上传失败: ${ref}`);
        }
      } catch (err: any) {
        warnings.push(`图片上传异常 (${ref}): ${err.message}`);
      }
    }

    // Resolve cover: explicit frontmatter cover -> configured sync.defaultCover.
    // We deliberately do NOT guess a cover from arbitrary sibling screenshots or repo assets:
    // that made thumbnails unpredictable. Set sync.defaultCover for a site-wide default.
    let coverLocalPath: string | null = null;
    if (post.coverRaw) {
      coverLocalPath = resolveLocalAsset(post.coverRaw, post.postDir, assetRoots);
    }
    if (!coverLocalPath && this.config.sync.defaultCover) {
      // Support the {repoRoot} token so users can point at a repo asset (e.g. public/og/og.png)
      const repoRoot = findGitRoot(post.postDir) || '';
      const resolvedDefault = repoRoot
        ? this.config.sync.defaultCover.replace(/\{repoRoot\}/g, repoRoot)
        : this.config.sync.defaultCover;
      const defPath = path.resolve(resolvedDefault);
      if (fs.existsSync(defPath)) {
        coverLocalPath = defPath;
      }
    }

    if (!coverLocalPath) {
      throw new Error(
        `[Pipeline] 文章 ${slug} 没有可用封面：frontmatter 缺少 image，且 sync.defaultCover 未配置或文件不存在。` +
          `请在 config.yaml 中设置 sync.defaultCover（如 {repoRoot}/public/og/og.png）`
      );
    }

    const coverUpload = await this.imageProcessor.uploadCover(
      coverLocalPath,
      this.wechatClient,
      this.stateStore
    );

    const renderOutput = renderArticle(post.bodyMarkdown, {
      themeId: this.config.render.theme,
      accent: this.config.render.accent,
      fontSize: this.config.render.fontSize,
      fontFamily: this.config.render.fontFamily,
      macCode: this.config.render.macCode,
      galleryMode: this.config.render.galleryMode,
      linksToFootnotes: this.config.render.linksToFootnotes,
      imageMap,
      headerCoverUrl: this.config.render.insertHeaderCover ? coverUpload.url : undefined,
      footerCard: this.config.render.appendCopyrightCard
        ? {
            title: post.title,
            author: this.config.site.author,
            canonicalUrl: post.canonicalUrl,
            licenseName: this.config.site.license,
            publishedAt: post.publishedAt,
          }
        : undefined,
      preprocess: {
        siteUrl: this.config.site.url,
        postCanonicalUrl: post.canonicalUrl,
        shiftBodyHeadings: this.config.render.shiftBodyHeadings,
        imageCaptionMode: this.config.render.imageCaptionMode,
      },
    });

    const articleInput = {
      title: finalTitle,
      author: this.config.site.author.slice(0, 16),
      digest: finalDigest,
      content: renderOutput.html,
      content_source_url: post.canonicalUrl,
      thumb_media_id: coverUpload.mediaId,
      need_open_comment: this.config.sync.openComment,
      only_fans_can_comment: this.config.sync.onlyFansCanComment,
    };

    const existingState = this.stateStore.getPost(slug);
    let isUpdate = false;
    let finalMediaId = '';

    if (existingState?.draftMediaId && !options.force) {
      try {
        await this.wechatClient.draft.update(existingState.draftMediaId, 0, articleInput);
        isUpdate = true;
        finalMediaId = existingState.draftMediaId;
      } catch (err: any) {
        if (err instanceof WeChatError && err.isNonFallbackError()) {
          throw err;
        }
        console.warn(`[Pipeline] 更新草稿失败 (${err.message})，降级为新建草稿...`);
        finalMediaId = await this.wechatClient.draft.add([articleInput]);
      }
    } else {
      finalMediaId = await this.wechatClient.draft.add([articleInput]);
    }

    this.stateStore.setPost(slug, {
      contentHash: post.contentHash,
      title: post.title,
      draftMediaId: finalMediaId,
      status: 'synced',
      pushedAt: new Date().toISOString(),
      heyboxDraftId: existingState?.heyboxDraftId,
      heyboxSyncedAt: existingState?.heyboxSyncedAt,
    });
    this.stateStore.save();

    return {
      id: slug,
      title: post.title,
      normalizedTitle: finalTitle,
      mediaId: finalMediaId,
      isUpdate,
      warnings,
    };
  }

  /**
   * Synchronizes new articles (and optionally updated articles if includeUpdated is enabled) up to maxPerRun.
   * By default, pushes to the target platform specified by `options.to` or `config.sync.target`.
   */
  public async sync(
    options: {
      to?: 'wechat' | 'heybox' | 'all';
      includeUpdated?: boolean;
      forcePull?: boolean;
      dryRun?: boolean;
    } = {}
  ): Promise<SyncReport> {
    return await this.stateStore.withLock(async () => {
      const requestedTarget = (options.to || this.config.sync.target || 'wechat') as
        | PlatformTarget
        | 'all';
      const effectiveTarget = this.resolveReadyTargets(requestedTarget, Boolean(options.dryRun));

      await this.prepare({ forcePull: options.forcePull });
      const posts = await this.source.scanPosts();
      const shouldSyncUpdated = options.includeUpdated ?? this.config.sync.syncUpdated;

      const pendingPosts: SourcePost[] = [];
      let skippedUpdatedCount = 0;

      for (const post of posts) {
        if (post.draft) continue;
        const state = this.stateStore.getPost(post.id);
        if (!state) {
          pendingPosts.push(post);
        } else if (state.contentHash !== post.contentHash) {
          if (shouldSyncUpdated) {
            pendingPosts.push(post);
          } else {
            skippedUpdatedCount++;
          }
        }
      }

      const toProcess = pendingPosts.slice(0, this.config.sync.maxPerRun).reverse();
      const skippedDueToLimit = Math.max(0, pendingPosts.length - toProcess.length);

      const pushed: PushResult[] = [];
      const failed: Array<{ id: string; error: string }> = [];

      for (const post of toProcess) {
        try {
          const res = await this.pushInternal(post.id, {
            to: effectiveTarget,
            dryRun: options.dryRun,
          });
          pushed.push(res);
        } catch (err: any) {
          failed.push({ id: post.id, error: err.message });
        }
      }

      const report: SyncReport = {
        scanned: posts.length,
        pushed,
        failed,
        skippedUpdatedCount,
        skippedDueToLimit,
      };

      await sendSyncNotification(this.config.notify, report);
      return report;
    });
  }
}

function escapeHtmlAttr(str: string): string {
  return str.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
