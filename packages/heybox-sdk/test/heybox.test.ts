import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  renderCodeBlockToImage,
  buildCodeBlockSvg,
  formatCodeAsNativeTerminalBox,
  crop16x9Cover,
  parseMarkdownTable,
  renderTableToImage,
  formatTableAsFallbackText,
  inferHeyBoxMetadata,
  prepareHeyBoxArticle,
  renderHeyBoxRichHtml,
  sanitizeHeyBoxHtml,
  selectReferencedAssets,
  normalizeHeyBoxTitle,
  HeyBoxClient,
  HeyBoxClient,
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
      codeBlockMode: 'image',
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

test('parseMarkdownTable and renderTableToImage render valid PNG buffer and fallback text', async () => {
  const tableMd = `
| 参数 | 说明 | 默认值 |
| :--- | :---: | ---: |
| port | 服务端口 | 8080 |
| host | 监听地址 | 0.0.0.0 |
`;

  const parsed = parseMarkdownTable(tableMd);
  assert.ok(parsed, 'Table should be parsed successfully');
  assert.deepEqual(parsed.headers, ['参数', '说明', '默认值']);
  assert.deepEqual(parsed.alignments, ['left', 'center', 'right']);
  assert.equal(parsed.rows.length, 2);

  const pngBuf = await renderTableToImage(parsed);
  assert.ok(pngBuf.length > 500, 'PNG table card should be generated');
  assert.equal(pngBuf[0], 0x89);
  assert.equal(pngBuf[1], 0x50);
  assert.equal(pngBuf[2], 0x4e);
  assert.equal(pngBuf[3], 0x47);

  const fallback = formatTableAsFallbackText(parsed);
  assert.match(fallback, /数据表格/);
  assert.match(fallback, /服务端口/);
});

