import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  HeyBoxArticleInput,
  HeyBoxClientOptions,
  HeyBoxPreparedResult,
  HeyBoxPublishResult,
  HeyBoxPublishOptions,
} from './types.js';
import { prepareHeyBoxArticle } from './transformer.js';
import {
  loginInteractively,
  hasSavedSession,
  publishDraftWithBrowser,
} from './browser-publisher.js';
import {
  HeyBoxApiClient,
  resolveHeyBoxSessionFile,
} from './api-client.js';

const execFileAsync = promisify(execFile);

/**
 * Filters prepared assets down to only those actually referenced by the rendered article body,
 * plus the optional 16:9 cover.
 *
 * Why this matters:
 * - `localAssetPaths` contains EVERY sibling image of a post bundle, including images that are
 *   never referenced from the markdown. Uploading them wastes COS quota and pollutes the media library.
 * - The cover is often cropped FROM one of those sibling images, so uploading both the cover and
 *   the unreferenced original would push the same picture twice.
 */
export function selectReferencedAssets(
  prepared: HeyBoxPreparedResult
): Array<{ filename: string; buffer: Buffer; mimetype: string }> {
  const body = prepared.richHtml || '';
  const md = prepared.markdown || '';

  const isReferenced = (filename: string, buffer: Buffer): boolean => {
    // 1) richHtml inlines images as Base64 data URLs, so match on a long unique prefix.
    const b64Prefix = `data:image/${
      filename.endsWith('.jpg') || filename.endsWith('.jpeg') ? 'jpeg' : 'png'
    };base64,${buffer.subarray(0, 96).toString('base64').slice(0, 64)}`;
    if (body.includes(b64Prefix)) return true;

    // 2) Fallback: match the plain / URI-encoded filename reference in transformed markdown.
    const base = path.basename(filename);
    const candidates = new Set([
      filename,
      base,
      encodeURIComponent(base),
      encodeURIComponent(filename),
    ]);
    for (const candidate of candidates) {
      if (body.includes(`src="${candidate}"`) || body.includes(`src='${candidate}'`)) return true;
      if (md.includes(`](${candidate})`) || md.includes(`](${candidate} `)) return true;
    }
    return false;
  };

  const result: Array<{ filename: string; buffer: Buffer; mimetype: string }> = [];
  for (const [filename, buffer] of prepared.assets.entries()) {
    const isCover = path.basename(filename) === 'cover_16_9.jpg';
    if (!isCover && !isReferenced(filename, buffer)) continue;
    result.push({
      filename,
      buffer,
      mimetype:
        filename.endsWith('.jpg') || filename.endsWith('.jpeg') ? 'image/jpeg' : 'image/png',
    });
  }
  return result;
}

export class HeyBoxClient {
  private readonly options: HeyBoxClientOptions;
  public readonly apiClient: HeyBoxApiClient;

  constructor(options: HeyBoxClientOptions = {}) {
    const assetRoots = options.assetRoots || options.source?.assetRoots || ['{postDir}'];
    const defaultCoverPath = options.defaultCoverPath || options.sync?.defaultCover;
    const sessionFile = resolveHeyBoxSessionFile(options.sessionFile);

    this.options = {
      cliPath: options.cliPath || 'xiaoheihe',
      outputDir: options.outputDir || path.resolve(process.cwd(), 'out', 'heybox'),
      sessionFile,
      browserChannel: options.browserChannel,
      headless: options.headless ?? true,
      browserTimeoutMs: options.browserTimeoutMs,
      assetRoots,
      defaultCoverPath,
      codeBlockMode: options.codeBlockMode || (options as any).heybox?.codeBlockMode,
      dryRun: Boolean(options.dryRun),
    };

    this.apiClient = new HeyBoxApiClient(sessionFile);
  }

  /**
   * Launches an interactive browser session to log in to XiaoHeiHe Creator Center
   * and saves the session credentials for subsequent automated publishing.
   */
  public async login(options?: { timeoutMs?: number }): Promise<string> {
    return await loginInteractively({
      sessionFile: this.options.sessionFile,
      browserChannel: this.options.browserChannel,
      timeoutMs: options?.timeoutMs,
    });
  }

  /**
   * Checks whether a saved login session exists on disk.
   */
  public hasSession(): boolean {
    return this.apiClient.hasSession() || hasSavedSession(this.options.sessionFile);
  }

