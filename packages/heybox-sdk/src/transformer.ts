import fs from 'node:fs';
import path from 'node:path';
import MarkdownIt from 'markdown-it';
import { findGitRoot, resolveLocalAsset } from '@md2posts/sources';
import type {
  HeyBoxArticleInput,
  HeyBoxMetadata,
  HeyBoxPreparedResult,
  HeyBoxPrepareOptions,
} from './types.js';
import {
  renderCodeBlockToImage,
  crop16x9Cover,
  renderTableToImage,
  formatTableAsFallbackText,
  parseMarkdownTable,
  escapeXml,
  isCommandLineSnippet,
  formatCodeAsNativeTerminalBox,
} from './card-renderer.js';

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Normalizes title for community posting by stripping suffix tags right-to-left
 * if longer than maxLen (default 40).
 */
export function normalizeHeyBoxTitle(
  rawTitle: string,
  maxLen = 40
): { title: string; stripped: boolean } {
  let clean = rawTitle.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) {
    return { title: clean, stripped: false };
  }

  // Strip suffix tags delimited by | or - or _
  const delimiters = [' | ', ' - ', ' — ', ' _ '];
  for (const delim of delimiters) {
    while (clean.includes(delim) && clean.length > maxLen) {
      const lastIdx = clean.lastIndexOf(delim);
      if (lastIdx > 0) {
        clean = clean.slice(0, lastIdx).trim();
      } else {
        break;
      }
    }
    if (clean.length <= maxLen) {
      return { title: clean, stripped: true };
    }
  }

  // Truncate if still over limit
  if (clean.length > maxLen) {
    clean = clean.slice(0, maxLen - 1).trim() + '…';
    return { title: clean, stripped: true };
  }

  return { title: clean, stripped: true };
}

/**
 * Resolves XiaoHeiHe metadata from frontmatter.
 * If frontmatter explicitly defines heybox.community or heybox.tags, uses them.
 * Otherwise, defaults to clean unselected community/hashtags for safe draft saving,
 * leaving community and topic selection to the author at final publishing time.
 */
export function inferHeyBoxMetadata(
  frontmatter: Record<string, unknown> = {},
  _title = ''
): HeyBoxMetadata {
  const heyboxFm = (frontmatter.heybox as Record<string, unknown>) || {};

  if (heyboxFm.community && typeof heyboxFm.community === 'string') {
    return {
      community: heyboxFm.community.trim(),
      gameId: (heyboxFm.game_id as string | number) || undefined,
      hashtags: Array.isArray(heyboxFm.tags)
        ? (heyboxFm.tags as string[]).map(String)
        : [],
      kind: (heyboxFm.kind as 'article' | 'image_text') || 'article',
    };
  }

  // 默认兜底：不强制猜测社区与话题，只推标题、正文与封面，由作者在发布时手动选择
  return {
    community: '',
    gameId: undefined,
    hashtags: Array.isArray(heyboxFm.tags) ? (heyboxFm.tags as string[]).map(String) : [],
    kind: (heyboxFm.kind as 'article' | 'image_text') || 'article',
  };
}

/**
 * Normalizes and sanitizes HTML into a conservative, rock-solid subset strictly compatible
 * with XiaoHeiHe's ProseMirror editor schema.
 * - Drops unsupported tags (<style>, <script>, <iframe>, <form>, <div>, etc.)
 * - Unwraps forbidden containers and cleans paragraph nesting
 * - Strips empty paragraphs (<p></p>)
 */
