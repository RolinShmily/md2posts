import MarkdownIt from 'markdown-it';

export interface PreprocessOptions {
  siteUrl?: string;               // e.g. "https://blog.srprolin.com"
  postCanonicalUrl?: string;      // e.g. "https://blog.srprolin.com/posts/45-immortalwrt-1/"
  shiftBodyHeadings?: boolean;   // default true (h1 -> h2, h2 -> h3, etc.)
  imageCaptionMode?: 'smart' | 'none' | 'all'; // default 'smart'
  convertTaskLists?: boolean;    // default true ([ ] -> ☐, [x] -> ☑)
  protectMath?: boolean;         // default true (escape _ and * inside $...$)
  stripHtmlComments?: boolean;   // default true
}

export interface PreprocessWarning {
  type: 'math_detected' | 'raw_html_detected' | 'unresolvable_link';
  line?: number;
  detail: string;
}

export interface PreprocessResult {
  markdown: string;
  imageRefs: string[];
  warnings: PreprocessWarning[];
}

const GENERIC_ALT_PATTERNS = [
  /^\d+$/,                                           // "1", "2", "0"
  /^alt\s*text$/i,                                   // "alt text"
  /^(image|img|pic|photo|cover|封面|截图|图片|示意图)$/i,
  /^image-\d+$/i,
  /^(屏幕截图|Snipaste|PixPin|screenshot)[\s_\d-].*$/i,
  /^.*\.(png|jpe?g|webp|gif|svg)$/i,                 // "2024_06_22-6.png"
  /^[a-zA-Z0-9_-]{1,16}$/,                           // short identifiers like "features", "gpedit-1", "pan-2", "settings1"
];

export function isGenericAltText(alt: string): boolean {
  const trimmed = alt.trim();
  if (!trimmed) return true;
  return GENERIC_ALT_PATTERNS.some((pat) => pat.test(trimmed));
}

const parserMd = new MarkdownIt({ html: true, linkify: true, breaks: true });

/**
 * Masks inline code spans (`...`, ``...``) in a non-code block string so inline transformations
 * never mutate content inside backticks.
 */