  /**
   * Generates a complete XiaoHeiHe publishing bundle folder on disk.
   */
  public async exportPackage(
    article: HeyBoxArticleInput,
    outDir?: string
  ): Promise<{ bundleDir: string; prepared: HeyBoxPreparedResult }> {
    const targetDir = outDir
      ? path.resolve(outDir)
      : path.resolve(
          this.options.outputDir || path.resolve(process.cwd(), 'out', 'heybox'),
          article.id
        );

    fs.mkdirSync(targetDir, { recursive: true });

    const prepared = await prepareHeyBoxArticle(article, {
      assetRoots: this.options.assetRoots,
      defaultCoverPath: this.options.defaultCoverPath,
      codeBlockMode: this.options.codeBlockMode,
    });

    // 1. Write transformed Markdown
    fs.writeFileSync(path.join(targetDir, 'article.md'), prepared.markdown, 'utf8');

    // 2. Write rich-text HTML (for direct clipboard / editor paste)
    fs.writeFileSync(path.join(targetDir, 'article.rich.html'), prepared.richHtml, 'utf8');

    // 3. Write preview HTML
    fs.writeFileSync(path.join(targetDir, 'preview.html'), prepared.previewHtml, 'utf8');

    // 4. Write metadata.json
    fs.writeFileSync(
      path.join(targetDir, 'metadata.json'),
      JSON.stringify(
        {
          title: prepared.title,
          slug: article.id,
          canonicalUrl: article.canonicalUrl,
          ...prepared.metadata,
        },
        null,
        2
      ),
      'utf8'
    );

    // 5. Write all assets (code block PNGs, 16:9 cover, local photos)
    for (const [relPath, buf] of prepared.assets.entries()) {
      const fullAssetPath = path.join(targetDir, relPath);
      fs.mkdirSync(path.dirname(fullAssetPath), { recursive: true });
      fs.writeFileSync(fullAssetPath, buf);
    }

    return { bundleDir: targetDir, prepared };
  }