export function sanitizeHeyBoxHtml(rawHtml: string): string {
  let html = rawHtml;

  // 1. Remove dangerous or non-display tags
  html = html.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<style\b[\s\S]*?<\/style>/gi, '');
  html = html.replace(/<!--[\s\S]*?-->/g, '');

  // 2. Convert common block wrappers to paragraph boundaries
  html = html.replace(/<\/?(?:div|section|article|header|footer|nav|aside|main)\b[^>]*>/gi, (m) => {
    return m.startsWith('</') ? '</p>' : '<p>';
  });

  // 2.1 Convert any remaining raw <table> to clean blockquotes (safety net for ProseMirror)
  html = html.replace(/<table\b[\s\S]*?<\/table>/gi, (tableHtml) => {
    const rows = tableHtml.match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
    const formattedRows = rows.map((r) => {
      const cells = r.match(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi) || [];
      const cleanCells = cells.map((c) => c.replace(/<[^>]+>/g, '').trim());
      return cleanCells.join(' | ');
    });
    if (formattedRows.length > 0) {
      return `<blockquote><p><strong>[数据表格]</strong></p><p>${formattedRows.join('<br />')}</p></blockquote>`;
    }
    return '';
  });

  // 3. Strip non-semantic inline tags that ProseMirror has no marks for
  html = html.replace(/<\/?(?:span|font|mark)\b[^>]*>/gi, '');

  // 4. Flatten strikethrough to strong
  html = html.replace(/<del\b[^>]*>([\s\S]*?)<\/del>/gi, '<strong>$1</strong>');
  html = html.replace(/<s\b[^>]*>([\s\S]*?)<\/s>/gi, '<strong>$1</strong>');

  // 5. Flatten inline code to strong, EXCEPT inside our own native terminal boxes where
  //    <code> conveys monospace alignment critical for commands and indented config.
  html = html.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (match, inner) => {
    return inner.includes('&nbsp;') || /<br\s*\/?>/i.test(inner) ? match : `<strong>${inner}</strong>`;
  });

  // 6. Clean up broken paragraph nestings (HTML5 invalid <p><p>)
  html = html.replace(/<p>\s*<p>/gi, '<p>');
  html = html.replace(/<\/p>\s*<\/p>/gi, '</p>');
  html = html.replace(/<p>\s*(?:<br\s*\/?>)?\s*<\/p>/gi, '');

  // 7. Normalize consecutive line breaks
  html = html.replace(/\n{3,}/g, '\n\n');

  return html.trim();
}

/**
 * Generates rich-text HTML compatible with XiaoHeiHe's ProseMirror editor.
 * - Headings normalized strictly to H2 and H3
 * - Code blocks and tables inlined as high-res dark card images (Base64)
 * - Local referenced images inlined as Base64
 * - Safe image token rendering without invalid nested <p>
 * - Strict HTML sanitization ensuring 100% stable, error-free pasting
 */
export function renderHeyBoxRichHtml(
  markdown: string,
  imageBase64Map: Map<string, string>,
  codeBlockBase64List: string[] = []
): string {
  const md = new MarkdownIt({
    html: true,
    breaks: true,
    linkify: false,
  });

  // XiaoHeiHe ProseMirror only supports level 2 & 3 in body
  md.renderer.rules.heading_open = (tokens, idx) => {
    const level = parseInt(tokens[idx].tag.slice(1), 10);
    const targetTag = level <= 2 ? 'h2' : 'h3';
    return `<${targetTag}>`;
  };

  md.renderer.rules.heading_close = (tokens, idx) => {
    const level = parseInt(tokens[idx].tag.slice(1), 10);
    const targetTag = level <= 2 ? 'h2' : 'h3';
    return `</${targetTag}>\n`;
  };

  // Replace images with Base64 when available
  md.renderer.rules.image = (tokens, idx) => {
    const token = tokens[idx];
    const rawSrc = token.attrGet('src') || '';
    const alt = token.content || '';

    let decodedSrc = rawSrc;
    try {
      decodedSrc = decodeURIComponent(rawSrc);
    } catch {}

    let base64Src: string | undefined;
    for (const [key, val] of imageBase64Map.entries()) {
      let decodedKey = key;
      try {
        decodedKey = decodeURIComponent(key);
      } catch {}

      if (
        rawSrc === key ||
        decodedSrc === decodedKey ||
        rawSrc === decodedKey ||
        decodedSrc === key ||
        rawSrc.endsWith(key) ||
        decodedSrc.endsWith(decodedKey) ||
        path.basename(rawSrc) === path.basename(key) ||
        path.basename(decodedSrc) === path.basename(decodedKey)
      ) {
        base64Src = val;
        break;
      }
    }

    const src = base64Src || rawSrc;
    // Return clean <img> without surrounding <p> to avoid nested <p><p><img></p></p>
    return `<img src="${src}" alt="${escapeXml(alt)}" />`;
  };

  let fenceIndex = 0;
  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    const lang = (token.info || 'code').trim().split(/\s+/)[0] || 'code';
    const base64Data = codeBlockBase64List[fenceIndex++] || '';

    if (base64Data) {
      return `<p><img src="${base64Data}" alt="代码块 - ${escapeXml(lang)}" /></p>\n`;
    }

    // Fallback if no card image generated: use semantic blockquote with formatted code
    const safeContent = escapeXml(token.content.trim());
    return `<blockquote><p><strong>[代码块 - ${escapeXml(lang)}]</strong></p><p>${safeContent.replace(/\n/g, '<br />')}</p></blockquote>\n`;
  };

  const rawRendered = md.render(markdown);
  return sanitizeHeyBoxHtml(rawRendered);
}

