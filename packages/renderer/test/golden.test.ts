import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderArticle, listThemes } from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixtureDir = path.join(__dirname, 'fixtures');
const fixtureMdPath = path.join(fixtureDir, 'all-in-one.md');
const snapshotHtmlPath = path.join(fixtureDir, 'all-in-one.tech-blue.snap.html');

test('all-in-one fixture renders deterministically and matches golden snapshot', () => {
  const md = fs.readFileSync(fixtureMdPath, 'utf8');

  const imageMap = new Map([
    ['./generic-alt.png', 'https://mmbiz.qpic.cn/mock/generic-alt.png'],
    ['./arch-diagram.png', 'https://mmbiz.qpic.cn/mock/arch-diagram.png'],
    ['./stack-1.png', 'https://mmbiz.qpic.cn/mock/stack-1.png'],
    ['./stack-2.png', 'https://mmbiz.qpic.cn/mock/stack-2.png'],
    ['./ref-image.webp', 'https://mmbiz.qpic.cn/mock/ref-image.jpg'],
    ['./html-img.png', 'https://mmbiz.qpic.cn/mock/html-img.png'],
  ]);

  const result = renderArticle(md, {
    themeId: 'tech-blue',
    fontSize: 15,
    macCode: true,
    galleryMode: 'stack',
    linksToFootnotes: true,
    imageMap,
    headerCoverUrl: 'https://mmbiz.qpic.cn/mock/header-cover.jpg',
    footerCard: {
      title: '全家福综合测试文章 | Markdown | 渲染基准',
      author: 'RoL1n_SrP',
      canonicalUrl: 'https://blog.srprolin.com/posts/all-in-one/',
      licenseName: 'CC BY-NC-SA 4.0',
      publishedAt: '2026-11-05',
    },
    preprocess: {
      siteUrl: 'https://blog.srprolin.com',
      postCanonicalUrl: 'https://blog.srprolin.com/posts/all-in-one/',
      shiftBodyHeadings: true,
      imageCaptionMode: 'smart',
    },
  });

  // Verify all 6 body images were collected and replaced
  assert.equal(result.imageRefs.length, 6);
  for (const [, mmbizUrl] of imageMap) {
    assert.ok(result.html.includes(`src="${mmbizUrl}"`), `Expected ${mmbizUrl} in output HTML`);
  }

  // Verify key structural invariants
  assert.doesNotMatch(result.html, /<h1[\s>]/i, 'Body H1s must be shifted to H2');
  assert.doesNotMatch(result.html, /<ul|<ol|<li/i, 'Lists must use WeChat-safe section structure');
  assert.doesNotMatch(result.html, /data-line=|data-gallery-mode=/i, 'Preview metadata must be stripped');
  assert.match(result.html, /https:\/\/mp\.weixin\.qq\.com\/s\/wechat_internal_article/, 'WeChat link kept clickable');
  assert.match(result.html, /https:\/\/decapcms\.org\/docs\/intro\//, 'Bare domain link completed in footnotes');
  assert.match(result.html, /https:\/\/blog\.srprolin\.com\/posts\/45-immortalwrt-1\//, 'Relative link resolved in footnotes');

  if (!fs.existsSync(snapshotHtmlPath) || process.env.UPDATE_SNAPSHOTS === '1') {
    fs.writeFileSync(snapshotHtmlPath, result.html, 'utf8');
  }

  const expectedSnapshot = fs.readFileSync(snapshotHtmlPath, 'utf8');
  assert.equal(result.html, expectedSnapshot, 'Rendered HTML must match golden snapshot');
});

test('all-in-one fixture renders cleanly across all 28 themes without errors', () => {
  const md = fs.readFileSync(fixtureMdPath, 'utf8');
  const allThemes = listThemes();
  assert.equal(allThemes.length, 28);

  for (const theme of allThemes) {
    const res = renderArticle(md, {
      themeId: theme.id,
      preprocess: {
        siteUrl: 'https://blog.srprolin.com',
        postCanonicalUrl: 'https://blog.srprolin.com/posts/all-in-one/',
      },
    });
    assert.ok(res.html.length > 2000, `Theme ${theme.id} output too short`);
    assert.doesNotMatch(res.html, /undefined|NaN/);
  }
});
