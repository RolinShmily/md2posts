import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import {
  normalizeWeChatTitle,
  normalizeWeChatDigest,
  parseArticleSelection,
  StateStore,
  SyncPipeline,
  ImageProcessor,
  loadConfig,
} from '../src/index.js';
import { WeChatClient, MemoryTokenStore } from '@md2posts/wechat-sdk';

test('normalizeWeChatTitle strips suffix tags right-to-left and truncates when needed', () => {
  const res1 = normalizeWeChatTitle('短标题');
  assert.equal(res1.title, '短标题');
  assert.equal(res1.truncated, false);

  // Multi-tag title where keeping first two segments fits within 32 chars
  const multiTag = '静态网页的文章管理后端！| Decap-CMS | GitHub-OAuth';
  const res2 = normalizeWeChatTitle(multiTag);
  assert.equal(res2.title, '静态网页的文章管理后端！ | Decap-CMS');
  assert.equal(res2.truncated, true);
  assert.ok([...res2.title].length <= 32);

  // Multi-tag title where only first segment fits
  const realPostTitle = '使用MacMini搭建Minecraft服务器 | MCSmanger面板 | SakuraFRP樱花映射';
  const res3 = normalizeWeChatTitle(realPostTitle);
  assert.equal(res3.title, '使用MacMini搭建Minecraft服务器');
  assert.equal(res3.truncated, true);
  assert.ok([...res3.title].length <= 32);

  // Long title without delimiter
  const longTitle = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五';
  const res4 = normalizeWeChatTitle(longTitle);
  assert.ok([...res4.title].length <= 32);
  assert.ok(res4.title.endsWith('…'));
});

test('normalizeWeChatDigest truncates over 120 chars', () => {
  const shortDigest = '简短摘要';
  assert.equal(normalizeWeChatDigest(shortDigest), '简短摘要');

  const longDigest = 'a'.repeat(150);
  const normalized = normalizeWeChatDigest(longDigest);
  assert.ok(normalized);
  assert.ok([...normalized!].length <= 120);
  assert.ok(normalized!.endsWith('…'));
});

test('parseArticleSelection supports single numbers, comma lists, ranges, keywords, and slugs', () => {
  const items = [
    { id: '61-new', status: 'new' as const },
    { id: '60-new', status: 'new' as const },
    { id: '45-updated', status: 'updated' as const },
    { id: '30-baselined', status: 'baselined' as const },
  ];

  assert.deepEqual(parseArticleSelection('1, 3', items), ['61-new', '45-updated']);
  assert.deepEqual(parseArticleSelection('2-4', items), ['60-new', '45-updated', '30-baselined']);
  assert.deepEqual(parseArticleSelection('new', items), ['61-new', '60-new']);
  assert.deepEqual(parseArticleSelection('updated', items), ['45-updated']);
  assert.deepEqual(parseArticleSelection('30-baselined, 1', items), ['30-baselined', '61-new']);
  assert.deepEqual(parseArticleSelection('q', items), []);
});

test('ImageProcessor converts WebP to PNG/JPEG and keeps output under maxByteSize', async () => {
  const processor = new ImageProcessor({ maxByteSize: 900 * 1024 });
  const webpBuf = await sharp({
    create: {
      width: 400,
      height: 300,
      channels: 4,
      background: { r: 14, g: 136, b: 235, alpha: 1 },
    },
  })
    .webp()
    .toBuffer();

  const processed = await processor.processImage(webpBuf, 'sample.webp');
  assert.ok(processed.format === 'png' || processed.format === 'jpeg');
  assert.ok(processed.filename.endsWith('.png') || processed.filename.endsWith('.jpg'));
  assert.ok(processed.byteLength <= 900 * 1024);
});

