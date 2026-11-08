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
import { HeyBoxError } from './errors.js';

const execFileAsync = promisify(execFile);

export class HeyBoxClient {
  private readonly options: HeyBoxClientOptions;

  constructor(options: HeyBoxClientOptions = {}) {
    const assetRoots = options.assetRoots || options.source?.assetRoots || ['{postDir}'];
    const defaultCoverPath = options.defaultCoverPath || options.sync?.defaultCover;

    this.options = {
      cliPath: options.cliPath || 'xiaoheihe',
      outputDir: options.outputDir || path.resolve(process.cwd(), 'out', 'heybox'),
      sessionFile:
        options.sessionFile || path.resolve(process.cwd(), '.cache', 'heybox-session.json'),
      browserChannel: options.browserChannel,
      headless: options.headless ?? true,
      browserTimeoutMs: options.browserTimeoutMs,
      assetRoots,
      defaultCoverPath,
      dryRun: Boolean(options.dryRun),
    };
  }

  /**
   * Launches an interactive browser session to log in to XiaoHeiHe Creator Center
   * and saves the session credentials for subsequent automated headless publishing.
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
    return hasSavedSession(this.options.sessionFile);
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
   * 2. If browser session exists and skipBrowser is not set: runs Playwright headless automation to push directly.
   * 3. If external `xiaoheihe` CLI is installed, invokes it.
   * 4. Otherwise, generates complete package on disk with friendly instructions.
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

    // 1. Try Playwright Headless Automation (Primary automated SOP)
    if (!options.skipBrowser && this.hasSession()) {
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

    // 2. Try External CLI if installed
    const cliAvailable = await this.isCliAvailable();
    if (cliAvailable) {
      try {
        const articleMdPath = path.join(bundleDir, 'article.md');
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
        if (prepared.metadata.community) {
          cliArgs.push('--community', prepared.metadata.community);
        }
        if (Array.isArray(prepared.metadata.hashtags)) {
          for (const h of prepared.metadata.hashtags) {
            cliArgs.push('--hashtag', h);
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
          : (stdout.trim() || '草稿已成功提交至小黑盒草稿箱！');

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
        console.warn(`[HeyBox] CLI 提交异常 (${err.message})，使用本地发布包。`);
      }
    }

    const tip = this.hasSession()
      ? '小黑盒专属发布包已生成！双击 preview.html 即可一键复制富文本粘贴。'
      : '小黑盒发布包已就位！可运行 `md2posts heybox-login` 开启全自动无人值守推流。';

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

/**
 * Backward compatibility alias for HeyBoxClient
 */
export const HeyBoxPublisher = HeyBoxClient;