/**
 * Generates simulated HeyBox dark mode preview HTML with one-click rich text clipboard copy.
 */
export function generateHeyBoxPreviewHtml(params: {
  title: string;
  markdown: string;
  richHtml: string;
  metadata: HeyBoxMetadata;
  coverBuffer?: Buffer;
}): string {
  const { title, markdown, richHtml, metadata, coverBuffer } = params;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeXml(title)} - 小黑盒专属排版预览</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px 16px;
      background: #141416;
      color: #e6e6e6;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      min-height: 100vh;
    }
    .top-actions-wrapper {
      width: 100%;
      max-width: 760px;
      margin-bottom: 16px;
      background: #1e1e24;
      border-radius: 12px;
      padding: 16px 20px;
      border: 1px solid #2d2d38;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    }
    .action-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
      margin-bottom: 14px;
    }
    .mode-badges {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 3px 10px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
    }
    .badge-target {
      background: #272732;
      color: #ff9800;
      border: 1px solid #ff980044;
    }
    .badge-community {
      background: #ff572222;
      color: #ff5722;
      border: 1px solid #ff572266;
    }
    .badge-tag {
      background: #2a2a34;
      color: #9e9ea6;
    }
    .btn-group {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .btn {
      padding: 8px 18px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: bold;
      cursor: pointer;
      border: none;
      transition: all 0.2s ease;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      text-decoration: none;
    }
    .btn-primary {
      background: #ff5722;
      color: #ffffff;
      box-shadow: 0 2px 10px rgba(255, 87, 34, 0.4);
    }
    .btn-primary:hover {
      background: #f4511e;
      transform: translateY(-1px);
    }
    .btn-secondary {
      background: #2b2b36;
      color: #d1d1d6;
      border: 1px solid #3d3d4c;
    }
    .btn-secondary:hover {
      background: #363644;
      color: #fff;
    }
    .tips-banner {
      background: #ff572215;
      border-left: 4px solid #ff5722;
      padding: 10px 14px;
      border-radius: 4px;
      font-size: 12.5px;
      color: #ffbba7;
      line-height: 1.6;
    }
    .tips-banner strong {
      color: #ff7043;
    }
    .title-banner {
      margin-top: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: #25252f;
      padding: 8px 14px;
      border-radius: 6px;
      font-size: 13px;
    }
    .title-banner .title-text {
      color: #fff;
      font-weight: bold;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      margin-right: 12px;
    }
    .btn-copy-small {
      padding: 4px 10px;
      font-size: 11px;
      background: #383848;
      color: #eee;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      white-space: nowrap;
    }
    .btn-copy-small:hover {
      background: #4c4c60;
    }

    /* Main Article Preview Container */
    .container {
      width: 100%;
      max-width: 760px;
      background: #1e1e24;
      border-radius: 12px;
      overflow: hidden;
      border: 1px solid #2d2d38;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    }
    .cover-img {
      width: 100%;
      aspect-ratio: 16/9;
      object-fit: contain;
      display: block;
      background: #141416;
    }
    .article-body {
      padding: 28px 24px 48px;
      line-height: 1.85;
      font-size: 15.5px;
      color: #dedee3;
    }
    .article-body h1 {
      font-size: 24px;
      margin: 0 0 20px 0;
      color: #ffffff;
      line-height: 1.4;
      border-bottom: 1px solid #2d2d38;
      padding-bottom: 14px;
    }
    .article-body h2 {
      font-size: 20px;
      margin: 28px 0 14px 0;
      color: #ffffff;
      border-left: 4px solid #ff5722;
      padding-left: 10px;
      line-height: 1.4;
    }
    .article-body h3 {
      font-size: 17px;
      margin: 22px 0 10px 0;
      color: #ff9800;
      line-height: 1.4;
    }
    .article-body p {
      margin: 14px 0;
    }
    .article-body blockquote {
      margin: 16px 0;
      padding: 12px 16px;
      background: #252530;
      border-left: 4px solid #ff5722;
      border-radius: 0 8px 8px 0;
      color: #bbb;
      font-size: 14.5px;
    }
    .article-body blockquote p {
      margin: 4px 0;
    }
    .article-body ul, .article-body ol {
      padding-left: 22px;
      margin: 14px 0;
    }
    .article-body li {
      margin: 6px 0;
    }
    .article-body img {
      max-width: 100%;
      height: auto;
      border-radius: 8px;
      margin: 16px 0;
      display: block;
      box-shadow: 0 4px 16px rgba(0,0,0,0.3);
    }
    .article-body code {
      background: #292934;
      padding: 2px 6px;
      border-radius: 4px;
      color: #ff9800;
      font-family: Menlo, Consolas, monospace;
      font-size: 13.5px;
    }
    .article-body a {
      color: #ff7043;
      text-decoration: none;
    }
    .article-body a:hover {
      text-decoration: underline;
    }

    /* Toast Notification */
    #toast {
      position: fixed;
      bottom: 30px;
      left: 50%;
      transform: translateX(-50%) translateY(100px);
      background: #ff5722;
      color: #fff;
      padding: 12px 24px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: bold;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
      opacity: 0;
      transition: all 0.3s cubic-bezier(0.18, 0.89, 0.32, 1.28);
      z-index: 9999;
      pointer-events: none;
    }
    #toast.show {
      transform: translateX(-50%) translateY(0);
      opacity: 1;
    }
  </style>