function maskInlineCode(segment: string): {
  masked: string;
  restore: (text: string) => string;
} {
  const spans: string[] = [];
  const masked = segment.replace(/(`+)([\s\S]*?)\1/g, (match) => {
    const idx = spans.length;
    spans.push(match);
    return `\u0000INLINECODE_${idx}\u0000`;
  });

  return {
    masked,
    restore: (text: string) =>
      text.replace(/\u0000INLINECODE_(\d+)\u0000/g, (_m, idxStr) => spans[Number(idxStr)] ?? ''),
  };
}

/**
 * Preprocesses raw markdown body before feeding it to md-wechat renderer:
 * 1. Strips frontmatter (if present)
 * 2. Uses markdown-it AST (`md.parse`) to identify exact line ranges of `fence` and `code_block` tokens,
 *    guaranteeing code blocks are 100% untouched.
 * 3. In non-code segments, masks inline code spans (`...`) and transforms:
 *    - HTML comments (`<!-- -->`)
 *    - Multi-line video `<iframe>` -> single-line video placeholder format (with https:// upgrade)
 *    - HTML `<img ...>` -> Markdown `![alt](src)`
 *    - Multi-line `$$...$$` and inline `$...$` math formulas (protects `_` and `*` from emphasis corruption)
 *    - Heading shift (`h1 -> h2`, etc.)
 *    - Task lists (`- [ ]` -> `- ☐`, `- [x]` -> `- ☑`)
 *    - Image alt caption cleaning (`![alt](url)` and `![alt][ref]`)
 *    - Relative & anchor link normalization
 *    - Unhandled raw HTML warnings
 * 4. Traverses the final `markdown-it` token tree to collect all resolved `image` URLs (including reference-style `![alt][ref]`).
 */
export function preprocessMarkdown(
  input: string,
  options: PreprocessOptions = {}
): PreprocessResult {
  const {
    siteUrl = 'https://blog.srprolin.com',
    postCanonicalUrl = '',
    shiftBodyHeadings = true,
    imageCaptionMode = 'smart',
    convertTaskLists = true,
    protectMath = true,
    stripHtmlComments = true,
  } = options;

  const warnings: PreprocessWarning[] = [];

  // 1. Strip YAML frontmatter if present
  let text = input;
  const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (fmMatch) {
    text = fmMatch[2];
  }

  // Normalize line endings to LF
  const lines = text.replace(/\r\n/g, '\n').split('\n');

  // 2. Parse block tokens via markdown-it to locate exact code block line intervals [start, end)
  const initialTokens = parserMd.parse(lines.join('\n'), {});
  const codeLineFlags = new Uint8Array(lines.length);
  for (const token of initialTokens) {
    if ((token.type === 'fence' || token.type === 'code_block') && token.map) {
      const [start, end] = token.map;
      for (let i = Math.max(0, start); i < Math.min(lines.length, end); i++) {
        codeLineFlags[i] = 1;
      }
    }
  }

  // Group contiguous lines into code vs non-code chunks
  interface LineChunk {
    isCode: boolean;
    startLine: number; // 1-based line number
    lines: string[];
  }

  const chunks: LineChunk[] = [];
  for (let i = 0; i < lines.length; i++) {
    const isCode = codeLineFlags[i] === 1;
    const prev = chunks[chunks.length - 1];
    if (prev && prev.isCode === isCode) {
      prev.lines.push(lines[i]);
    } else {
      chunks.push({
        isCode,
        startLine: i + 1,
        lines: [lines[i]],
      });
    }
  }

  // 3. Transform only non-code chunks
  const outputChunks: string[] = [];
  const gfmFootnotes = new Map<string, string>();
  const gfmFootnoteOrder: string[] = [];

  // Pre-scan non-code chunks for GFM footnote definitions: [^id]: content
  for (const chunk of chunks) {
    if (chunk.isCode) continue;
    for (const line of chunk.lines) {
      const defMatch = line.match(/^\[\^([^\]]+)\]:\s*(.+)$/);
      if (defMatch) {
        gfmFootnotes.set(defMatch[1].trim(), defMatch[2].trim());
      }
    }
  }

  for (const chunk of chunks) {
    if (chunk.isCode) {
      outputChunks.push(chunk.lines.join('\n'));
      continue;
    }

    const rawSegment = chunk.lines.join('\n');
    const { masked, restore } = maskInlineCode(rawSegment);
    let seg = masked;

    // 3a. Strip HTML comments
    if (stripHtmlComments) {
      seg = seg.replace(/<!--[\s\S]*?-->/g, '');
    }

    // 3b. Compress multi-line <iframe> into single-line and normalize protocol-relative src="//..."
    seg = seg.replace(/<iframe\b([\s\S]*?)<\/iframe>/gi, (_match, inner) => {
      const flattened = `<iframe ${inner.replace(/\s+/g, ' ').trim()}></iframe>`;
      return flattened.replace(/\bsrc=["']\/\/([^"']+)["']/i, 'src="https://$1"');
    });

    // 3c. Convert HTML <img ...> to Markdown ![alt](src)
    seg = seg.replace(/<img\b([^>]*?)>/gi, (_match, attrs) => {
      const srcMatch = attrs.match(/\bsrc=["']([^"']+)["']/i);
      const altMatch = attrs.match(/\balt=["']([^"']*)["']/i);
      const src = srcMatch ? srcMatch[1].trim() : '';
      const alt = altMatch ? altMatch[1].trim() : '';
      if (src) {
        return `![${alt}](${src})`;
      }
      return '';
    });

    // 3d. Protect multi-line display math $$...$$
    if (protectMath && seg.includes('$$')) {
      seg = seg.replace(/\$\$([\s\S]+?)\$\$/g, (fullMatch, innerMath, offset) => {
        const lineOffset = seg.slice(0, offset).split('\n').length - 1;
        const cleanSnippet = innerMath.replace(/\s+/g, ' ').trim().slice(0, 60);
        warnings.push({
          type: 'math_detected',
          line: chunk.startLine + lineOffset,
          detail: `检测到块级数学公式: $$${cleanSnippet}$$`,
        });
        return `$$${innerMath.replace(/_/g, '\\_').replace(/\*/g, '\\*')}$$`;
      });
    }

    // 3e. Line-by-line processing on non-code segment
    const segLines = seg.split('\n');
    const processedSegLines: string[] = [];

    for (let i = 0; i < segLines.length; i++) {
      let line = segLines[i];
      const lineNo = chunk.startLine + i;

      // Skip GFM footnote definition lines (they will be appended at the bottom)
      if (/^\[\^([^\]]+)\]:\s*(.+)$/.test(line)) {
        continue;
      }

      // Replace inline GFM footnote references [^id] with numbered markers [注N]
      if (gfmFootnotes.size > 0 && line.includes('[^')) {
        line = line.replace(/\[\^([^\]]+)\](?!:)/g, (m, rawId) => {
          const id = rawId.trim();
          if (!gfmFootnotes.has(id)) return m;
          let idx = gfmFootnoteOrder.indexOf(id);
          if (idx === -1) {
            gfmFootnoteOrder.push(id);
            idx = gfmFootnoteOrder.length - 1;
          }
          return `[注${idx + 1}]`;
        });
      }

      // Heading shift: # -> ##, ## -> ###, etc.
      if (shiftBodyHeadings) {
        const headingMatch = line.match(/^(#{1,5})\s+(.*)$/);
        if (headingMatch) {
          line = `#${headingMatch[1]} ${headingMatch[2]}`;
        }
      }

      // Task lists: - [ ] -> - ☐, - [x] -> - ☑
      if (convertTaskLists) {
        line = line
          .replace(/^(\s*[-*+]\s+)\[\s\]\s+/g, '$1☐ ')
          .replace(/^(\s*[-*+]\s+)\[[xX]\]\s+/g, '$1☑ ');
      }

      // Inline math $...$ protection (single line, non-empty, not $$)
      if (protectMath && line.includes('$')) {
        const inlineMathRegex = /(?<!\$)\$(?!\$)([^$\n]+?)(?<!\$)\$(?!\$)/g;
        if (inlineMathRegex.test(line)) {
          warnings.push({
            type: 'math_detected',
            line: lineNo,
            detail: `检测到数学公式: ${restore(line).trim().slice(0, 60)}`,
          });
          line = line.replace(/(?<!\$)\$(?!\$)([^$\n]+?)(?<!\$)\$(?!\$)/g, (m) =>
            m.replace(/_/g, '\\_').replace(/\*/g, '\\*')
          );
        }
      }

      // Image alt cleanup for inline images ![alt](url) and reference images ![alt][ref]
      line = line.replace(/!\[([^\]]*)\](\([^)]+\)|\[[^\]]*\])/g, (_m, alt, tail) => {
        let finalAlt = alt;
        if (imageCaptionMode === 'none') {
          finalAlt = '';
        } else if (imageCaptionMode === 'smart' && isGenericAltText(alt)) {
          finalAlt = '';
        }
        return `![${finalAlt}]${tail}`;
      });

      // Link normalization (anchor downgrade & relative URL completion)
      line = line.replace(/(?<!!)\[([^\]]*)\]\(([^)]+)\)/g, (m, linkText, urlPart) => {
        const trimmedUrl = urlPart.trim().split(/\s+/)[0] || '';

        // In-page anchor: downgrade to plain text
        if (trimmedUrl.startsWith('#')) {
          return linkText;
        }

        // Domain lacking scheme: e.g. "decapcms.org/docs/..." -> "https://decapcms.org/docs/..."
        if (/^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}\/.*$/.test(trimmedUrl) && !trimmedUrl.includes('://')) {
          return `[${linkText}](https://${trimmedUrl})`;
        }

        // Relative path: resolve against postCanonicalUrl or siteUrl
        if (!/^(https?:|mailto:|tel:|\/\/)/i.test(trimmedUrl) && (postCanonicalUrl || siteUrl)) {
          try {
            const base = postCanonicalUrl || `${siteUrl.replace(/\/+$/, '')}/`;
            const resolved = new URL(trimmedUrl, base).toString();
            return `[${linkText}](${resolved})`;
          } catch {
            // Ignore
          }
        }

        return m;
      });

      // Detect remaining unhandled raw HTML tags (ignore closing tags, <iframe, <video, and <http...>/<mailto...>)
      for (const htmlMatch of line.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)(\s[^<>]*)?>/g)) {
        const fullTag = htmlMatch[0];
        const tagName = htmlMatch[1].toLowerCase();
        if (
          tagName === 'iframe' ||
          tagName === 'video' ||
          /^https?:$/i.test(tagName) ||
          fullTag.includes('@')
        ) {
          continue;
        }
        warnings.push({
          type: 'raw_html_detected',
          line: lineNo,
          detail: `发现原生 HTML 标签 <${htmlMatch[1]}>，将被作为纯文本转义显示`,
        });
      }

      processedSegLines.push(line);
    }

    outputChunks.push(restore(processedSegLines.join('\n')));
  }

  if (gfmFootnoteOrder.length > 0) {
    const fnLines = gfmFootnoteOrder.map(
      (id, idx) => `> **[注${idx + 1}]** ${gfmFootnotes.get(id) || ''}`
    );
    outputChunks.push(`\n\n${fnLines.join('\n>\n')}`);
  }

  const finalMarkdown = outputChunks.join('\n');

  // 4. Collect all image references via markdown-it AST token traversal
  // This accurately captures standard ![alt](url), balanced parens, AND reference-style ![alt][id]
  const imageRefsSet = new Set<string>();
  const finalTokens = parserMd.parse(finalMarkdown, {});
  for (const token of finalTokens) {
    if (token.type === 'inline' && token.children) {
      for (const child of token.children) {
        if (child.type === 'image') {
          const src = child.attrGet('src');
          if (src) {
            imageRefsSet.add(src);
          }
        }
      }
    }
  }

  return {
    markdown: finalMarkdown,
    imageRefs: Array.from(imageRefsSet),
    warnings,
  };
}