test('StateStore persists and reads post, image, and cover entries', () => {
  const tmpFile = path.join(os.tmpdir(), `md2posts-state-test-${Date.now()}.json`);
  try {
    const store = new StateStore(tmpFile);
    assert.deepEqual(store.getAllPosts(), {});

    store.markBaseline([
      { id: 'post-1', title: 'Post 1', contentHash: 'hash1' },
      { id: 'post-2', title: 'Post 2', contentHash: 'hash2' },
    ]);

    const post1 = store.getPost('post-1');
    assert.equal(post1?.status, 'baselined');
    assert.equal(post1?.contentHash, 'hash1');

    store.setImage('img-sha', { wechatUrl: 'https://mmbiz.qpic.cn/1', uploadedAt: 'now' });
    assert.equal(store.getImage('img-sha')?.wechatUrl, 'https://mmbiz.qpic.cn/1');

    store.save();

    const reloaded = new StateStore(tmpFile);
    assert.equal(reloaded.getPost('post-1')?.status, 'baselined');
    assert.equal(reloaded.getImage('img-sha')?.wechatUrl, 'https://mmbiz.qpic.cn/1');
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
});

test('SyncPipeline check(), preview(), and push() run cleanly with image cache', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2posts-pipeline-test-'));
  const tmpState = path.join(tmpDir, 'state.json');

  try {
    const postDir = path.join(tmpDir, 'demo-post');
    fs.mkdirSync(postDir);
    fs.writeFileSync(
      path.join(postDir, 'index.md'),
      `---
title: "测试标题演示"
published: 2026-03-01
description: 摘要
image: ./cover.png
draft: false
---
# 标题一

正文内容与图片：

![示意图](./cover.png)
`
    );
    const png1x1 = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    );
    fs.writeFileSync(path.join(postDir, 'cover.png'), png1x1);

    const config = loadConfig();
    config.source.postsRoot = tmpDir;
    config.source.gitPull = false;
    config.source.assetRoots = ['{postDir}'];
    config.sync.stateFile = tmpState;
    config.sync.defaultCover = path.join(postDir, 'cover.png');

    const dryRunClient = new WeChatClient({
      appId: 'wx1234567890abcdef',
      appSecret: 'test_secret',
      dryRun: true,
      tokenStore: new MemoryTokenStore(),
    });

    const pipeline = new SyncPipeline(config, dryRunClient);

    // 1. Check report
    const checkReport = await pipeline.check();
    assert.equal(checkReport.total, 1);
    assert.equal(checkReport.newCount, 1);
    assert.equal(checkReport.items[0].id, 'demo-post');

    // 2. Preview post
    const previewRes = await pipeline.preview('demo-post');
    assert.equal(previewRes.post.id, 'demo-post');
    assert.match(previewRes.articleHtml, /<h2[^>]*>标题一<\/h2>/);
    assert.match(previewRes.articleHtml, /src="data:image\/png;base64,/);
    assert.match(previewRes.fullPageHtml, /微信排版预览/);
    assert.match(previewRes.fullPageHtml, /一键复制富文本/);

    // 3. Push post (with dryRun client)
    const pushRes = await pipeline.push('demo-post');
    assert.equal(pushRes.id, 'demo-post');
    assert.equal(pushRes.isUpdate, false);
    assert.ok(pushRes.mediaId.startsWith('dry-run-draft-'));

    // 4. Second push updates existing draft
    const pushRes2 = await pipeline.push('demo-post');
    assert.equal(pushRes2.isUpdate, true);
    assert.equal(pushRes2.mediaId, pushRes.mediaId);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('preflight blocks runs with missing/placeholder credentials and allows dry runs', async () => {
  const { checkWeChatCredentials, checkHeyBoxSession } = await import('../src/preflight.js');

  const empty = checkWeChatCredentials('', false);
  assert.equal(empty.ready, false);
  assert.ok(empty.errors.some((e) => e.includes('AppID')));
  assert.ok(empty.errors.some((e) => e.includes('AppSecret')));

  const placeholder = checkWeChatCredentials('your-appid', true);
  assert.equal(placeholder.ready, false);
  assert.ok(placeholder.errors[0].includes('占位值'));

  const valid = checkWeChatCredentials('wx1234567890abcdef', true);
  assert.equal(valid.ready, true);
  assert.equal(valid.errors.length, 0);

  const oddAppId = checkWeChatCredentials('1234567890', true);
  assert.equal(oddAppId.ready, true, 'malformed appId must only warn, not block');
  assert.equal(oddAppId.warnings.length, 1);

  const noSession = checkHeyBoxSession(false, '/tmp/none.json');
  assert.equal(noSession.ready, false);
  assert.ok(noSession.errors[0].includes('/tmp/none.json'));

  assert.equal(checkHeyBoxSession(true).ready, true);

  // Real runs must abort before scanning; dry runs must never be blocked.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2posts-preflight-'));
  try {
    const cfg = loadConfig();
    cfg.source.postsRoot = tmpDir;
    cfg.source.gitPull = false;
    cfg.sync.stateFile = path.join(tmpDir, 'state.json');
    cfg.wechat = { appId: '', appSecret: '' };

    const realPipeline = new SyncPipeline(cfg, new WeChatClient({ appId: '', appSecret: '' }));
    await assert.rejects(
      () => realPipeline.sync({ to: 'wechat' }),
      /凭据未就绪/,
      'missing credentials must abort the run before pushing anything'
    );

    const dryPipeline = new SyncPipeline(
      cfg,
      new WeChatClient({ appId: '', appSecret: '', dryRun: true })
    );
    const dryReport = await dryPipeline.sync({ to: 'wechat', dryRun: true });
    assert.equal(dryReport.scanned, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolveTargets isolates platforms: a missing credential never blocks the other', async () => {
  const { resolveTargets } = await import('../src/preflight.js');
  const ok = { ready: true, errors: [], warnings: [] };
  const bad = { ready: false, errors: ['no session'], warnings: [] };

  // --to all, HeyBox session missing -> WeChat still runs
  const allWechatOnly = resolveTargets('all', { wechat: ok, heybox: bad });
  assert.equal(allWechatOnly.blocked, false);
  assert.equal(allWechatOnly.effective, 'wechat');
  assert.deepEqual(allWechatOnly.skipped.map((s) => s.target), ['heybox']);

  // --to all, WeChat creds missing -> HeyBox still runs
  const allHeyboxOnly = resolveTargets('all', { wechat: bad, heybox: ok });
  assert.equal(allHeyboxOnly.effective, 'heybox');
  assert.deepEqual(allHeyboxOnly.skipped.map((s) => s.target), ['wechat']);

  // --to all, both ready -> both run
  const bothReady = resolveTargets('all', { wechat: ok, heybox: ok });
  assert.equal(bothReady.effective, 'all');
  assert.equal(bothReady.skipped.length, 0);

  // --to all, both unusable -> blocked
  const noneReady = resolveTargets('all', { wechat: bad, heybox: bad });
  assert.equal(noneReady.blocked, true);

  // Single target still blocks when that target is unusable
  assert.equal(resolveTargets('wechat', { wechat: bad, heybox: ok }).blocked, true);

  // Single target is unaffected by the other platform being unusable
  const single = resolveTargets('wechat', { wechat: ok, heybox: bad });
  assert.equal(single.blocked, false);
  assert.equal(single.effective, 'wechat');
  assert.equal(single.skipped.length, 0);
});

test('pipeline keeps WeChat working when HeyBox session is unavailable', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2posts-isolate-'));
  try {
    const cfg = loadConfig();
    cfg.source.postsRoot = tmpDir;
    cfg.source.gitPull = false;
    cfg.sync.stateFile = path.join(tmpDir, 'state.json');
    cfg.wechat = { appId: 'wx1234567890abcdef', appSecret: 'test_secret' };
    cfg.heybox = { sessionFile: path.join(tmpDir, 'no-such-session.json') };

    // NOTE: a real (non-dry) client, so preflight actually evaluates WeChat.
    const pipeline = new SyncPipeline(
      cfg,
      new WeChatClient({
        appId: 'wx1234567890abcdef',
        appSecret: 'test_secret',
      })
    );

    // HeyBox is unusable here (no session file). A `--to all` run must NOT throw,
    // because WeChat is ready — it degrades to WeChat only.
    const report = await pipeline.sync({ to: 'all' });
    assert.equal(report.failed.length, 0);
    assert.equal(report.scanned, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
