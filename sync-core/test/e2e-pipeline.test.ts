import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { WeChatClient, MemoryTokenStore } from '@md2wechat/wechat-sdk';
import { SyncPipeline, loadConfig, StateStore } from '../src/index.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

test('E2E Pipeline: baseline -> sync idempotency -> update -> 40007 fallback -> webhook notify', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2wechat-e2e-'));
  const postsRoot = path.join(tmpDir, 'posts');
  const stateFile = path.join(tmpDir, 'state.json');
  fs.mkdirSync(postsRoot, { recursive: true });

  // Track mock server API calls
  const apiCounters = {
    uploadImg: 0,
    addMaterial: 0,
    draftAdd: 0,
    draftUpdate: 0,
    webhook: 0,
  };
  let simulateDeletedDraftOnUpdate = false;
  let lastWebhookBody: any = null;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`);

    if (url.pathname === '/cgi-bin/token') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'e2e_token', expires_in: 7200 }));
      return;
    }

    if (url.pathname === '/cgi-bin/media/uploadimg') {
      apiCounters.uploadImg++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          url: `https://mmbiz.qpic.cn/mmbiz_png/body_${apiCounters.uploadImg}/0`,
        })
      );
      return;
    }

    if (url.pathname === '/cgi-bin/material/add_material') {
      apiCounters.addMaterial++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          media_id: `cover_media_${apiCounters.addMaterial}`,
          url: `https://mmbiz.qpic.cn/mmbiz_jpg/cover_${apiCounters.addMaterial}/0`,
        })
      );
      return;
    }

    if (url.pathname === '/cgi-bin/draft/add') {
      apiCounters.draftAdd++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ media_id: `draft_id_${apiCounters.draftAdd}` }));
      return;
    }

    if (url.pathname === '/cgi-bin/draft/update') {
      apiCounters.draftUpdate++;
      if (simulateDeletedDraftOnUpdate) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ errcode: 40007, errmsg: 'invalid media_id rid: test' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }));
      return;
    }

    if (url.pathname === '/webhook') {
      apiCounters.webhook++;
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        lastWebhookBody = JSON.parse(raw);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(() => {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Helper to write a bundle post
  const writePost = (slug: string, date: string, body: string) => {
    const dir = path.join(postsRoot, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'index.md'),
      `---\ntitle: "${slug} 标题 | 技术"\npublished: ${date}\ndescription: "摘要 ${slug}"\nimage: ./cover.png\ndraft: false\n---\n${body}\n`,
      'utf8'
    );
    fs.writeFileSync(path.join(dir, 'cover.png'), PNG_1X1);
    fs.writeFileSync(path.join(dir, 'shot.png'), PNG_1X1);
  };

  // 1. Create a historical post and run baseline()
  writePost('1-history-post', '2026-01-01', '# 历史章节\n\n![图](./shot.png)');

  const config = loadConfig();
  config.source.postsRoot = postsRoot;
  config.source.assetRoots = ['{postDir}'];
  config.sync.stateFile = stateFile;
  config.notify = {
    webhookUrl: `${baseUrl}/webhook`,
    onSuccess: true,
    onFailure: true,
  };

  const makePipeline = () =>
    new SyncPipeline(
      config,
      new WeChatClient({
        appId: 'wx1234567890abcdef',
        appSecret: 'secret1234567890abcdef1234567890',
        baseUrl,
        tokenStore: new MemoryTokenStore(),
      })
    );

  const countBaselined = await makePipeline().baseline();
  assert.equal(countBaselined, 1);

  // Sync right after baseline -> 0 API calls
  const syncAfterBaseline = await makePipeline().sync();
  assert.equal(syncAfterBaseline.pushed.length, 0);
  assert.equal(apiCounters.draftAdd, 0);
  assert.equal(apiCounters.uploadImg, 0);

  // 2. Add a new post and run sync() -> should upload image, upload cover, and call draft/add
  writePost('2-new-post', '2026-02-01', '# 新文章章节\n\n![测试图](./shot.png)');
  const syncNew = await makePipeline().sync();
  assert.equal(syncNew.pushed.length, 1);
  assert.equal(syncNew.pushed[0].id, '2-new-post');
  assert.equal(syncNew.pushed[0].isUpdate, false);
  assert.equal(syncNew.pushed[0].mediaId, 'draft_id_1');
  assert.equal(apiCounters.uploadImg, 1);
  assert.equal(apiCounters.addMaterial, 1);
  assert.equal(apiCounters.draftAdd, 1);
  assert.equal(apiCounters.webhook, 1);
  assert.match(lastWebhookBody?.text || '', /2-new-post/);

  // 3. Re-run sync() with no changes -> 0 API calls (idempotent)
  const syncIdempotent = await makePipeline().sync();
  assert.equal(syncIdempotent.pushed.length, 0);
  assert.equal(apiCounters.draftAdd, 1);
  assert.equal(apiCounters.draftUpdate, 0);

  // 4. Modify 2-new-post body -> check() detects 'updated', but default sync() skips updated posts!
  writePost('2-new-post', '2026-02-01', '# 新文章章节（修订版）\n\n![测试图](./shot.png)');
  const checkAfterEdit = await makePipeline().check();
  assert.equal(checkAfterEdit.updatedCount, 1, 'check() must detect the modified article');

  const syncDefaultSkipUpdate = await makePipeline().sync();
  assert.equal(syncDefaultSkipUpdate.pushed.length, 0, 'Default sync() must not auto-push updated old articles');
  assert.equal(syncDefaultSkipUpdate.skippedUpdatedCount, 1);
  assert.equal(apiCounters.draftUpdate, 0);

  // Manual push(slug) (or sync({ includeUpdated: true })) pushes the modified article and reuses cached images
  const manualPushUpdate = await makePipeline().push('2-new-post');
  assert.equal(manualPushUpdate.id, '2-new-post');
  assert.equal(manualPushUpdate.isUpdate, true);
  assert.equal(manualPushUpdate.mediaId, 'draft_id_1');
  assert.equal(apiCounters.uploadImg, 1, 'Cached body image must not be re-uploaded');
  assert.equal(apiCounters.addMaterial, 1, 'Cached cover must not be re-uploaded');
  assert.equal(apiCounters.draftUpdate, 1);

  // 5. Simulate draft deleted in WeChat backend (40007 on manual push/update) -> falls back to draft/add
  simulateDeletedDraftOnUpdate = true;
  writePost('2-new-post', '2026-02-01', '# 新文章章节（第三版）\n\n![测试图](./shot.png)');
  const manualPushFallback = await makePipeline().push('2-new-post');
  assert.equal(manualPushFallback.id, '2-new-post');
  assert.equal(manualPushFallback.isUpdate, false);
  assert.equal(manualPushFallback.mediaId, 'draft_id_2');
  assert.equal(apiCounters.draftUpdate, 2);
  assert.equal(apiCounters.draftAdd, 2);
});

test('StateStore.withLock blocks concurrent writes from a live process', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2wechat-lock-'));
  const stateFile = path.join(tmpDir, 'state.json');

  try {
    const storeA = new StateStore(stateFile);
    const storeB = new StateStore(stateFile);

    await storeA.withLock(async () => {
      // While storeA holds the lock, a separate StateStore instance attempting to lock must fail
      await assert.rejects(
        async () => {
          await storeB.withLock(async () => {});
        },
        /正在运行中/
      );
    });

    // After storeA releases the lock, storeB can acquire it cleanly
    let acquired = false;
    await storeB.withLock(async () => {
      acquired = true;
    });
    assert.equal(acquired, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