</head>
<body>

  <!-- Top Action Box -->
  <div class="top-actions-wrapper">
    <div class="action-header">
      <div class="mode-badges">
        <span class="badge badge-target">📌 目标: 发布文章 (article)</span>
        ${
          metadata.community
            ? `<span class="badge badge-community">🎮 ${escapeXml(metadata.community)}</span>`
            : `<span class="badge badge-community">📝 草稿模式 (发布时后台选专区/话题)</span>`
        }
        ${metadata.hashtags.map((h) => `<span class="badge badge-tag">#${escapeXml(h)}#</span>`).join(' ')}
      </div>
      <div class="btn-group">
        <button class="btn btn-primary" onclick="copyRichText()">
          📋 一键复制小黑盒富文本
        </button>
        <button class="btn btn-secondary" onclick="copyMarkdownText()">
          📄 复制 Markdown
        </button>
        <a class="btn btn-secondary" href="https://www.xiaoheihe.cn/creator/editor/draft/article/new" target="_blank" rel="noreferrer">
          ↗ 打开小黑盒发帖
        </a>
      </div>
    </div>

    <div class="tips-banner">
      💡 <strong>排版导入秘籍</strong>：
      1. 点击上方【一键复制小黑盒富文本】；
      2. 打开小黑盒后台选择<strong>「发布文章」</strong>模式（切勿选“发布图文”）；
      3. 在正文编辑区直接 <strong>Ctrl + V</strong> 粘贴，标题、正文、列表与高清深色代码图将自动排版并就位！
    </div>

    <div class="title-banner">
      <span class="title-text">文章标题: ${escapeXml(title)}</span>
      <button class="btn-copy-small" onclick="copyTitle()">复制标题</button>
    </div>
  </div>

  <!-- Simulated Article Container -->
  <div class="container">
    ${
      coverBuffer
        ? `<img class="cover-img" src="data:image/jpeg;base64,${coverBuffer.toString(
            'base64'
          )}" alt="16:9 封面" />`
        : ''
    }
    <div class="article-body">
      <h1>${escapeXml(title)}</h1>
      <div id="rich-content">
        ${richHtml}
      </div>
    </div>
  </div>

  <div id="toast"></div>

  <script>
    function showToast(msg) {
      const toast = document.getElementById('toast');
      toast.innerText = msg;
      toast.className = 'show';
      setTimeout(() => {
        toast.className = '';
      }, 3500);
    }

    async function copyRichText() {
      const container = document.getElementById('rich-content');
      const htmlContent = container.innerHTML;
      const plainContent = container.innerText;

      if (navigator.clipboard && window.ClipboardItem) {
        try {
          const blobHtml = new Blob([htmlContent], { type: 'text/html' });
          const blobText = new Blob([plainContent], { type: 'text/plain' });
          const item = new ClipboardItem({
            'text/html': blobHtml,
            'text/plain': blobText,
          });
          await navigator.clipboard.write([item]);
          showToast('✓ 小黑盒富文本已成功复制！请去「发布文章」编辑区 Ctrl+V 粘贴。');
          return;
        } catch (err) {
          console.warn('ClipboardItem failed, fallback to selection range:', err);
        }
      }

      // Fallback selection range
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(container);
      selection.removeAllRanges();
      selection.addRange(range);
      try {
        document.execCommand('copy');
        selection.removeAllRanges();
        showToast('✓ 富文本已通过选区复制！请在小黑盒「发布文章」编辑区直接粘贴。');
      } catch (err) {
        alert('复制失败，请手动全选页面正文进行复制。');
      }
    }

    function copyMarkdownText() {
      const text = ${JSON.stringify(markdown)};
      navigator.clipboard.writeText(text).then(() => {
        showToast('✓ Markdown 文本已复制到剪贴板！');
      });
    }

    function copyTitle() {
      const title = ${JSON.stringify(title)};
      navigator.clipboard.writeText(title).then(() => {
        showToast('✓ 文章标题已复制！');
      });
    }
  </script>
