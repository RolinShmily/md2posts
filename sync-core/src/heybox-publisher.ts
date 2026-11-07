import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SourcePost } from '@md2posts/sources';
import { prepareHeyBoxArticle, HeyBoxPreparedResult } from './heybox.js';
import type { AppConfig } from './config.js';

const execFileAsync = promisify(execFile);

export interface HeyBoxPublishResult {
  slug: string;
  title: string;
  bundleDir: string;
  hasCover: boolean;
  codeImagesCount: number;
  publishedViaCli: boolean;
  message: string;
}

export class HeyBoxPublisher {
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  /**
   * Generates a complete XiaoHeiHe publishing bundle folder on disk.
   */
  public async exportPackage(
    post: SourcePost,
    outDir?: string
  ): Promise<{ bundleDir: string; prepared: HeyBoxPreparedResult }> {
    const targetDir = outDir
      ? path.resolve(outDir)
      : path.resolve(process.cwd(), 'out', 'heybox', post.id);

    fs.mkdirSync(targetDir, { recursive: true });

    const prepared = await prepareHeyBoxArticle(post, {
      assetRoots: this.config.source.assetRoots,
      defaultCoverPath: this.config.sync.defaultCover,
    });

    // 1. Write transformed Markdown
    fs.writeFileSync(path.join(targetDir, 'article.md'), prepared.markdown, 'utf8');

    // 2. Write preview HTML
    fs.writeFileSync(path.join(targetDir, 'preview.html'), prepared.previewHtml, 'utf8');

    // 3. Write metadata.json
    fs.writeFileSync(
      path.join(targetDir, 'metadata.json'),
      JSON.stringify(
        {
          title: prepared.title,
          slug: post.id,
          canonicalUrl: post.canonicalUrl,
          ...prepared.metadata,
        },
        null,
        2
      ),
      'utf8'
    );

    // 4. Write all assets (code block PNGs, 16:9 cover, local photos)
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
    try {
      await execFileAsync('xiaoheihe', ['--version'], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Publishes or saves draft to XiaoHeiHe (HeyBox).
   * If `xiaoheihe` CLI is installed, automatically invokes `xiaoheihe post create --draft`.
   * Otherwise, generates the complete package on disk and provides straightforward instructions.
   */
  public async publishDraft(
    post: SourcePost,
    options: { dryRun?: boolean; outDir?: string } = {}
  ): Promise<HeyBoxPublishResult> {
    const { bundleDir, prepared } = await this.exportPackage(post, options.outDir);
    const codeImagesCount = Array.from(prepared.assets.keys()).filter((k) =>
      k.startsWith('assets/code_')
    ).length;

    if (options.dryRun) {
      return {
        slug: post.id,
        title: prepared.title,
        bundleDir,
        hasCover: Boolean(prepared.coverBuffer),
        codeImagesCount,
        publishedViaCli: false,
        message: `[演练完成] 小黑盒发布包已生成至: ${bundleDir}`,
      };
    }

    const cliAvailable = await this.isCliAvailable();
    if (cliAvailable) {
      try {
        const articleMdPath = path.join(bundleDir, 'article.md');
        const coverPath = path.join(bundleDir, 'cover_16_9.jpg');

        const cliArgs = [
          'post',
          'create',
          '--kind',
          prepared.metadata.kind || 'article',
          '--title',
          prepared.title,
          '--file',
          articleMdPath,
          '--draft',
        ];

        if (fs.existsSync(coverPath)) {
          cliArgs.push('--image', coverPath);
        }
        if (prepared.metadata.community) {
          cliArgs.push('--community', prepared.metadata.community);
        }

        console.log(`[HeyBox] 正在调用 xiaoheihe CLI 自动提交草稿...`);
        const { stdout } = await execFileAsync('xiaoheihe', cliArgs, {
          cwd: bundleDir,
          timeout: 45_000,
        });

        return {
          slug: post.id,
          title: prepared.title,
          bundleDir,
          hasCover: Boolean(prepared.coverBuffer),
          codeImagesCount,
          publishedViaCli: true,
          message: stdout.trim() || '草稿已成功提交至小黑盒草稿箱！',
        };
      } catch (err: any) {
        console.warn(`[HeyBox] xiaoheihe CLI 提交异常 (${err.message})，使用本地发布包。`);
      }
    }

    return {
      slug: post.id,
      title: prepared.title,
      bundleDir,
      hasCover: Boolean(prepared.coverBuffer),
      codeImagesCount,
      publishedViaCli: false,
      message: `小黑盒专属发布包已生成完成！可直接使用包内 article.md 粘贴到小黑盒网页发帖后台。`,
    };
  }
}
