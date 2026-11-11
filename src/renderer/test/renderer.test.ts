import test from 'node:test';
import assert from 'node:assert/strict';
import { renderArticle, listThemes } from '../src/index.js';

test('listThemes() returns 28 themes including tech-blue', () => {
  const themes = listThemes();
  assert.equal(themes.length, 28);
  const techBlue = themes.find((t) => t.id === 'tech-blue');
  assert.ok(techBlue);
  assert.equal(techBlue?.name, '科技蓝');
  assert.equal(techBlue?.category, '科技');
});

test('renderArticle shifts body headings (h1 -> h2) outside code fences and preserves HTML/iframes inside code fences', () => {
  const md = `# 第一节

正文

\`\`\`markdown
# 代码块里的H1不能动
<img style="width: 300px" src="https://obsidian.md/apple-touch-icon.png">
<iframe src="//player.bilibili.com/player.html?bvid=BV1"></iframe>
\`\`\`
`;
  const result = renderArticle(md, {
    themeId: 'tech-blue',
    preprocess: { shiftBodyHeadings: true },
  });

  // H1 outside code block is shifted to H2
  assert.match(result.html, /<h2[^>]*>第一节<\/h2>/);
  // Code block contents remain untouched (no ![]() conversion inside code fence)
  assert.match(result.html, /# 代码块里的H1不能动/);
  assert.match(result.html, /&lt;<span[^>]*>img<\/span>.*width: 300px/);
  assert.match(result.html, /&lt;<span[^>]*>iframe<\/span>.*\/\/player\.bilibili\.com/);
  assert.equal(result.imageRefs.length, 0);
});

test('renderArticle supports extra language aliases while preserving original fence label', () => {
  const md = `
\`\`\`pwsh
Get-Process | Where-Object { $_.CPU -gt 10 }
\`\`\`

\`\`\`cfg
[server]
port = 8080
\`\`\`
`;
  const result = renderArticle(md, {
    themeId: 'tech-blue',
    macCode: true,
  });

  // Original fence labels ('pwsh' and 'cfg') are preserved in Mac header while syntax highlighting works
  assert.match(result.html, />pwsh<\/span>/);
  assert.match(result.html, />cfg<\/span>/);
  assert.match(result.html, /<span style="color:#e6c07b">Get-Process<\/span>/);
  assert.match(result.html, /<span style="color:#61afef">\[server\]<\/span>/);
  assert.match(result.html, /port.*8080/);
});

test('renderArticle converts task lists to unicode checkboxes', () => {
  const md = `
- [ ] 待办任务
- [x] 已完成任务
`;
  const result = renderArticle(md);
  assert.match(result.html, /•&nbsp;<\/span>☐ 待办任务/);
  assert.match(result.html, /•&nbsp;<\/span>☑ 已完成任务/);
});

test('renderArticle cleans generic alt captions in smart mode and collects reference-style images', () => {
  const md = `
![1](./shot1.png)

这里是一段正文，将独立图片隔开。

![真实有效的详细图注文字说明](./shot4.png)

这里还有一张参考式图片：

![screen_1][ref-img]

[ref-img]: ./ref-target.png
`;
  const imageMap = new Map([
    ['./shot1.png', 'https://mmbiz.qpic.cn/shot1'],
    ['./shot4.png', 'https://mmbiz.qpic.cn/shot4'],
    ['./ref-target.png', 'https://mmbiz.qpic.cn/ref-target'],
  ]);

  const result = renderArticle(md, {
    themeId: 'tech-blue',
    imageMap,
    preprocess: { imageCaptionMode: 'smart' },
  });

  // All 3 images (including reference-style) collected into imageRefs
  assert.deepEqual(result.imageRefs, ['./shot1.png', './shot4.png', './ref-target.png']);

  // Generic alts ("1", "screen_1") should not have a caption span
  assert.doesNotMatch(result.html, />1<\/span>/);
  assert.doesNotMatch(result.html, />screen_1<\/span>/);

  // Descriptive alt should produce a caption span below the image
  assert.match(result.html, />真实有效的详细图注文字说明<\/span>/);

  // Reference-style image URL replaced
  assert.match(result.html, /src="https:\/\/mmbiz\.qpic\.cn\/ref-target"/);
});

test('renderArticle converts multi-line bilibili iframe to video placeholder', () => {
  const md = `
<iframe
    src="//player.bilibili.com/player.html?isOutside=true&bvid=BV136a9zqEk5"
    scrolling="no"
    border="0"
    frameborder="no"
    allowfullscreen="true"
    width="640"
    height="480">
</iframe>
`;
  const result = renderArticle(md);
  assert.match(result.html, /视频占位/);
  assert.match(result.html, /https:\/\/player\.bilibili\.com/);
});

test('renderArticle protects inline and block math formulas without corrupting inline code', () => {
  const md = `
环境变量 \`$HF_ENDPOINT\` 与 \`$HOME_DIR\` 在行内代码中不应触发数学公式警告。

这是一个行内公式 $x_1 + x_2 = y_1$ 在句子中。

$$
a_1 + b_2 = c_3
$$
`;
  const result = renderArticle(md);
  // Should NOT produce <em> inside math or inline code
  assert.doesNotMatch(result.html, /<em>/);
  assert.match(result.html, /\$HF_ENDPOINT/);
  assert.match(result.html, /\$x_1 \+ x_2 = y_1\$/);
  assert.match(result.html, /a_1 \+ b_2 = c_3/);
  // Exactly 2 math warnings (1 inline, 1 block), NOT for `$HF_ENDPOINT`
  assert.equal(result.warnings.length, 2);
  assert.ok(result.warnings.every((w) => w.type === 'math_detected'));
});

test('renderArticle performs exact image URL replacement and attaches footer card', () => {
  const md = `
![测试图片](./assets/diagram.png)

参考资料请看 [官方文档](https://example.com/docs)。
`;
  const imageMap = new Map([
    ['./assets/diagram.png', 'https://mmbiz.qpic.cn/mock_diagram_hash/0'],
  ]);

  const result = renderArticle(md, {
    themeId: 'tech-blue',
    imageMap,
    footerCard: {
      title: '测试文章标题',
      author: 'RoL1n_SrP',
      canonicalUrl: 'https://blog.srprolin.com/posts/test-1/',
      publishedAt: '2026-03-01',
    },
  });

  assert.match(result.html, /src="https:\/\/mmbiz\.qpic\.cn\/mock_diagram_hash\/0"/);
  assert.doesNotMatch(result.html, /src="\.\/assets\/diagram\.png"/);
  assert.match(result.html, /参考资料/);
  assert.match(result.html, /https:\/\/example\.com\/docs/);
  assert.match(result.html, /测试文章标题/);
  assert.match(result.html, /本文作者：.*RoL1n_SrP/);
  assert.match(result.html, /CC BY-NC-SA 4\.0/);
  assert.match(result.html, /https:\/\/blog\.srprolin\.com\/posts\/test-1\//);
});

test('renderArticle converts GFM footnotes [^id] into inline markers and bottom notes', () => {
  const md = `
这是一段带有 GFM 脚注的正文[^note1]，以及第二个脚注[^note2]。

[^note1]: 第一条脚注的详细解释。
[^note2]: 第二条脚注的补充说明。
`;
  const result = renderArticle(md);
  assert.match(result.html, /正文\[注1\]，以及第二个脚注\[注2\]/);
  assert.match(result.html, /\[注1\]<\/strong> 第一条脚注的详细解释/);
  assert.match(result.html, /\[注2\]<\/strong> 第二条脚注的补充说明/);
});

