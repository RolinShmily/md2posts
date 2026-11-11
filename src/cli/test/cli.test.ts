import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliEntry = path.resolve(__dirname, '../dist/index.js');

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

test('CLI commands: themes, check, baseline, preview, and push --dry-run', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2posts-cli-test-'));
  const postsRoot = path.join(tmpDir, 'posts');
  const postDir = path.join(postsRoot, 'cli-demo');
  const configPath = path.join(tmpDir, 'config.yaml');
  const previewPath = path.join(tmpDir, 'preview.html');

  fs.mkdirSync(postDir, { recursive: true });
  fs.writeFileSync(
    path.join(postDir, 'index.md'),
    `---\ntitle: "CLI 测试文章 | 演练"\npublished: 2026-11-05\ndescription: "CLI 测试摘要"\nimage: ./cover.png\ndraft: false\n---\n# 第一节\n\n正文段落。\n`,
    'utf8'
  );
  fs.writeFileSync(path.join(postDir, 'cover.png'), PNG_1X1);

  fs.writeFileSync(
    configPath,
    `source:\n  postsRoot: ./posts\n  layout: bundle\nsite:\n  url: "https://blog.srprolin.com"\nrender:\n  theme: "tech-blue"\nsync:\n  stateFile: ./state.json\n  defaultCover: ./posts/cli-demo/cover.png\n`,
    'utf8'
  );

  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 1. themes
  const themesOut = await execFileAsync(process.execPath, [cliEntry, 'themes']);
  assert.match(themesOut.stdout, /tech-blue/);
  assert.match(themesOut.stdout, /fullstack-blue/);

  // 2. check
  const checkOut = await execFileAsync(process.execPath, [cliEntry, 'check', '-c', configPath]);
  assert.match(checkOut.stdout, /新增待自动同步:\s+1 篇/);
  assert.match(checkOut.stdout, /\[cli-demo\]/);

  // 3. preview
  const previewOut = await execFileAsync(process.execPath, [
    cliEntry,
    'preview',
    'cli-demo',
    '-c',
    configPath,
    '-o',
    previewPath,
  ]);
  assert.match(previewOut.stdout, /预览文件已成功生成/);
  assert.ok(fs.existsSync(previewPath));

  // 4. push --dry-run
  const pushOut = await execFileAsync(process.execPath, [
    cliEntry,
    'push',
    'cli-demo',
    '-c',
    configPath,
    '--dry-run',
  ]);
  assert.match(pushOut.stdout, /推送成功/);
  assert.match(pushOut.stdout, /dry-run-draft-/);
});