</body>
</html>`;
}

/**
 * Prepares a blog post into a standardized XiaoHeiHe (HeyBox) publishing bundle.
 * 1. Code blocks are automatically converted into PNG image cards and inlined as Base64.
 * 2. 16:9 Cover is cropped.
 * 3. Video embeds are turned into text prompts.
 * 4. External links and footnotes are converted gracefully.
 * 5. A simulated HeyBox preview HTML page with one-click rich text copy is generated.
 */
export async function prepareHeyBoxArticle(
  article: HeyBoxArticleInput,
  options: HeyBoxPrepareOptions = {}
): Promise<HeyBoxPreparedResult> {
  const { title } = normalizeHeyBoxTitle(article.title);
  const metadata = inferHeyBoxMetadata(article.frontmatter || {}, article.title);
  const assets = new Map<string, Buffer>();
  const imageBase64Map = new Map<string, string>();

  // 1. Process 16:9 Cover
  // Resolution order: frontmatter image/cover -> configured defaultCover.
  // We intentionally do NOT guess a cover from the first sibling screenshot: that produced
  // unpredictable, ugly covers taken from arbitrary in-article images.
  let coverBuffer: Buffer | undefined;
  let coverSourcePath: string | null = null;
  const assetRoots = options.assetRoots || ['{postDir}'];

  if (article.coverRaw) {
    coverSourcePath = resolveLocalAsset(article.coverRaw, article.postDir, assetRoots);
  }
  if (!coverSourcePath && options.defaultCoverPath) {
    const repoRoot = findGitRoot(article.postDir || process.cwd());
    const expanded = options.defaultCoverPath.replace(/\{repoRoot\}/g, repoRoot || '');
    if (expanded && fs.existsSync(expanded)) {
      coverSourcePath = expanded;
    }
  }

  if (coverSourcePath && fs.existsSync(coverSourcePath)) {
    try {
      coverBuffer = await crop16x9Cover(coverSourcePath);
      assets.set('cover_16_9.jpg', coverBuffer);
      const coverB64 = `data:image/jpeg;base64,${coverBuffer.toString('base64')}`;
      imageBase64Map.set('cover_16_9.jpg', coverB64);
      imageBase64Map.set('./cover_16_9.jpg', coverB64);
      imageBase64Map.set('assets/cover_16_9.jpg', coverB64);
      imageBase64Map.set('./assets/cover_16_9.jpg', coverB64);
    } catch (err: any) {
      console.warn(`[HeyBox] 16:9 封面裁剪失败: ${err.message}`);
    }
  }

  // 2. Transform Markdown body
  let transformedMd = article.bodyMarkdown;

  // XiaoHeiHe articles have no dedicated cover field, so the 16:9 cover must live at the top
  // of the body for readers (and the platform cover picker) to see it.
  if (coverBuffer) {
    transformedMd = `![封面](assets/cover_16_9.jpg)\n\n${transformedMd}`;
  }

  // Normalize multi-line iframes to video notes
  transformedMd = transformedMd.replace(/<iframe\b[\s\S]*?<\/iframe>/gi, () => {
    return `\n> 📺 **视频演示提示**：此处包含嵌入视频，请在小黑盒工具栏点击「视频」并粘贴 B 站视频嵌入代码，或前往原文链接查看高清演示。\n`;
  });

  // 2.2 Process fenced code blocks
  // Strategy:
  // - 'auto': Short commands & config snippets (<= 6 lines or terminal/shell/config) render as
  //   clean native terminal code boxes (100% selectable, copyable, zero-scaling issues).
  //   Long complex programs (> 6 lines) render as Retina dark-mode card images.
  // - 'terminal': All code blocks render as native copyable terminal boxes (zero images).
  // - 'image': All code blocks render as Retina image cards.
  const codeFenceRegex = /^(\s*)(```+|~~~+)([^\n]*)\n([\s\S]*?)\n\s*\2/gm;
  const codeMatches: Array<{
    start: number;
    end: number;
    raw: string;
    lang: string;
    content: string;
  }> = [];

  for (const m of transformedMd.matchAll(codeFenceRegex)) {
    codeMatches.push({
      start: m.index!,
      end: m.index! + m[0].length,
      raw: m[0],
      lang: (m[3] || 'code').trim().split(/\s+/)[0] || 'code',
      content: m[4],
    });
  }

  const codeMode = options.codeBlockMode || 'auto';
  let codeIndex = 0;
  const codeBlockBase64List: string[] = [];
  const codeReplacements: Array<{ start: number; end: number; replacement: string }> = [];

  for (const cm of codeMatches) {
    const isCmd = isCommandLineSnippet(cm.content, cm.lang);
    const useNativeTerminal = codeMode === 'terminal' || (codeMode === 'auto' && isCmd);

    if (useNativeTerminal) {
      codeReplacements.push({
        start: cm.start,
        end: cm.end,
        replacement: formatCodeAsNativeTerminalBox(cm.content, cm.lang),
      });
      continue;
    }

    codeIndex++;
    const safeLang = cm.lang.replace(/[^a-zA-Z0-9_-]/g, '') || 'code';
    const imgFileName = `assets/code_${codeIndex}_${safeLang}.png`;
    try {
      const codeImgBuf = await renderCodeBlockToImage(cm.content, cm.lang);
      assets.set(imgFileName, codeImgBuf);
      const base64Data = `data:image/png;base64,${codeImgBuf.toString('base64')}`;
      codeBlockBase64List.push(base64Data);
      imageBase64Map.set(imgFileName, base64Data);
      imageBase64Map.set(`./${imgFileName}`, base64Data);

      codeReplacements.push({
        start: cm.start,
        end: cm.end,
        replacement: `\n![代码块 - ${cm.lang}](${imgFileName})\n`,
      });
    } catch (err: any) {
      console.warn(`[HeyBox] 代码块转图失败，使用原生终端块降级: ${err.message}`);
      codeReplacements.push({
        start: cm.start,
        end: cm.end,
        replacement: formatCodeAsNativeTerminalBox(cm.content, cm.lang),
      });
    }
  }

  // Mask code blocks in reverse index order so subsequent inline transformations (math $...$, inline code `...`) never corrupt code
  for (let i = codeMatches.length - 1; i >= 0; i--) {
    const cm = codeMatches[i];
    transformedMd =
      transformedMd.slice(0, cm.start) + `\u0000HEYBOX_CODE_${i}\u0000` + transformedMd.slice(cm.end);
  }

  // 2.3 Convert Markdown tables to PNG images or fallback blockquotes
  // XiaoHeiHe ProseMirror does NOT support HTML <table> nodes; tables must be converted to images or text
  const tableRegex = /^(\s*\|[^\n]+\|\r?\n\s*\|[\s:\-|]+\|\r?\n(?:\s*\|[^\n]+\|\r?\n?)*)/gm;
  const tableMatches: Array<{ start: number; end: number; raw: string }> = [];

  for (const tm of transformedMd.matchAll(tableRegex)) {
    tableMatches.push({
      start: tm.index!,
      end: tm.index! + tm[0].length,
      raw: tm[0],
    });
  }

  let tableIndex = 0;
  const tableReplacements: Array<{ start: number; end: number; replacement: string }> = [];

  for (const tm of tableMatches) {
    tableIndex++;
    const parsed = parseMarkdownTable(tm.raw);
    if (!parsed) continue;

    const tableImgFileName = `assets/table_${tableIndex}.png`;
    try {
      const tableImgBuf = await renderTableToImage(parsed);
      assets.set(tableImgFileName, tableImgBuf);
      const base64Data = `data:image/png;base64,${tableImgBuf.toString('base64')}`;
      imageBase64Map.set(tableImgFileName, base64Data);
      imageBase64Map.set(`./${tableImgFileName}`, base64Data);

      tableReplacements.push({
        start: tm.start,
        end: tm.end,
        replacement: `\n![数据表格](${tableImgFileName})\n`,
      });
    } catch (err: any) {
      console.warn(`[HeyBox] 表格转图失败，使用文本降级: ${err.message}`);
      tableReplacements.push({
        start: tm.start,
        end: tm.end,
        replacement: formatTableAsFallbackText(parsed),
      });
    }
  }

  // Replace tables in reverse index order
  for (let i = tableReplacements.length - 1; i >= 0; i--) {
    const rep = tableReplacements[i];
    transformedMd =
      transformedMd.slice(0, rep.start) + rep.replacement + transformedMd.slice(rep.end);
  }

  // 2.4 External links normalization:
  // Convert [text](url) -> **text**（url） if url is NOT a XiaoHeiHe internal link
  transformedMd = transformedMd.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (match, text, url) => {
      if (/https?:\/\/(?:www\.)?xiaoheihe\.cn/i.test(url)) {
        return match;
      }
      return `**${text.trim()}**（${url.trim()}）`;
    }
  );

  // 2.5 Inline code normalization: `code` -> **code**
  transformedMd = transformedMd.replace(/`([^`\n]+)`/g, '**$1**');

  // 2.6 Strikethrough normalization: ~~text~~ -> **text**
  transformedMd = transformedMd.replace(/~~([^~]+)~~/g, '**$1**');

  // 2.7 Task list normalization: [ ] -> ☐, [x] -> ☑
  transformedMd = transformedMd.replace(/^(\s*[-*+]\s+)\[ \]\s+/gm, '$1☐ ');
  transformedMd = transformedMd.replace(/^(\s*[-*+]\s+)\[[xX]\]\s+/gm, '$1☑ ');

  // 2.8 Math formula normalization:
  // Block formula $$...$$ -> blockquote
  transformedMd = transformedMd.replace(
    /\$\$([\s\S]*?)\$\$/g,
    (_m, formula) => `\n> 📐 **公式**：${formula.trim()}\n`
  );
  // Inline formula $...$ -> *formula*
  transformedMd = transformedMd.replace(/\$([^\$\n]+)\$/g, '*$1*');

  // 2.9 Restore masked code blocks with their final replacements (native terminal box or image tag)
  transformedMd = transformedMd.replace(/\u0000HEYBOX_CODE_(\d+)\u0000/g, (_m, idxStr) => {
    return codeReplacements[Number(idxStr)]?.replacement || '';
  });

  // Copy local images referenced in markdown into assets/ and record Base64 data URLs
  if (article.localAssetPaths) {
    for (const localAsset of article.localAssetPaths) {
      const filename = path.basename(localAsset);
      try {
        const buf = fs.readFileSync(localAsset);
        assets.set(`assets/${filename}`, buf);
        const mime = getMimeType(localAsset);
        const b64 = `data:${mime};base64,${buf.toString('base64')}`;
        const encName = encodeURIComponent(filename);

        imageBase64Map.set(localAsset, b64);
        imageBase64Map.set(filename, b64);
        imageBase64Map.set(`./${filename}`, b64);
        imageBase64Map.set(`assets/${filename}`, b64);
        imageBase64Map.set(`./assets/${filename}`, b64);

        imageBase64Map.set(encName, b64);
        imageBase64Map.set(`./${encName}`, b64);
        imageBase64Map.set(`assets/${encName}`, b64);
        imageBase64Map.set(`./assets/${encName}`, b64);
      } catch {}
    }
  }

  // Append XiaoHeiHe engagement footer card
  const hashtagText = metadata.hashtags.map((h) => `#${h}#`).join(' ');
  const engagementCard = `\n\n---\n> 🎮 **小黑盒专栏** · 本文同步自个人技术博客 [${article.canonicalUrl}](${article.canonicalUrl})。\n> 盒友们如果觉得这篇教程有用，欢迎点赞、收藏与免费充电！遇到任何配置问题欢迎在评论区交流讨论～\n\n${hashtagText ? `${hashtagText}\n` : ''}`;
  transformedMd += engagementCard;

  // 3. Render Rich HTML (with inlined Base64 images and H2/H3 mapping)
  const richHtml = renderHeyBoxRichHtml(transformedMd, imageBase64Map, codeBlockBase64List);

  // 4. Generate Simulated HeyBox Preview HTML
  // The local preview already renders the cover as a 16:9 banner, so drop the duplicated
  // leading cover image from the simulated body to avoid showing it twice.
  const COVER_PREFIX = '![封面](assets/cover_16_9.jpg)\n\n';
  const previewMarkdown =
    coverBuffer && transformedMd.startsWith(COVER_PREFIX)
      ? transformedMd.slice(COVER_PREFIX.length)
      : transformedMd;
  const previewRichHtml =
    previewMarkdown === transformedMd
      ? richHtml
      : renderHeyBoxRichHtml(previewMarkdown, imageBase64Map, []);

  const previewHtml = generateHeyBoxPreviewHtml({
    title,
    markdown: previewMarkdown,
    richHtml: previewRichHtml,
    metadata,
    coverBuffer,
  });

  return {
    article,
    title,
    markdown: transformedMd,
    richHtml,
    coverBuffer,
    assets,
    metadata,
    previewHtml,
  };
}
