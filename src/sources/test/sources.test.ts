import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FsSource, parseFrontmatter } from '../src/index.js';

test('parseFrontmatter correctly parses strings, lists, booleans, and dates', () => {
  const sample = `---
title: "测试标题"
published: 2026-03-01
description: 这是摘要
image: ./cover.png
tags: [Tech, Tutorial]
draft: false
pinned: true
---
# 正文内容
`;

  const { data, content } = parseFrontmatter(sample);
  assert.equal(data.title, '测试标题');
  assert.equal(data.published, '2026-03-01');
  assert.equal(data.description, '这是摘要');
  assert.equal(data.image, './cover.png');
  assert.deepEqual(data.tags, ['Tech', 'Tutorial']);
  assert.equal(data.draft, false);
  assert.equal(data.pinned, true);
  assert.equal(content.trim(), '# 正文内容');
});

test('FsSource scans bundle post directories and computes composite hash', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2posts-source-test-'));

  try {
    const post1Dir = path.join(tmpDir, 'post-1');
    fs.mkdirSync(post1Dir);
    fs.writeFileSync(
      path.join(post1Dir, 'index.md'),
      `---
title: Post One
published: 2026-01-01
description: Desc 1
image: ./img.png
draft: false
---
Body of post 1
`
    );
    fs.writeFileSync(path.join(post1Dir, 'img.png'), 'fake-image-bytes-v1');

    const source = new FsSource({
      postsRoot: tmpDir,
      siteUrl: 'https://blog.srprolin.com',
      postPathPattern: '/posts/{slug}/',
    });

    const posts = await source.scanPosts();
    assert.equal(posts.length, 1);
    const post = posts[0];
    assert.equal(post.id, 'post-1');
    assert.equal(post.title, 'Post One');
    assert.equal(post.canonicalUrl, 'https://blog.srprolin.com/posts/post-1/');
    assert.equal(post.localAssetPaths.length, 1);
    const initialHash = post.contentHash;
    assert.ok(initialHash && initialHash.length === 64);

    // Modifying sibling image changes contentHash even without changing index.md
    fs.writeFileSync(path.join(post1Dir, 'img.png'), 'fake-image-bytes-v2');
    const updatedPost = await source.getPost('post-1');
    assert.ok(updatedPost);
    assert.notEqual(updatedPost?.contentHash, initialHash);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
