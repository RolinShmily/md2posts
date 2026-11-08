import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  renderCodeBlockToImage,
  crop16x9Cover,
  inferHeyBoxMetadata,
  prepareHeyBoxArticle,
  HeyBoxClient,
  HeyBoxPublisher,
  type HeyBoxArticleInput,
} from '../src/index.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

test('renderCodeBlockToImage generates a valid PNG buffer with header and code lines', async () => {
  const code = 'Get-Process | Where-Object { $_.CPU -gt 10 }\nWrite-Host "Done"';
  const pngBuf = await renderCodeBlockToImage(code, 'pwsh');
  assert.ok(pngBuf.length > 500, 'PNG buffer should be generated');

  // Check PNG signature: 89 50 4E 47
  assert.equal(pngBuf[0], 0x89);
  assert.equal(pngBuf[1], 0x50);
  assert.equal(pngBuf[2], 0x4e);
  assert.equal(pngBuf[3], 0x47);
});

test('crop16x9Cover crops an image into a 16:9 ratio JPEG buffer', async () => {
  const cropped = await crop16x9Cover(PNG_1X1);
  assert.ok(cropped.length > 100);

  // Check JPEG signature: FF D8 FF
  assert.equal(cropped[0], 0xff);
  assert.equal(cropped[1], 0xd8);
  assert.equal(cropped[2], 0xff);
});

test('inferHeyBoxMetadata defaults to clean unselected draft mode and respects custom frontmatter', () => {
  // 1. Default fallback: no community or hashtags forced, safe for draft creation
  const defaultMeta = inferHeyBoxMetadata({ tags: ['CS2', 'FPS'] }, 'CS2 Autoexec 详解');
  assert.equal(defaultMeta.community, '');
  assert.equal(defaultMeta.gameId, undefined);
  assert.deepEqual(defaultMeta.hashtags, []);

  // 2. Custom frontmatter explicitly specified
  const customMeta = inferHeyBoxMetadata(
    {
      tags: ['Other'],
      heybox: {
        community: '自定义专区',
        game_id: 1234,
        tags: ['专区标签1', '专区标签2'],
      },
    },
    '随便什么标题'
  );
  assert.equal(customMeta.community, '自定义专区');
  assert.equal(customMeta.gameId, 1234);
  assert.deepEqual(customMeta.hashtags, ['专区标签1', '专区标签2']);
});

test('prepareHeyBoxArticle and HeyBoxClient export complete bundle with code images', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2posts-heybox-test-'));
  const postDir = path.join(tmpDir, 'cs2-guide');
  fs.mkdirSync(postDir);

  const coverPath = path.join(postDir, 'cover.png');
  fs.writeFileSync(coverPath, PNG_1X1);

  const mockArticle: HeyBoxArticleInput = {
    id: 'cs2-guide',
    postDir,
    bodyMarkdown: `# 第一节\n\n正文介绍。\n\n\`\`\`pwsh\nGet-Process -Name "cs2"\n\`\`\`\n\n正文后续。`,
    frontmatter: { tags: ['CS2'] },
    title: 'CS2 优化指南 | 设置 | 教程',
    coverRaw: './cover.png',
    canonicalUrl: 'https://blog.example.com/posts/cs2-guide/',
    localAssetPaths: [coverPath],
  };

  try {
    const client = new HeyBoxClient({
      assetRoots: ['{postDir}'],
    });

    const outDir = path.join(tmpDir, 'heybox-out');
    const { bundleDir, prepared } = await client.exportPackage(mockArticle, outDir);

    assert.equal(bundleDir, outDir);
    assert.ok(fs.existsSync(path.join(outDir, 'article.md')));
    assert.ok(fs.existsSync(path.join(outDir, 'article.rich.html')));
    assert.ok(fs.existsSync(path.join(outDir, 'cover_16_9.jpg')));
    assert.ok(fs.existsSync(path.join(outDir, 'metadata.json')));
    assert.ok(fs.existsSync(path.join(outDir, 'preview.html')));

    // Check richHtml contains normalized H2 and inlined code block Base64 image
    assert.match(prepared.richHtml, /<h2/);
    assert.match(prepared.richHtml, /data:image\/png;base64/);

    // Check preview.html contains copyRichText logic
    assert.match(prepared.previewHtml, /copyRichText/);

    // Check transformed article.md has replaced code block with image tag
    const articleContent = fs.readFileSync(path.join(outDir, 'article.md'), 'utf8');
    assert.match(articleContent, /!\[代码块 - pwsh\]\((?:\.\/)?assets\/code_1_pwsh\.png\)/);
    assert.match(articleContent, /小黑盒专栏/);

    // Check code image file was actually written to assets/
    assert.ok(fs.existsSync(path.join(outDir, 'assets', 'code_1_pwsh.png')));

    // Dry-run publish
    const publishRes = await client.publishDraft(mockArticle, { dryRun: true, outDir });
    assert.equal(publishRes.slug, 'cs2-guide');
    assert.equal(publishRes.hasCover, true);
    assert.equal(publishRes.codeImagesCount, 1);
    assert.equal(publishRes.publishedViaCli, false);
    assert.match(publishRes.message, /\[演练完成\]/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