test('renderHeyBoxRichHtml generates clean, stable HTML without nested <p> or raw <table>', async () => {
  const complexMarkdown = `
# 一级大标题

这是正文段落，带外部链接 [官方文档](https://nodejs.org) 和行内代码 \`const x = 100\` 以及删除线 ~~废弃旧版~~。

\`\`\`bash
echo "$HOME" && pnpm install $PKG
\`\`\`

中间文本。

\`\`\`bash
echo "$HOME" && pnpm install $PKG
\`\`\`

| 命令 | 作用 |
| :--- | :--- |
| build | 构建项目 |
| test | 自动化测试 |

列表：
- [ ] 待办 1
- [x] 完成 2

> 这是引用文本
`;

  const prepared = await prepareHeyBoxArticle({
    id: 'stability-test',
    title: '稳定性测试文章',
    bodyMarkdown: complexMarkdown,
    canonicalUrl: 'https://example.com/test-article',
  });

  // 1. Check no nested <p><p> tags exist
  assert.doesNotMatch(prepared.richHtml, /<p>\s*<p>/i, 'Should not contain nested <p><p>');
  assert.doesNotMatch(prepared.richHtml, /<\/p>\s*<\/p>/i, 'Should not contain nested </p></p>');

  // 2. Check no raw <table> tags exist (converted to images)
  assert.doesNotMatch(prepared.richHtml, /<table\b/i, 'Should not output raw <table> HTML');
  assert.match(prepared.richHtml, /!\[数据表格\]\(assets\/table_1\.png\)|data:image\/png;base64/);

  // 3. External links keep only the label: no anchor, no printed URL (平台禁止外站引流)
  assert.match(prepared.richHtml, /官方文档/);
  assert.doesNotMatch(prepared.richHtml, /nodejs\.org/);
  assert.doesNotMatch(prepared.richHtml, /<a\b[^>]*href=["']https:\/\//i);

  // 4. Check inline code and strikethrough normalized to strong
  assert.match(prepared.richHtml, /<strong>const x = 100<\/strong>/);
  assert.match(prepared.richHtml, /<strong>废弃旧版<\/strong>/);

  // 5. Check task list checkboxes
  assert.match(prepared.richHtml, /☐ 待办 1/);
  assert.match(prepared.richHtml, /☑ 完成 2/);

  // 6. Check headings normalized to H2 and H3
  assert.match(prepared.richHtml, /<h2>一级大标题<\/h2>/);
  assert.doesNotMatch(prepared.richHtml, /<h1>/i);

  // 7. Check multiple code blocks with $ variables in 'auto' mode become native terminal blocks
  assert.match(prepared.richHtml, /💻 终端命令 · BASH/);
  assert.match(prepared.richHtml, /echo &quot;\$HOME&quot; &amp;&amp; pnpm install \$PKG/);
  assert.equal(prepared.assets.has('assets/table_1.png'), true);

  // 8. Test 'image' mode explicitly to verify PNG card generation
  const imageModePrep = await prepareHeyBoxArticle(
    {
      id: 'image-mode-test',
      title: '图片模式测试',
      bodyMarkdown: complexMarkdown,
      canonicalUrl: 'https://example.com/test-article',
    },
    { codeBlockMode: 'image' }
  );
  assert.equal(imageModePrep.assets.has('assets/code_1_bash.png'), true);
  assert.equal(imageModePrep.assets.has('assets/code_2_bash.png'), true);
  assert.equal(imageModePrep.assets.has('assets/table_1.png'), true);
});

test('code rendering preserves indentation in both terminal blocks and image cards', async () => {
  const indentedCode = 'def f(x):\n    if x:\n        return 1\n    return 0';

  // 1. Native terminal box must keep indentation via &nbsp; (HTML collapses raw spaces)
  const terminalBox = formatCodeAsNativeTerminalBox(indentedCode, 'python');
  assert.match(terminalBox, /&nbsp;&nbsp;&nbsp;&nbsp;if x:/);
  assert.match(terminalBox, /&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;return 1/);

  // 2. Image card must keep indentation (SVG collapses leading spaces without xml:space)
  const svgSource = buildCodeBlockSvg(indentedCode, 'python');
  assert.match(svgSource, /xml:space="preserve"/);
});

test('HeyBoxApiClient recognizes session saved by Playwright storageState without root user_id', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2posts-session-test-'));
  const sessionPath = path.join(tmpDir, 'heybox-session.json');

  // Playwright storageState structure
  const playwrightSession = {
    cookies: [
      {
        name: 'heybox_id',
        value: '98765432',
        domain: '.xiaoheihe.cn',
        path: '/',
      },
      {
        name: 'token',
        value: 'mock_token_abc',
        domain: '.xiaoheihe.cn',
        path: '/',
      },
    ],
    origins: [],
  };

  fs.writeFileSync(sessionPath, JSON.stringify(playwrightSession));

  try {
    const client = new HeyBoxClient({ sessionFile: sessionPath });
    assert.equal(client.hasSession(), true, 'Should detect valid session from Playwright cookies');
    const session = client.apiClient.getSession();
    assert.ok(session);
    assert.equal(session.userId, '98765432');
    assert.match(session.cookieHeader, /heybox_id=98765432/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('selectReferencedAssets skips unreferenced siblings and the duplicated cover source', () => {
  const coverSrc = Buffer.from('cover-source-bytes');
  const referenced = Buffer.from('referenced-image-bytes');

  const prepared = {
    richHtml: `<p><img src="data:image/png;base64,${referenced
      .subarray(0, 96)
      .toString('base64')
      .slice(0, 64)}..." /></p>`,
    markdown: '',
    assets: new Map<string, Buffer>([
      ['cover_16_9.jpg', Buffer.from('cropped-cover-bytes')],
      ['assets/cover.png', coverSrc], // same picture as cover source, not used in body
      ['assets/inline.png', referenced], // actually referenced
      ['assets/unused.png', Buffer.from('never-referenced')],
    ]),
  } as any;

  const selected = selectReferencedAssets(prepared);
  const names = selected.map((s) => s.filename);

  assert.ok(names.includes('cover_16_9.jpg'), 'cover must always be uploaded');
  assert.ok(names.includes('assets/inline.png'), 'referenced image must be uploaded');
  assert.ok(!names.includes('assets/cover.png'), 'cover source duplicate must be skipped');
  assert.ok(!names.includes('assets/unused.png'), 'unreferenced image must be skipped');
  assert.equal(selected.length, 2);
});

test('createArticleDraft uploads identical content once and dedupes img blocks', async () => {
  const client = new (await import('../src/api-client.js')).HeyBoxApiClient();

  let uploadCalls = 0;
  (client as any).uploadImage = async (buffer: Buffer, filename: string) => {
    uploadCalls++;
    return { url: 'https://cdn.example.com/same.png', width: 10, height: 10, filename };
  };
  (client as any).resolveTopics = async () => ({ topicIds: '', hashtagList: [] });

  let sentForm: Record<string, string> | undefined;
  (client as any).request = async (_path: string, opts: any) => {
    sentForm = opts.form;
    return { link_id: 123 };
  };

  const payload = Buffer.from('IDENTICAL-CONTENT');
  const res = await client.createArticleDraft({
    title: 'T',
    markdown: 'x',
    richHtml: `<p><img src="data:image/png;base64,${payload
      .subarray(0, 96)
      .toString('base64')
      .slice(0, 64)}..." /></p>`,
    images: [
      { filename: 'assets/one.png', buffer: payload, mimetype: 'image/png' },
      { filename: 'assets/two.png', buffer: Buffer.from('IDENTICAL-CONTENT'), mimetype: 'image/png' },
    ],
  });

  assert.equal(res.draftId, '123');
  assert.equal(uploadCalls, 1, 'identical bytes must only be uploaded once');

  const blocks = JSON.parse(sentForm!.text);
  const imgBlocks = blocks.filter((b: any) => b.type === 'img');
  assert.equal(imgBlocks.length, 1, 'duplicate img metadata blocks must be collapsed');
});

test('toXiaoHeiHeImgTag emits data-original only (a src attribute duplicates nodes)', async () => {
  const { toXiaoHeiHeImgTag } = await import('../src/api-client.js');
  const tag = toXiaoHeiHeImgTag({ url: 'https://cdn/x/thumb.png', width: 720, height: 140 });

  assert.match(tag, /data-original="https:\/\/cdn\/x\/thumb\.png"/);
  assert.match(tag, /data-width="720"/);
  assert.match(tag, /data-height="140"/);
  // Verified against the official editor: presence of `src` makes the editor create
  // two image nodes per tag (squashed thumb + cropped full copy), i.e. duplicate images.
  assert.doesNotMatch(tag, /\bsrc=/);
});

test('cover comes only from frontmatter or defaultCover, and is prepended to the body', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2posts-cover-top-'));
  const postDir = path.join(tmpDir, 'cover-post');
  fs.mkdirSync(postDir);

  // 16:9-ish cover image so crop16x9Cover takes the simple path
  const coverPath = path.join(postDir, 'shot.png');
  await (await import('sharp')).default({
    create: { width: 1280, height: 720, channels: 3, background: '#334455' },
  })
    .png()
    .toFile(coverPath);

  try {
    const baseArticle = {
      id: 'cover-post',
      title: 'Cover Post',
      bodyMarkdown: '# 小节\n\n正文内容。',
      canonicalUrl: 'https://blog.example.com/posts/cover-post/',
      postDir,
      frontmatter: {},
      localAssetPaths: [coverPath],
    };

    // 1) No frontmatter cover and no defaultCover -> NO cover at all.
    //    A random sibling screenshot must never be picked as the cover.
    const noCover = await prepareHeyBoxArticle(baseArticle);
    assert.equal(noCover.coverBuffer, undefined, 'must not guess a cover from sibling assets');
    assert.ok(!noCover.markdown.startsWith('![封面]'));
    assert.equal(noCover.assets.has('cover_16_9.jpg'), false);

    // 2) defaultCover configured -> cover generated and prepended to the body.
    const prepared = await prepareHeyBoxArticle(baseArticle, { defaultCoverPath: coverPath });

    assert.ok(prepared.coverBuffer, 'cover should come from the configured defaultCover');
    assert.ok(
      prepared.markdown.startsWith('![封面](assets/cover_16_9.jpg)'),
      'cover image must be prepended to the body before the first heading'
    );
    assert.match(prepared.richHtml, /^<p><img src="data:image\/jpeg;base64,/);
    assert.ok(prepared.assets.has('cover_16_9.jpg'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('all external links keep only their label; own domains and footer carry no URL', async () => {
  const body = [
    '参考[站内旧文](https://blog.example.com/posts/old/)以及[官方文档](https://example.org/docs)。',
    '裸链 https://blog.example.com/posts/bare/ 也应被移除。',
    '自有子域[文档站](https://doc.example.com/guide)同样处理。',
    '',
    '```bash',
    'curl -fsSL https://blog.example.com/script.sh | sh',
    '```',
  ].join('\n');

  const prepared = await prepareHeyBoxArticle(
    {
      id: 'link-policy',
      title: 'Link Policy',
      bodyMarkdown: body,
      canonicalUrl: 'https://blog.example.com/posts/link-policy/',
    },
    { siteUrl: 'https://blog.example.com' }
  );

  // Labels survive, every URL is gone from the body.
  assert.ok(prepared.markdown.includes('站内旧文'));
  assert.ok(prepared.markdown.includes('官方文档'));
  assert.ok(prepared.markdown.includes('文档站'));

  const prose = prepared.markdown.replace(/<blockquote>[\s\S]*?<\/blockquote>/g, '');
  assert.ok(!prose.includes('blog.example.com'), 'own apex and its subdomains must be removed');
  assert.ok(!prose.includes('example.org'), 'third-party URLs must not be printed either');
  assert.ok(!prepared.richHtml.includes('<a href'), 'no external anchors are emitted');

  // Code blocks are content, not promotion: their URLs must survive.
  assert.ok(prepared.richHtml.includes('blog.example.com/script.sh'));

  // Footer no longer advertises the blog.
  assert.ok(!prepared.markdown.includes('本文同步自个人技术博客'));
  assert.ok(!prepared.richHtml.includes('blog.example.com/posts/link-policy'));
});

test('external link threshold produces a publishing warning', async () => {
  const many = Array.from({ length: 6 }, (_, i) => `[文档${i}](https://example${i}.org/page)`).join('\n\n');

  const quiet = await prepareHeyBoxArticle({
    id: 'few-links',
    title: 'Few',
    bodyMarkdown: '[文档](https://example.org/page)',
    canonicalUrl: 'https://blog.example.com/posts/x/',
  });
  assert.equal(quiet.warnings.length, 0);

  const noisy = await prepareHeyBoxArticle({
    id: 'many-links',
    title: 'Many',
    bodyMarkdown: many,
    canonicalUrl: 'https://blog.example.com/posts/x/',
  });
  assert.equal(noisy.externalLinkCount, 6);
  assert.equal(noisy.warnings.length, 1);
  assert.match(noisy.warnings[0], /站外链接/);
});

test('title is truncated to the platform 30-character limit', async () => {
  const long = '一个明显超过三十个字符上限的小黑盒文章标题用于验证裁剪逻辑是否正确工作';
  const short = '简短标题';

  assert.equal(normalizeHeyBoxTitle(short).title, short);
  const cut = normalizeHeyBoxTitle(long);
  assert.ok(cut.title.length <= 30, `title must be <= 30 chars, got ${cut.title.length}`);
  assert.equal(cut.stripped, true);

  // Explicit limit still honoured (WeChat uses 64).
  assert.ok(normalizeHeyBoxTitle(long, 64).title.length <= 64);

  // Under the limit nothing is stripped (titles are left untouched on purpose).
  assert.equal(normalizeHeyBoxTitle('主标题 | 副标题').title, '主标题 | 副标题');

  // Over the limit: suffix tags are dropped right-to-left before any hard cut.
  const tagged = normalizeHeyBoxTitle(
    '这是一个很长的主标题用于超过三十个字符限制 | 副标题 | 分类'
  );
  assert.ok(tagged.title.length <= 30);
  assert.ok(!tagged.title.includes('分类'), 'trailing tag should be stripped first');
});

test('publishDraft surfaces account mute / length limits instead of faking success', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2posts-limits-'));
  const postDir = path.join(tmpDir, 'p');
  fs.mkdirSync(postDir);
  await (await import('sharp')).default({
    create: { width: 64, height: 36, channels: 3, background: '#123456' },
  })
    .png()
    .toFile(path.join(postDir, 'shot.png'));
  fs.writeFileSync(path.join(postDir, 'index.md'), '正文\n');

  const article = {
    id: 'limits',
    title: '限额测试',
    bodyMarkdown: '正文内容足够长以满足最小长度要求。'.repeat(4),
    canonicalUrl: 'https://blog.example.com/posts/limits/',
    postDir,
    localAssetPaths: [path.join(postDir, 'shot.png')],
  };

  const client = new HeyBoxClient({ assetRoots: ['{postDir}'], outputDir: path.join(tmpDir, 'out') });

  // Pretend a session exists, and the platform says "muted" / article-forbidden.
  (client as any).apiClient.hasSession = () => true;
  (client as any).apiClient.getPostLimits = async () => ({
    canPostArticle: false,
    canPostLink: false,
    canPostComment: false,
    articleMessage: '由于违反社区规定，您已被禁言，还剩6天',
    linkMessage: '由于违反社区规定，您已被禁言，还剩6天',
    commentMessage: undefined,
    titleMax: 30, titleMin: 2, textMax: 30000, textMin: 50, picMax: 100,
  });

  await assert.rejects(
    () => client.publishDraft(article, { skipBrowser: true }),
    (err: any) => {
      assert.equal(err.code, 'ARTICLE_FORBIDDEN');
      assert.match(err.message, /禁言/);
      return true;
    }
  );

  // Muted-but-can-article + nothing succeeded: must throw, not return a "success" tip.
  (client as any).apiClient.getPostLimits = async () => ({
    canPostArticle: true,
    canPostLink: false,
    canPostComment: false,
    articleMessage: undefined,
    linkMessage: '由于违反社区规定，您已被禁言，还剩6天',
    commentMessage: undefined,
    titleMax: 30, titleMin: 2, textMax: 30000, textMin: 50, picMax: 100,
  });
  (client as any).apiClient.createArticleDraft = async () => {
    throw new Error('小黑盒 API 网络异常 (HTTP 503)');
  };
  (client as any).isCliAvailable = async () => false;

  await assert.rejects(
    () => client.publishDraft(article, { skipBrowser: true }),
    (err: any) => {
      assert.equal(err.code, 'NO_CHANNEL_SUCCEEDED');
      assert.match(err.message, /未创建小黑盒草稿/);
      assert.match(err.message, /禁言/);
      assert.match(err.message, /out/);
      return true;
    }
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
