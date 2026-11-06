import fs from 'node:fs';
import path from 'node:path';
import { WeChatClient, WeChatError } from '@md2wechat/wechat-sdk';
import { renderArticle, preprocessMarkdown } from '@md2wechat/renderer';
import { FsSource, SourcePost, findGitRoot } from '@md2wechat/sources';
import { StateStore } from './state-store.js';
import { ImageProcessor, resolveLocalAssetPath } from './image-processor.js';
import { normalizeWeChatTitle, normalizeWeChatDigest } from './normalize.js';
import { sendSyncNotification } from './notifier.js';
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

  constructor(config: AppConfig, wechatClient?: WeChatClient) {
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

      if (post.draft) {
        drafts++;
        items.push({
          id: post.id,
          title: post.title,
          normalizedTitle: normalizeWeChatTitle(post.title).title,
          status: 'draft',
          publishedAt: post.publishedAt,
          imageCount: pre.imageRefs.length,
          hasCover: Boolean(post.coverRaw),
          warningsCount: pre.warnings.length,
        });
        continue;
      }

      const state = this.stateStore.getPost(post.id);
      let status: CheckPostItem['status'];

      if (!state) {
        status = 'new';
        newCount++;
      } else if (state.status === 'baselined') {
        if (state.contentHash !== post.contentHash) {
          status = 'updated';
          updatedCount++;
        } else {
          status = 'baselined';
          baselinedCount++;
        }
      } else {
        if (state.contentHash !== post.contentHash) {
          status = 'updated';
          updatedCount++;
        } else {
          status = 'unchanged';
          unchangedCount++;
        }
      }

      items.push({
        id: post.id,
        title: post.title,
        normalizedTitle: normalizeWeChatTitle(post.title).title,
        status,
        publishedAt: post.publishedAt,
        imageCount: pre.imageRefs.length,
        hasCover: Boolean(post.coverRaw),
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
   * Marks existing posts as baselined so they won't be pushed on routine runs.
   * When `pullRemoteDrafts` is true, ONLY fetches existing drafts (`draft/batchget`) and
   * published articles (`freepublish/batchget`) from WeChat, matches them against local posts
   * by `content_source_url` or title, and writes the matched entries into `state.json`.
   */
  public async baseline(
    options: {
      beforeDate?: string;
      exceptSlug?: string;
      onlySlugs?: string[];
      pullRemoteDrafts?: boolean;
      forcePull?: boolean;
    } = {}
  ): Promise<{
    baselinedCount: number;
    matchedDraftCount: number;
    matchedPublishedCount: number;
    publishListUnauthorized: boolean;
  }> {
    return await this.stateStore.withLock(async () => {
      await this.prepare({ forcePull: options.forcePull });
      const posts = await this.source.scanPosts();

      const matchLocalPost = (remoteUrl?: string, remoteTitle?: string): SourcePost | undefined => {
        const cleanUrl = (remoteUrl || '').trim();
        const cleanTitle = (remoteTitle || '').trim();
        return posts.find((p) => {
          if (p.draft) return false;
          if (cleanUrl && (cleanUrl === p.canonicalUrl || cleanUrl.includes(`/posts/${p.id}`))) {
            return true;
          }
          if (!cleanTitle) return false;
          const normTitle = normalizeWeChatTitle(p.title).title;
          return cleanTitle === p.title || cleanTitle === normTitle;
        });
      };

      if (options.pullRemoteDrafts) {
        let matchedDraftCount = 0;
        let matchedPublishedCount = 0;
        let publishListUnauthorized = false;
        const pageSize = 20;
        const now = new Date().toISOString();

        // 1. Fetch from WeChat Draft Box (cgi-bin/draft/batchget)
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

        // 2. Also attempt to fetch from WeChat Published Articles (cgi-bin/freepublish/batchget)
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

      // Offline baseline mode: mark selected/all local posts as baselined
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
   * Previews a post locally, generating clean WeChat HTML with standalone page wrapper for browser inspection.
   */
  public async preview(slug: string): Promise<{
    post: SourcePost;
    articleHtml: string;
    fullPageHtml: string;
    warnings: string[];
    normalizedTitle: string;
  }> {
    const post = await this.source.getPost(slug);
    if (!post) {
      throw new Error(`[Pipeline] Post not found: ${slug}`);
    }

    const { title: normTitle } = normalizeWeChatTitle(post.title);
    const assetRoots = this.config.source.assetRoots || ['{postDir}'];

    // Collect image references via preprocessor and map local files to base64 data URIs
    const pre = preprocessMarkdown(post.bodyMarkdown, {
      siteUrl: this.config.site.url,
      postCanonicalUrl: post.canonicalUrl,
      shiftBodyHeadings: this.config.render.shiftBodyHeadings,
      imageCaptionMode: this.config.render.imageCaptionMode,
    });

    const imageMap = new Map<string, string>();
    for (const ref of pre.imageRefs) {
      const localPath = resolveLocalAssetPath(ref, post.postDir, assetRoots);
      if (localPath) {
        try {
          const fileBuf = fs.readFileSync(localPath);
          const mime = getMimeType(localPath);
          const dataUrl = `data:${mime};base64,${fileBuf.toString('base64')}`;
          imageMap.set(ref, dataUrl);
        } catch {
          // ignore
        }
      }
    }

    const renderRes = renderArticle(post.bodyMarkdown, {
      themeId: this.config.render.theme,
      accent: this.config.render.accent,
      fontSize: this.config.render.fontSize,
      fontFamily: this.config.render.fontFamily,
      macCode: this.config.render.macCode,
      galleryMode: this.config.render.galleryMode,
      linksToFootnotes: this.config.render.linksToFootnotes,
      imageMap,
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
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
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
      articleHtml: renderRes.html,
      fullPageHtml,
      warnings: renderRes.warnings.map((w) => w.detail),
      normalizedTitle: normTitle,
    };
  }

  /**
   * Pushes a single post to WeChat Draft Box.
   */
  public async push(slug: string, options: { force?: boolean } = {}): Promise<PushResult> {
    return await this.stateStore.withLock(async () => {
      return await this.pushInternal(slug, options);
    });
  }

  private async pushInternal(slug: string, options: { force?: boolean } = {}): Promise<PushResult> {
    const post = await this.source.getPost(slug);
    if (!post) {
      throw new Error(`[Pipeline] Post not found: ${slug}`);
    }

    const { title: finalTitle } = normalizeWeChatTitle(post.title);
    const finalDigest = normalizeWeChatDigest(post.summary);
    const assetRoots = this.config.source.assetRoots || ['{postDir}'];

    // 1. Preprocess once to collect image references and warnings
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

    // 2. Resolve and upload Cover image (thumb_media_id is required by WeChat)
    let coverLocalPath: string | null = null;

    if (post.coverRaw) {
      coverLocalPath = resolveLocalAssetPath(post.coverRaw, post.postDir, assetRoots);
    }

    // Fallback 1: First local body image
    if (!coverLocalPath && post.localAssetPaths.length > 0) {
      coverLocalPath = post.localAssetPaths[0];
    }

    // Fallback 2: Default configured cover
    if (!coverLocalPath && this.config.sync.defaultCover) {
      const defPath = path.resolve(this.config.sync.defaultCover);
      if (fs.existsSync(defPath)) {
        coverLocalPath = defPath;
      }
    }

    // Fallback 3: Auto-detect {repoRoot}/public/og/og.png from blog repository
    if (!coverLocalPath) {
      const repoRoot = findGitRoot(post.postDir);
      if (repoRoot) {
        const repoOg = path.join(repoRoot, 'public', 'og', 'og.png');
        if (fs.existsSync(repoOg)) {
          coverLocalPath = repoOg;
        }
      }
    }

    if (!coverLocalPath) {
      throw new Error(`[Pipeline] 文章 ${slug} 没有有效封面图片，且未找到可用兜底封面`);
    }

    const coverUpload = await this.imageProcessor.uploadCover(
      coverLocalPath,
      this.wechatClient,
      this.stateStore
    );

    // 3. Render final HTML with WeChat image URLs
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

    // 4. Update or Add to WeChat Draft Box
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
        // Draft was deleted or already published in WeChat backend -> fall back to add
        console.warn(`[Pipeline] 更新草稿失败 (${err.message})，降级为新建草稿...`);
        finalMediaId = await this.wechatClient.draft.add([articleInput]);
      }
    } else {
      finalMediaId = await this.wechatClient.draft.add([articleInput]);
    }

    // 5. Persist state
    this.stateStore.setPost(slug, {
      contentHash: post.contentHash,
      title: post.title,
      draftMediaId: finalMediaId,
      status: 'synced',
      pushedAt: new Date().toISOString(),
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
   * By default, only brand-new articles (!state) are pushed automatically.
   */
  public async sync(options: { includeUpdated?: boolean; forcePull?: boolean } = {}): Promise<SyncReport> {
    return await this.stateStore.withLock(async () => {
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

      // Select up to maxPerRun (newest pending posts), then push oldest-first so newest sits at top of draft box
      const toProcess = pendingPosts.slice(0, this.config.sync.maxPerRun).reverse();
      const skippedDueToLimit = Math.max(0, pendingPosts.length - toProcess.length);

      const pushed: PushResult[] = [];
      const failed: Array<{ id: string; error: string }> = [];

      for (const post of toProcess) {
        try {
          const res = await this.pushInternal(post.id);
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
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
