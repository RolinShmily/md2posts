import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  WeChatClient,
  MemoryTokenStore,
  TokenManager,
  WeChatError,
  extractIpFromErrorMessage,
} from '../src/index.js';

test('extractIpFromErrorMessage correctly parses WeChat IP whitelist message', () => {
  const msg1 = 'invalid ip 185.199.108.153 ipv6 ::1, not in whitelist rid: 672a123';
  assert.equal(extractIpFromErrorMessage(msg1), '185.199.108.153');

  const msg2 = 'invalid ip 2400:cb00:2048:1::c629:d7a2, not in whitelist';
  assert.equal(extractIpFromErrorMessage(msg2), '2400:cb00:2048:1::c629:d7a2');
});

test('TokenManager deduplicates concurrent refresh calls', async (t) => {
  let tokenRequestCount = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    if (url.pathname === '/cgi-bin/token') {
      tokenRequestCount++;
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: `dedup_token_${tokenRequestCount}`, expires_in: 7200 }));
      }, 25);
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port;
  t.after(() => server.close());

  const manager = new TokenManager({
    appId: 'wx1234567890abcdef',
    appSecret: 'secret1234567890abcdef1234567890',
    baseUrl: `http://127.0.0.1:${port}`,
    tokenStore: new MemoryTokenStore(),
  });

  // Fire 10 concurrent getAccessToken calls
  const results = await Promise.all(
    Array.from({ length: 10 }, () => manager.getAccessToken())
  );

  assert.equal(tokenRequestCount, 1, 'Only 1 HTTP token request should be sent for 10 concurrent calls');
  assert.ok(results.every((tok) => tok === 'dedup_token_1'));
});

test('WeChatClient auto-refreshes token on 42001/40001 and does NOT retry 45009 quota error', async (t) => {
  let tokenCount = 0;
  let draftCountCalls = 0;
  let quotaCalls = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    if (url.pathname === '/cgi-bin/token') {
      tokenCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: `token_v${tokenCount}`, expires_in: 7200 }));
      return;
    }

    if (url.pathname === '/cgi-bin/draft/count') {
      draftCountCalls++;
      const tok = url.searchParams.get('access_token');
      // First call with token_v1 returns 42001 expired
      if (tok === 'token_v1') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ errcode: 42001, errmsg: 'access_token expired' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ total_count: 12 }));
      return;
    }

    if (url.pathname === '/cgi-bin/draft/delete') {
      quotaCalls++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ errcode: 45009, errmsg: 'reach max api daily quota limit' }));
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port;
  t.after(() => server.close());

  const client = new WeChatClient({
    appId: 'wx1234567890abcdef',
    appSecret: 'secret1234567890abcdef1234567890',
    baseUrl: `http://127.0.0.1:${port}`,
    tokenStore: new MemoryTokenStore(),
    retryDelayMs: 10,
  });

  const count = await client.draft.count();
  assert.equal(count, 12);
  assert.equal(tokenCount, 2, 'Token should be fetched initially and refreshed once after 42001');
  assert.equal(draftCountCalls, 2);

  // 45009 should throw immediately without retrying
  await assert.rejects(
    async () => {
      await client.draft.delete('media_1');
    },
    (err: any) => err instanceof WeChatError && err.errcode === 45009 && err.isQuotaExceeded()
  );
  assert.equal(quotaCalls, 1, '45009 must not be retried');
});

test('WeChatClient diagnose(), media.uploadImage, material.addImage, and draft endpoints with mock server', async (t) => {
  let tokenCounter = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`);

    if (url.pathname === '/cgi-bin/token') {
      tokenCounter++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: `mock_token_${tokenCounter}`, expires_in: 7200 }));
      return;
    }

    if (url.pathname === '/cgi-bin/draft/count') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ total_count: 7 }));
      return;
    }

    if (url.pathname === '/cgi-bin/media/uploadimg') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: 'https://mmbiz.qpic.cn/mmbiz_png/mock_body_img/0' }));
      return;
    }

    if (url.pathname === '/cgi-bin/material/add_material') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          media_id: 'perm_cover_media_99',
          url: 'https://mmbiz.qpic.cn/mmbiz_jpg/mock_cover/0',
        })
      );
      return;
    }

    if (url.pathname === '/cgi-bin/draft/add') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ media_id: 'draft_media_12345' }));
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port;
  t.after(() => server.close());

  const client = new WeChatClient({
    appId: 'wx1234567890abcdef',
    appSecret: 'secret1234567890abcdef1234567890',
    baseUrl: `http://127.0.0.1:${port}`,
    tokenStore: new MemoryTokenStore(),
  });

  const report = await client.diagnose();
  assert.equal(report.ok, true);
  assert.equal(report.canUseDraftApi, true);
  assert.equal(report.ipWhitelistOk, true);
  assert.match(report.steps[2].message, /现有文章数：7/);

  const imgUrl = await client.media.uploadImage(new Uint8Array([137, 80, 78, 71]), 'a.png');
  assert.equal(imgUrl, 'https://mmbiz.qpic.cn/mmbiz_png/mock_body_img/0');

  const cover = await client.material.addImage(new Uint8Array([255, 216, 255]), 'cover.jpg');
  assert.equal(cover.mediaId, 'perm_cover_media_99');

  const mediaId = await client.draft.add([
    {
      title: '测试文章',
      content: `<p><img src="${imgUrl}" /></p>`,
      thumb_media_id: cover.mediaId,
    },
  ]);
  assert.equal(mediaId, 'draft_media_12345');
});

test('WeChatClient diagnose() reports IP whitelist error when 40164 returned', async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        errcode: 40164,
        errmsg: 'invalid ip 198.51.100.42 ipv6 ::ffff:198.51.100.42, not in whitelist rid: test',
      })
    );
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port;
  t.after(() => server.close());

  const client = new WeChatClient({
    appId: 'wx1234567890abcdef',
    appSecret: 'secret1234567890abcdef1234567890',
    baseUrl: `http://127.0.0.1:${port}`,
    tokenStore: new MemoryTokenStore(),
  });

  const report = await client.diagnose();
  assert.equal(report.ok, false);
  assert.equal(report.ipWhitelistOk, false);
  assert.equal(report.detectedIp, '198.51.100.42');
  const ipStep = report.steps.find((s) => s.step === 'ip_whitelist');
  assert.ok(ipStep);
  assert.equal(ipStep?.code, 40164);
  assert.match(ipStep?.remediation || '', /198\.51\.100\.42/);
});

test('WeChatClient diagnose() reports 48001 when draft permission denied', async (t) => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    if (url.pathname === '/cgi-bin/token') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'mock_token', expires_in: 7200 }));
      return;
    }
    if (url.pathname === '/cgi-bin/draft/count') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ errcode: 48001, errmsg: 'api unauthorized rid: test' }));
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port;
  t.after(() => server.close());

  const client = new WeChatClient({
    appId: 'wx1234567890abcdef',
    appSecret: 'secret1234567890abcdef1234567890',
    baseUrl: `http://127.0.0.1:${port}`,
    tokenStore: new MemoryTokenStore(),
  });

  const report = await client.diagnose();
  assert.equal(report.ok, false);
  assert.equal(report.canUseDraftApi, false);
  const draftStep = report.steps.find((s) => s.step === 'draft_permission');
  assert.ok(draftStep);
  assert.equal(draftStep?.code, 48001);
  assert.match(draftStep?.message || '', /未授权/);
});
