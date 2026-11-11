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

test('config.yaml wins over environment variables for credentials and webhook', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2posts-envperf-'));
  const cfgPath = path.join(tmpDir, 'config.yaml');
  fs.writeFileSync(
    cfgPath,
    [
      'source:',
      '  type: fs',
      '  gitPull: false',
      'wechat:',
      '  appId: "wx1111111111111111"',
      '  appSecret: "config-secret-value"',
      'notify:',
      '  webhookUrl: "https://example.com/from-config"',
      '',
    ].join('\n')
  );

  const saved = {
    appId: process.env.WECHAT_APPID,
    secret: process.env.WECHAT_SECRET,
    hook: process.env.MD2POSTS_WEBHOOK_URL,
  };
  process.env.WECHAT_APPID = 'wx9999999999999999';
  process.env.WECHAT_SECRET = 'env-secret-value';
  process.env.MD2POSTS_WEBHOOK_URL = 'https://example.com/from-env';

  try {
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.wechat.appId, 'wx1111111111111111', 'config.yaml AppID must win');
    assert.equal(cfg.wechat.appSecret, 'config-secret-value', 'config.yaml secret must win');
    assert.equal(cfg.notify?.webhookUrl, 'https://example.com/from-config');

    // Empty config value falls back to the environment.
    fs.writeFileSync(
      cfgPath,
      ['source:', '  type: fs', 'wechat:', '  appId: ""', '  appSecret: ""', ''].join('\n')
    );
    const fallback = loadConfig(cfgPath);
    assert.equal(fallback.wechat.appId, 'wx9999999999999999');
    assert.equal(fallback.wechat.appSecret, 'env-secret-value');
  } finally {
    const restore = (key: string, value?: string) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('WECHAT_APPID', saved.appId);
    restore('WECHAT_SECRET', saved.secret);
    restore('MD2POSTS_WEBHOOK_URL', saved.hook);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sync refuses to push when this machine has no baseline', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2posts-baseline-guard-'));
  const postDir = path.join(tmpDir, 'post-a');
  fs.mkdirSync(postDir);

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  );
  fs.writeFileSync(path.join(postDir, 'cover.png'), png);
  fs.writeFileSync(
    path.join(postDir, 'index.md'),
    '---\ntitle: "基线守卫"\npublished: 2026-05-01\nimage: ./cover.png\ndraft: false\n---\n\n正文。\n'
  );

  try {
    const cfg = loadConfig();
    cfg.source.postsRoot = tmpDir;
    cfg.source.gitPull = false;
    cfg.source.assetRoots = ['{postDir}'];
    cfg.sync.stateFile = path.join(tmpDir, 'state.json');
    cfg.sync.defaultCover = path.join(postDir, 'cover.png');
    cfg.wechat = { appId: 'wx1234567890abcdef', appSecret: 'test_secret' };

    const makePipeline = () =>
      new SyncPipeline(
        cfg,
        new WeChatClient({ appId: 'wx1234567890abcdef', appSecret: 'test_secret', dryRun: true })
      );

    // Empty state + pending article -> must abort with actionable guidance.
    await assert.rejects(
      () => makePipeline().sync({ to: 'wechat' }),
      /尚无同步基线/,
      'a fresh machine must not silently push articles already published elsewhere'
    );

    // Explicit opt-in is allowed.
    const opted = await makePipeline().sync({ to: 'wechat', allowInitialPush: true, dryRun: true });
    assert.equal(opted.failed.length, 0);

    // Dry runs only warn.
    const dry = await makePipeline().sync({ to: 'wechat', dryRun: true });
    assert.equal(dry.failed.length, 0);

    // After a baseline exists, normal sync is allowed without the flag.
    const withBaseline = makePipeline();
    await withBaseline.baseline();
    const after = await withBaseline.sync({ to: 'wechat', dryRun: true });
    assert.equal(after.failed.length, 0);
    assert.equal(after.pushed.length, 0, 'baselined article must not be re-pushed');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('StateStore.importFrom merges another machine baseline without overwriting', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2posts-import-'));
  const stateFile = path.join(tmpDir, 'state.json');

  try {
    const store = new StateStore(stateFile);
    store.setPost('existing', {
      contentHash: 'local-hash',
      title: '本地已有',
      status: 'synced',
      pushedAt: '2026-06-01T00:00:00.000Z',
      draftMediaId: 'local-media',
    });
    store.save();

    const incoming = {
      version: 1,
      baselineCreatedAt: '2026-01-01T00:00:00.000Z',
      posts: {
        // Must NOT overwrite the local record.
        existing: { contentHash: 'imported-hash', title: '导入的', status: 'baselined', pushedAt: '2026-01-01T00:00:00.000Z' },
        fresh: { contentHash: 'fresh-hash', title: '新导入', status: 'baselined', pushedAt: '2026-01-02T00:00:00.000Z' },
      },
      images: {},
      covers: {},
    };

    const result = store.importFrom(incoming);
    assert.equal(result.added, 1);
    assert.equal(result.skipped, 1);

    const reloaded = new StateStore(stateFile);
    assert.equal(reloaded.getPost('existing')?.contentHash, 'local-hash', 'local record wins');
    assert.equal(reloaded.getPost('existing')?.draftMediaId, 'local-media');
    assert.equal(reloaded.getPost('fresh')?.contentHash, 'fresh-hash');
    assert.equal(reloaded.getBaselineCreatedAt(), '2026-01-01T00:00:00.000Z');

    // Importing twice is idempotent.
    const again = reloaded.importFrom(incoming);
    assert.equal(again.added, 0);
    assert.equal(again.skipped, 2);

    // Invalid payload is rejected with an actionable message.
    assert.throws(() => reloaded.importFrom({ nope: true }), /不是有效的 state\.json/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
