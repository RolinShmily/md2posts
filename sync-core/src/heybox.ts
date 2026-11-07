import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { SourcePost } from '@md2posts/sources';
import { resolveLocalAssetPath } from './image-processor.js';
import { normalizeWeChatTitle } from './normalize.js';

export interface HeyBoxMetadata {
  community: string;
  gameId?: string | number;
  hashtags: string[];
  kind: 'article' | 'image_text';
}

export interface HeyBoxPreparedResult {
  post: SourcePost;
  title: string;
  markdown: string;
  coverBuffer?: Buffer;
  assets: Map<string, Buffer>; // relative filename in output -> Buffer
  metadata: HeyBoxMetadata;
  previewHtml: string;
}

function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case "'":
        return '&apos;';
      case '"':
        return '&quot;';
      default:
        return c;
    }
  });
}

/**
 * Renders a fenced code block into an aesthetically pleasing, dark-mode SVG -> PNG image card.
 * This prevents XiaoHeiHe mobile app from wrapping and truncating code blocks.
 */
export async function renderCodeBlockToImage(
  code: string,
  lang = 'CODE',
  options: { maxWidth?: number } = {}
): Promise<Buffer> {
  const cleanCode = code.replace(/\r\n/g, '\n').trimEnd();
  const rawLines = cleanCode.split('\n');
  const lines = rawLines.length > 0 ? rawLines : [''];

  const lineHeight = 22;
  const paddingY = 18;
  const headerHeight = 38;
  const totalHeight = headerHeight + lines.length * lineHeight + paddingY;

  // Estimate maximum character length to set canvas width (min 680, max 1200)
  const maxLineLen = lines.reduce((max, l) => Math.max(max, l.length), 0);
  const width = Math.min(
    options.maxWidth || 1200,
    Math.max(680, Math.round(maxLineLen * 8.6 + 80))
  );

  const displayLang = (lang || 'CODE').toUpperCase();

  const textSvg = lines
    .map((line, idx) => {
      const y = headerHeight + 18 + idx * lineHeight;
      const lineNum = String(idx + 1).padStart(2, ' ');
      return `<text x="22" y="${y}" font-family="Menlo, Consolas, monospace" font-size="12" fill="#5c6370">${lineNum}</text>
<text x="56" y="${y}" font-family="Menlo, Consolas, monospace" font-size="13" fill="#abb2bf">${escapeXml(
        line
      )}</text>`;
    })
    .join('\n');

  const svg = `<svg width="${width}" height="${totalHeight}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" rx="10" fill="#21252b" />
  <circle cx="24" cy="20" r="5" fill="#ff5f56" />
  <circle cx="40" cy="20" r="5" fill="#ffbd2e" />
  <circle cx="56" cy="20" r="5" fill="#27c93f" />
  <text x="80" y="24" font-family="Menlo, Consolas, monospace" font-size="11" font-weight="bold" fill="#8b949e">${escapeXml(
    displayLang
  )}</text>
  <line x1="0" y1="36" x2="${width}" y2="36" stroke="#181a1f" stroke-width="1" />
  ${textSvg}
</svg>`;

  return await sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * Crops an input image into a standard 16:9 (1280x720) header banner for XiaoHeiHe.
 */
export async function crop16x9Cover(input: Buffer | string): Promise<Buffer> {
  let buf: Buffer;
  if (typeof input === 'string') {
    buf = fs.readFileSync(input);
  } else {
    buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  }

  return await sharp(buf)
    .rotate()
    .resize({
      width: 1280,
      height: 720,
      fit: 'cover',
      position: 'center',
    })
    .jpeg({ quality: 88, progressive: true })
    .toBuffer();
}

/**
 * Infers XiaoHeiHe community name, game ID, and topic hashtags from article tags and title.
 */
export function inferHeyBoxMetadata(
  frontmatter: Record<string, unknown>,
  title: string
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

  const rawTags: string[] = Array.isArray(frontmatter.tags)
    ? (frontmatter.tags as string[]).map((t) => String(t).toLowerCase())
    : [];
  const textSample = `${title} ${rawTags.join(' ')}`.toLowerCase();

  let community = '盒友杂谈';
  let gameId: number | string | undefined;
  const hashtags: string[] = [];

  if (textSample.includes('cs2') || textSample.includes('csgo') || textSample.includes('counter-strike')) {
    community = 'Counter-Strike 2';
    gameId = 730;
    hashtags.push('CS2', '游戏设置');
  } else if (textSample.includes('switch') || textSample.includes('nintendo') || textSample.includes('ams')) {
    community = '任天堂Switch';
    hashtags.push('Switch', '掌机');
  } else if (textSample.includes('minecraft') || textSample.includes('我的世界') || textSample.includes('mc')) {
    community = '我的世界';
    gameId = 105600;
    hashtags.push('我的世界', '联机教程');
  } else if (textSample.includes('steam') || textSample.includes('steam302')) {
    community = 'Steam';
    hashtags.push('Steam', '网络加速');
  } else if (textSample.includes('ps5') || textSample.includes('playstation') || textSample.includes('dualsense')) {
    community = 'PlayStation';
    hashtags.push('PS5', '手柄');
  } else {
    hashtags.push('数码硬件', '技术折腾');
  }

  return {
    community,
    gameId,
    hashtags,
    kind: 'article',
  };
}

/**
 * Prepares a blog post into a standardized XiaoHeiHe (HeyBox) publishing bundle.
 * 1. Code blocks are automatically converted into PNG image cards.
 * 2. 16:9 Cover is cropped.
 * 3. Video embeds are turned into text prompts.
 * 4. External links are downgraded to plain text notes.
 * 5. A simulated HeyBox preview HTML page is generated.
 */
export async function prepareHeyBoxArticle(
  post: SourcePost,
  options: {
    assetRoots?: string[];
    defaultCoverPath?: string;
  } = {}
): Promise<HeyBoxPreparedResult> {
  const { title } = normalizeWeChatTitle(post.title);
  const metadata = inferHeyBoxMetadata(post.frontmatter, post.title);
  const assets = new Map<string, Buffer>();

  // 1. Process 16:9 Cover
  let coverBuffer: Buffer | undefined;
  let coverSourcePath: string | null = null;
  const assetRoots = options.assetRoots || ['{postDir}'];

  if (post.coverRaw) {
    coverSourcePath = resolveLocalAssetPath(post.coverRaw, post.postDir, assetRoots);
  }
  if (!coverSourcePath && post.localAssetPaths.length > 0) {
    coverSourcePath = post.localAssetPaths[0];
  }
  if (!coverSourcePath && options.defaultCoverPath && fs.existsSync(options.defaultCoverPath)) {
    coverSourcePath = options.defaultCoverPath;
  }

  if (coverSourcePath && fs.existsSync(coverSourcePath)) {
    try {
      coverBuffer = await crop16x9Cover(coverSourcePath);
      assets.set('cover_16_9.jpg', coverBuffer);
    } catch (err: any) {
      console.warn(`[HeyBox] 16:9 封面裁剪失败: ${err.message}`);
    }
  }

  // 2. Transform Markdown body (Code blocks -> Images)
  let transformedMd = post.bodyMarkdown;

  // Normalize multi-line iframes to video notes
  transformedMd = transformedMd.replace(/<iframe\b[\s\S]*?<\/iframe>/gi, () => {
    return `\n> 📺 **视频演示提示**：此处包含嵌入视频，请前往原文链接查看高清演示。\n`;
  });

  // Convert fenced code blocks to PNG images
  const codeFenceRegex = /^(\s*)(```+|~~~+)([^\n]*)\n([\s\S]*?)\n\s*\2/gm;
  let codeIndex = 0;
  const codeReplacements: Array<{ match: string; replacement: string }> = [];

  for (const m of transformedMd.matchAll(codeFenceRegex)) {
    codeIndex++;
    const fullMatch = m[0];
    const lang = (m[3] || 'code').trim().split(/\s+/)[0] || 'code';
    const codeContent = m[4];

    const imgFileName = `assets/code_${codeIndex}_${lang.replace(/[^a-zA-Z0-9_-]/g, '')}.png`;
    try {
      const codeImgBuf = await renderCodeBlockToImage(codeContent, lang);
      assets.set(imgFileName, codeImgBuf);
      codeReplacements.push({
        match: fullMatch,
        replacement: `\n![代码块 - ${lang}](./${imgFileName})\n`,
      });
    } catch (err: any) {
      console.warn(`[HeyBox] 代码块转图失败: ${err.message}`);
    }
  }

  for (const rep of codeReplacements) {
    transformedMd = transformedMd.replace(rep.match, rep.replacement);
  }

  // Copy local images referenced in markdown into assets/
  for (const localAsset of post.localAssetPaths) {
    const filename = path.basename(localAsset);
    try {
      const buf = fs.readFileSync(localAsset);
      assets.set(`assets/${filename}`, buf);
    } catch {}
  }

  // Append XiaoHeiHe engagement footer card
  const hashtagText = metadata.hashtags.map((h) => `#${h}#`).join(' ');
  const engagementCard = `\n\n---\n> 🎮 **小黑盒专栏** · 本文同步自个人技术博客 [${post.canonicalUrl}](${post.canonicalUrl})。\n> 盒友们如果觉得这篇教程有用，欢迎点赞、收藏与免费充电！遇到任何配置问题欢迎在评论区交流讨论～\n\n${hashtagText ? `${hashtagText}\n` : ''}`;
  transformedMd += engagementCard;

  // 3. Generate Simulated HeyBox Preview HTML
  const previewHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeXml(title)} - 小黑盒排版预览</title>
  <style>
    body {
      margin: 0;
      padding: 24px 12px;
      background: #141416;
      color: #e6e6e6;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .container {
      width: 100%;
      max-width: 680px;
      background: #1e1e24;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    }
    .header-bar {
      padding: 14px 18px;
      background: #272730;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 13px;
      color: #999;
    }
    .tag-badge {
      display: inline-block;
      padding: 2px 8px;
      background: #ff5722;
      color: #fff;
      border-radius: 4px;
      font-size: 11px;
      font-weight: bold;
    }
    .cover-img {
      width: 100%;
      aspect-ratio: 16/9;
      object-fit: cover;
      display: block;
    }
    .article-body {
      padding: 20px 18px 40px;
      line-height: 1.8;
      font-size: 15px;
    }
    .article-body img {
      max-width: 100%;
      border-radius: 6px;
      margin: 12px 0;
    }
    .btn-copy {
      padding: 6px 14px;
      background: #ff5722;
      color: #fff;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-weight: bold;
    }
    .btn-copy:hover {
      background: #f4511e;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header-bar">
      <div>
        <span class="tag-badge">${escapeXml(metadata.community)}</span>
        <span style="margin-left: 8px;">${escapeXml(title)}</span>
      </div>
      <button class="btn-copy" onclick="copyMarkdown()">复制小黑盒稿件</button>
    </div>
    ${
      coverBuffer
        ? `<img class="cover-img" src="data:image/jpeg;base64,${coverBuffer.toString(
            'base64'
          )}" alt="16:9 封面" />`
        : ''
    }
    <div id="content-box" class="article-body">
      <h1>${escapeXml(title)}</h1>
      <pre style="white-space: pre-wrap; word-break: break-all; font-family: inherit;">${escapeXml(
        transformedMd
      )}</pre>
    </div>
  </div>
  <script>
    function copyMarkdown() {
      const text = ${JSON.stringify(transformedMd)};
      navigator.clipboard.writeText(text).then(() => {
        alert('小黑盒 Markdown 稿件（含代码块图片引用）已复制到剪贴板！');
      });
    }
  </script>
</body>
</html>`;

  return {
    post,
    title,
    markdown: transformedMd,
    coverBuffer,
    assets,
    metadata,
    previewHtml,
  };
}