  /**
   * Checks if `xiaoheihe` CLI tool is available in the current environment PATH.
   */
  public async isCliAvailable(): Promise<boolean> {
    const cli = this.options.cliPath || 'xiaoheihe';
    try {
      await execFileAsync(cli, ['--version'], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Publishes or saves draft to XiaoHeiHe (HeyBox).
   * 1. If dry-run: returns dry-run summary.
   * 2. Pure TypeScript Native API direct push (Primary method: 0 external dependencies!).
   * 3. Fallback to external `xiaoheihe` CLI if installed.
   * 4. Fallback to Playwright browser automation.
   * 5. Fallback to local package generation with guidance.
   */
  public async publishDraft(
    article: HeyBoxArticleInput,
    options: HeyBoxPublishOptions = {}
  ): Promise<HeyBoxPublishResult> {
    const { bundleDir, prepared } = await this.exportPackage(article, options.outDir);
    const codeImagesCount = Array.from(prepared.assets.keys()).filter((k) =>
      k.startsWith('assets/code_')
    ).length;

    const isDryRun = options.dryRun ?? this.options.dryRun ?? false;

    if (isDryRun) {
      return {
        slug: article.id,
        title: prepared.title,
        bundleDir,
        hasCover: Boolean(prepared.coverBuffer),
        codeImagesCount,
        publishedViaCli: false,
        message: `[演练完成] 小黑盒发布包已生成至: ${bundleDir}`,
      };
    }

    // 1. Primary: Pure TypeScript Native API push (Zero Python, Zero external CLI)
    if (this.apiClient.hasSession()) {
      try {
        const imageList = selectReferencedAssets(prepared);
        const skipped = prepared.assets.size - imageList.length;
        console.log(
          `[HeyBox] 正在通过原生 API 直接提交草稿箱 (上传 ${imageList.length} 项素材` +
            (skipped > 0 ? `，已跳过 ${skipped} 项未引用素材` : '') +
            ') ...'
        );

        const draftRes = await this.apiClient.createArticleDraft({
          title: prepared.title,
          markdown: prepared.markdown,
          richHtml: prepared.richHtml,
          images: imageList,
          communities: prepared.metadata.community ? [prepared.metadata.community] : [],
          hashtags: prepared.metadata.hashtags || [],
        });

        return {
          slug: article.id,
          title: prepared.title,
          bundleDir,
          hasCover: Boolean(prepared.coverBuffer),
          codeImagesCount,
          publishedViaCli: false,
          publishedViaBrowser: false,
          draftId: draftRes.draftId,
          draftUrl: draftRes.shareUrl,
          message: `草稿已成功通过纯 TS 原生 API 推入小黑盒草稿箱！(草稿ID: ${draftRes.draftId})`,
        };
      } catch (err: any) {
        console.warn(`[HeyBox] 原生 API 推送提示 (${err.message})，尝试降级通道...`);
      }
    }

    // 2. Fallback: External xiaoheihe CLI if installed
    const cliAvailable = await this.isCliAvailable();
    if (cliAvailable) {
      try {
        const coverPath = path.join(bundleDir, 'cover_16_9.jpg');
        const cli = this.options.cliPath || 'xiaoheihe';

        const cliArgs = [
          'post',
          'create',
          '--kind',
          prepared.metadata.kind || 'article',
          '--title',
          prepared.title,
          '--file',
          'article.md',
        ];

        if (fs.existsSync(coverPath)) {
          cliArgs.push('--image', 'cover_16_9.jpg');
        }
        if (prepared.metadata.community && prepared.metadata.community.trim()) {
          cliArgs.push('--community', prepared.metadata.community.trim());
        }
        if (Array.isArray(prepared.metadata.hashtags)) {
          for (const h of prepared.metadata.hashtags) {
            if (h && String(h).trim()) {
              cliArgs.push('--hashtag', String(h).trim());
            }
          }
        }

        console.log(`[HeyBox] 正在调用 ${cli} CLI 自动提交草稿（含多张图片上传，请稍候）...`);
        const { stdout } = await execFileAsync(cli, cliArgs, {
          cwd: bundleDir,
          timeout: 180_000,
          maxBuffer: 10 * 1024 * 1024,
        });

        let draftId: string | undefined;
        let draftUrl: string | undefined;
        try {
          const parsedRes = JSON.parse(stdout);
          draftId = parsedRes?.data?.link_id ? String(parsedRes.data.link_id) : undefined;
          draftUrl = parsedRes?.data?.readback?.result?.link?.share_url;
        } catch {}

        const message = draftId
          ? `草稿已成功自动推入小黑盒草稿箱！(草稿ID: ${draftId})`
          : stdout.trim() || '草稿已成功提交至小黑盒草稿箱！';

        return {
          slug: article.id,
          title: prepared.title,
          bundleDir,
          hasCover: Boolean(prepared.coverBuffer),
          codeImagesCount,
          publishedViaCli: true,
          draftId,
          draftUrl,
          message,
        };
      } catch (err: any) {
        console.warn(`[HeyBox] CLI 提交异常 (${err.message})，尝试浏览器无头通道...`);
      }
    }

    // 3. Fallback: Playwright Headless Browser Automation
    if (!options.skipBrowser && hasSavedSession(this.options.sessionFile)) {
      try {
        const browserRes = await publishDraftWithBrowser(prepared, {
          sessionFile: this.options.sessionFile,
          browserChannel: this.options.browserChannel,
          headless: options.headless ?? this.options.headless ?? true,
          timeoutMs: this.options.browserTimeoutMs,
        });

        return {
          slug: article.id,
          title: prepared.title,
          bundleDir,
          hasCover: Boolean(prepared.coverBuffer),
          codeImagesCount,
          publishedViaCli: false,
          publishedViaBrowser: true,
          draftId: browserRes.draftId,
          draftUrl: browserRes.draftUrl,
          message: browserRes.message,
        };
      } catch (err: any) {
        console.warn(`[HeyBox] 浏览器自动推流提示 (${err.message})，降级为本地发布包。`);
      }
    }

    const tip = this.hasSession()
      ? '小黑盒专属发布包已生成！双击 preview.html 即可一键复制富文本粘贴。'
      : '小黑盒发布包已就位！可运行 `pnpm cli login --to heybox` 扫码或配置 sessionFile 开启全自动无人值守推流。';

    return {
      slug: article.id,
      title: prepared.title,
      bundleDir,
      hasCover: Boolean(prepared.coverBuffer),
      codeImagesCount,
      publishedViaCli: false,
      message: tip,
    };
  }
}
