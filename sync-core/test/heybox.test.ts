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
  HeyBoxPublisher,
  loadConfig,
} from '../src/index.js';
import type { SourcePost } from '@md2posts/sources';

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

test('inferHeyBoxMetadata correctly maps gaming topics and respects custom frontmatter', () => {
  // 1. Inferred from CS2 title/tags
  const cs2Meta = inferHeyBoxMetadata({ tags: ['CS2', 'FPS'] }, 'CS2 Autoexec 详解');
  assert.equal(cs2Meta.community, 'Counter-Strike 2');
  assert.equal(cs2Meta.gameId, 730);
  assert.ok(cs2Meta.hashtags.includes('CS2'));

  // 2. Inferred from Switch tags
  const switchMeta = inferHeyBoxMetadata({ tags: ['Switch', 'AMS'] }, 'Nintendo Switch 更新指南');
  assert.equal(switchMeta.community, '任天堂Switch');

  // 3. Custom frontmatter overrides inference
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

test('prepareHeyBoxArticle and HeyBoxPublisher export complete bundle with code images', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2posts-heybox-test-'));
  const postDir = path.join(tmpDir, 'cs2-guide');
  fs.mkdirSync(postDir);

  const coverPath = path.join(postDir, 'cover.png');
  fs.writeFileSync(coverPath, PNG_1X1);

  const mockPost: SourcePost = {
    id: 'cs2-guide',
    filePath: path.join(postDir, 'index.md'),
    postDir,
    rawMarkdown: '',
    bodyMarkdown: `# 第一节\n\n正文介绍。\n\n\`\`\`pwsh\nGet-Process -Name "cs2"\n\`\`\`\n\n正文后续。`,
    contentHash: 'mock-hash',
    frontmatter: { tags: ['CS2'] },
    title: 'CS2 优化指南 | 设置 | 教程',
    summary: '这是摘要',
    coverRaw: './cover.png',
    canonicalUrl: 'https://blog.example.com/posts/cs2-guide/',
    localAssetPaths: [coverPath],
    draft: false,
  };

  try {
    const config = loadConfig();
    config.source.gitPull = false;
    const publisher = new HeyBoxPublisher(config);

    const outDir = path.join(tmpDir, 'heybox-out');
    const { bundleDir, prepared } = await publisher.exportPackage(mockPost, outDir);

    assert.equal(bundleDir, outDir);
    assert.ok(fs.existsSync(path.join(outDir, 'article.md')));
    assert.ok(fs.existsSync(path.join(outDir, 'cover_16_9.jpg')));
    assert.ok(fs.existsSync(path.join(outDir, 'metadata.json')));
    assert.ok(fs.existsSync(path.join(outDir, 'preview.html')));

    // Check transformed article.md has replaced code block with image tag
    const articleContent = fs.readFileSync(path.join(outDir, 'article.md'), 'utf8');
    assert.match(articleContent, /!\[代码块 - pwsh\]\(\.\/assets\/code_1_pwsh\.png\)/);
    assert.match(articleContent, /小黑盒专栏/);

    // Check code image file was actually written to assets/
    assert.ok(fs.existsSync(path.join(outDir, 'assets', 'code_1_pwsh.png')));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
