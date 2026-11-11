import fs from 'node:fs';
import sharp from 'sharp';

export function escapeXml(unsafe: string): string {
  return String(unsafe || '').replace(/[<>&'"]/g, (c) => {
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
 * Strips non-printable XML 1.0 control characters to prevent SVG parser crashes in Sharp/librsvg.
 */
export function sanitizeXmlText(text: string): string {
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

export interface ParsedTable {
  headers: string[];
  alignments: Array<'left' | 'center' | 'right'>;
  rows: string[][];
}

/**
 * Parses a standard GFM Markdown table into headers, alignments, and rows.
 */
export function parseMarkdownTable(tableMd: string): ParsedTable | null {
  const lines = tableMd
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length < 2) return null;

  const parseRow = (line: string): string[] => {
    const trimmed = line.replace(/^\|/, '').replace(/\|$/, '');
    return trimmed.split('|').map((c) => c.trim());
  };

  const headers = parseRow(lines[0]);
  if (headers.length === 0) return null;

  // Separator line: |:---|:---:|---:|
  const sepRow = parseRow(lines[1]);
  const isSep = sepRow.every((c) => /^:?-+:?$/.test(c));
  if (!isSep) return null;

  const alignments: Array<'left' | 'center' | 'right'> = sepRow.map((c) => {
    if (c.startsWith(':') && c.endsWith(':')) return 'center';
    if (c.endsWith(':')) return 'right';
    return 'left';
  });

  const rows: string[][] = [];
  for (let i = 2; i < lines.length; i++) {
    if (!lines[i].includes('|')) continue;
    const cells = parseRow(lines[i]);
    while (cells.length < headers.length) {
      cells.push('');
    }
    rows.push(cells.slice(0, headers.length));
  }

  return { headers, alignments, rows };
}

/**
 * Determines whether a code block represents terminal commands or brief config
 * that should be rendered as a native, copy-friendly terminal block rather than an image.
 */
export function isCommandLineSnippet(code: string, lang = ''): boolean {
  const cleanLang = (lang || '').trim().toLowerCase();
  const terminalLangs = [
    'bash',
    'sh',
    'shell',
    'zsh',
    'pwsh',
    'powershell',
    'cmd',
    'dos',
    'console',
    'terminal',
    'config',
    'conf',
    'env',
    'toml',
    'dockerfile',
  ];
  if (terminalLangs.includes(cleanLang)) return true;

  const lines = code.trim().split('\n');
  if (lines.length <= 6) return true;

  return false;
}

/**
 * Formats a code block into a clean, ProseMirror-safe semantic terminal block.
 * Rendered using native <blockquote>, <p>, <b>, <code> tags:
 * - 100% copy-friendly for mobile & desktop readers
 * - Zero aspect ratio / image scaling distortion
 * - Zero image upload quota consumption
 */
export function formatCodeAsNativeTerminalBox(code: string, lang = 'CODE'): string {
  const displayLang = (lang || 'CODE').toUpperCase();
  const cleanCode = code.replace(/\r\n/g, '\n').trimEnd();
  const lines = cleanCode.split('\n');

  // HTML collapses consecutive spaces, so convert indentation and runs of spaces to &nbsp;
  // to preserve the visual structure of indentation-sensitive code (Python / YAML / config).
  const formattedLines = lines.map((line) =>
    escapeXml(line)
      .replace(/\t/g, '    ')
      .replace(/ {2,}/g, (spaces) => '&nbsp;'.repeat(spaces.length))
      .replace(/^ /, '&nbsp;')
  );
  return `\n<blockquote><p><b>💻 终端命令 · ${escapeXml(displayLang)}</b></p><p><code>${formattedLines.join('<br />')}</code></p></blockquote>\n`;
}

/**
 * Formats a parsed table into a mobile-friendly blockquote list fallback.
 * Used when image rendering is disabled or fails.
 */
export function formatTableAsFallbackText(parsed: ParsedTable): string {
  const lines: string[] = ['\n> 📊 **数据表格**：\n'];
  for (const row of parsed.rows) {
    const rowText = row
      .map((cell, idx) => `**${parsed.headers[idx] || '项'}**: ${cell || '-'}`)
      .join(' | ');
    lines.push(`> • ${rowText}`);
  }
  lines.push('\n');
  return lines.join('\n');
}

/**
 * Renders a markdown table into an aesthetically pleasing, dark-mode SVG -> PNG image card.
 * XiaoHeiHe ProseMirror does NOT support HTML <table> nodes; images prevent broken formatting.
 */
export async function renderTableToImage(
  tableInput: string | ParsedTable,
  options: { maxWidth?: number } = {}
): Promise<Buffer> {
  const parsed =
    typeof tableInput === 'string' ? parseMarkdownTable(tableInput) : tableInput;

  if (!parsed || parsed.headers.length === 0) {
    throw new Error('无效的表格格式，无法生成表格图片');
  }

  const { headers, alignments, rows } = parsed;
  const colCount = headers.length;
  const maxWidth = options.maxWidth || 720;
  const width = Math.min(maxWidth, Math.max(540, colCount * 180));
  const colWidth = Math.floor(width / colCount);
  const rowHeight = 46;
  const headerHeight = 48;
  const totalHeight = headerHeight + Math.max(1, rows.length) * rowHeight + 10;

  let svgContent = `<svg width="${width}" height="${totalHeight}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" rx="12" fill="#1b1d23" stroke="#2d3139" stroke-width="1.5" />
  <rect x="0" y="0" width="100%" height="${headerHeight}" rx="12" fill="#242730" />
  <rect x="0" y="${headerHeight - 12}" width="100%" height="12" fill="#242730" />
  <line x1="0" y1="${headerHeight}" x2="${width}" y2="${headerHeight}" stroke="#2d3139" stroke-width="1.5" />
`;

  // Headers
  headers.forEach((h, i) => {
    const align = alignments[i] || 'left';
    let x = i * colWidth + 18;
    let textAnchor = 'start';
    if (align === 'center') {
      x = i * colWidth + colWidth / 2;
      textAnchor = 'middle';
    } else if (align === 'right') {
      x = (i + 1) * colWidth - 18;
      textAnchor = 'end';
    }
    const cleanH = escapeXml(sanitizeXmlText(h));
    svgContent += `  <text x="${x}" y="30" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif" font-size="17" font-weight="bold" fill="#ff9800" text-anchor="${textAnchor}">${cleanH}</text>\n`;
  });

  // Rows
  const renderRows = rows.length > 0 ? rows : [new Array(colCount).fill('-')];
  renderRows.forEach((row, rIdx) => {
    const y = headerHeight + rIdx * rowHeight;
    const bg = rIdx % 2 === 0 ? '#1b1d23' : '#22252e';

    svgContent += `  <rect x="0" y="${y}" width="100%" height="${rowHeight}" fill="${bg}" />\n`;
    svgContent += `  <line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="#2d3139" stroke-width="1" />\n`;

    row.forEach((cell, cIdx) => {
      const align = alignments[cIdx] || 'left';
      let x = cIdx * colWidth + 18;
      let textAnchor = 'start';
      if (align === 'center') {
        x = cIdx * colWidth + colWidth / 2;
        textAnchor = 'middle';
      } else if (align === 'right') {
        x = (cIdx + 1) * colWidth - 18;
        textAnchor = 'end';
      }
      const cleanCell = escapeXml(sanitizeXmlText(cell));
      const cy = y + 29;
      svgContent += `  <text x="${x}" y="${cy}" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif" font-size="16" font-weight="500" fill="#e2e8f0" text-anchor="${textAnchor}">${cleanCell}</text>\n`;
    });
  });

  svgContent += `</svg>`;

  return await sharp(Buffer.from(svgContent)).png({ compressionLevel: 9 }).toBuffer();
}

export interface WrappedCodeRow {
  lineNum: number | null;
  text: string;
  isContinuation: boolean;
}

/**
 * Intelligently wraps code lines so that long commands/statements fit comfortably
 * on mobile screens without overflowing or causing severe aspect ratio distortions.
 */
export function wrapCodeLines(rawLines: string[], maxCharsPerLine = 66): WrappedCodeRow[] {
  const wrapped: WrappedCodeRow[] = [];

  for (let lineIdx = 0; lineIdx < rawLines.length; lineIdx++) {
    const rawLine = rawLines[lineIdx];
    if (rawLine.length <= maxCharsPerLine) {
      wrapped.push({
        lineNum: lineIdx + 1,
        text: rawLine,
        isContinuation: false,
      });
      continue;
    }

    let remaining = rawLine;
    let isFirst = true;

    while (remaining.length > 0) {
      if (remaining.length <= maxCharsPerLine) {
        wrapped.push({
          lineNum: isFirst ? lineIdx + 1 : null,
          text: remaining,
          isContinuation: !isFirst,
        });
        break;
      }

      let breakIdx = -1;
      const windowStr = remaining.slice(0, maxCharsPerLine);
      const delimiters = [' && ', ' | ', ' --', ' -', ' ', '/', ';', ',', '(', ')', '='];
      for (const delim of delimiters) {
        const lastPos = windowStr.lastIndexOf(delim);
        if (lastPos > maxCharsPerLine * 0.45) {
          breakIdx = lastPos + delim.length;
          break;
        }
      }

      if (breakIdx <= 0) {
        breakIdx = maxCharsPerLine;
      }

      const chunk = remaining.slice(0, breakIdx);
      wrapped.push({
        lineNum: isFirst ? lineIdx + 1 : null,
        text: chunk,
        isContinuation: !isFirst,
      });

      remaining = remaining.slice(breakIdx).trimStart();
      isFirst = false;
    }
  }

  return wrapped;
}

/**
 * Renders a fenced code block into an aesthetically pleasing, dark-mode SVG -> PNG image card.
 * Standard 720px width with automatic line wrapping prevents extreme flat ratios on long commands.
 */
export async function renderCodeBlockToImage(
  code: string,
  lang = 'CODE',
  options: { maxWidth?: number } = {}
): Promise<Buffer> {
  const svg = buildCodeBlockSvg(code, lang, options);
  return await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}

/**
 * Builds the SVG source for a code block card (separated from rasterization so it can be unit-tested).
 */
export function buildCodeBlockSvg(
  code: string,
  lang = 'CODE',
  options: { maxWidth?: number } = {}
): string {
  const cleanCode = sanitizeXmlText(code.replace(/\r\n/g, '\n').replace(/\t/g, '  ')).trimEnd();
  const rawLines = cleanCode.split('\n');

  // Cap max lines per single code card to 160 lines to avoid massive dimensions and memory issues
  const MAX_LINES = 160;
  let lines = rawLines;
  let truncatedNotice = '';
  if (rawLines.length > MAX_LINES) {
    lines = rawLines.slice(0, MAX_LINES);
    truncatedNotice = `// ... 篇幅受限，已折叠剩余 ${rawLines.length - MAX_LINES} 行代码，完整内容请访问原文`;
  }
  if (lines.length === 0) lines = [''];

  // Mobile 2x Retina standard width (720px) with balanced font size (21px) and natural line capacity (55 chars)
  // Keeps common commands intact on 1 line while wrapping ultra-long commands smoothly
  const targetWidth = options.maxWidth || 720;
  const maxChars = 55;
  const wrappedLines = wrapCodeLines(lines, maxChars);

  const fontSize = 21;
  const lineHeight = 36;
  const headerHeight = 46;
  const paddingBottom = 22;

  // Ensure minimum visual height (at least 2 rows) to avoid squashed ratio on 1-line commands
  const visualRowCount = Math.max(2, wrappedLines.length + (truncatedNotice ? 1 : 0));
  const totalHeight = headerHeight + visualRowCount * lineHeight + paddingBottom;

  const totalPhysicalLines = lines.length + (truncatedNotice ? 1 : 0);
  const gutterDigits = Math.max(2, String(totalPhysicalLines).length);
  const gutterWidth = gutterDigits * 13 + 18;
  const codeStartX = 20 + gutterWidth;

  const textSvgLines = wrappedLines.map((row, idx) => {
    const y = headerHeight + 27 + idx * lineHeight;
    const lineNumStr = row.lineNum !== null ? String(row.lineNum).padStart(gutterDigits, ' ') : '';
    const prefix = row.isContinuation ? '<tspan fill="#64748b">↳ </tspan>' : '';

    return `  <text x="20" y="${y}" font-family="ui-monospace, monospace" font-size="15" fill="#505664">${lineNumStr}</text>
  <text x="${codeStartX}" y="${y}" xml:space="preserve" font-family="ui-monospace, monospace" font-size="${fontSize}" font-weight="600" fill="#e2e8f0">${prefix}${escapeXml(
      row.text
    )}</text>`;
  });

  if (truncatedNotice) {
    const y = headerHeight + 27 + wrappedLines.length * lineHeight;
    textSvgLines.push(
      `  <text x="${codeStartX}" y="${y}" font-family="ui-monospace, monospace" font-size="15" fill="#ff9800" font-style="italic">${escapeXml(
        truncatedNotice
      )}</text>`
    );
  }

  const displayLang = (lang || 'CODE').toUpperCase();

  const svg = `<svg width="${targetWidth}" height="${totalHeight}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" rx="12" fill="#1b1d23" stroke="#2d3139" stroke-width="1.5" />
  <rect x="0" y="0" width="100%" height="${headerHeight}" rx="12" fill="#242730" />
  <rect x="0" y="${headerHeight - 12}" width="100%" height="12" fill="#242730" />
  <line x1="0" y1="${headerHeight}" x2="${targetWidth}" y2="${headerHeight}" stroke="#2d3139" stroke-width="1.5" />
  <circle cx="24" cy="23" r="5.5" fill="#ff5f56" />
  <circle cx="42" cy="23" r="5.5" fill="#ffbd2e" />
  <circle cx="60" cy="23" r="5.5" fill="#27c93f" />
  <text x="${targetWidth - 20}" y="29" font-family="-apple-system, sans-serif" font-size="13" font-weight="bold" fill="#8892a4" text-anchor="end">${escapeXml(
    displayLang
  )}</text>
${textSvgLines.join('\n')}
</svg>`;

  return svg;
}

/**
 * Crops or adapts an input image into a standard 16:9 (1280x720) header banner for XiaoHeiHe.
 * - If already near 16:9 (ratio 1.65 ~ 1.9), gentle center crop is applied.
 * - Otherwise (e.g. square, screenshot, portrait), applies an aesthetic blurred background
 *   with the 100% complete original image contained in center, guaranteeing zero pixel loss!
 */
export async function crop16x9Cover(input: Buffer | string): Promise<Buffer> {
  let buf: Buffer;
  if (typeof input === 'string') {
    buf = fs.readFileSync(input);
  } else {
    buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  }

  const meta = await sharp(buf).metadata();
  const width = meta.width || 1280;
  const height = meta.height || 720;
  const ratio = width / height;

  // Gentle center crop if already approximately 16:9
  if (ratio >= 1.65 && ratio <= 1.9) {
    return await sharp(buf)
      .rotate()
      .resize({
        width: 1280,
        height: 720,
        fit: 'cover',
        position: 'center',
      })
      .jpeg({ quality: 90, progressive: true })
      .toBuffer();
  }

  // Non-destructive: blurred backdrop + complete foreground image in center
  const bgBuf = await sharp(buf)
    .rotate()
    .resize({
      width: 1280,
      height: 720,
      fit: 'cover',
      position: 'center',
    })
    .blur(25)
    .modulate({ brightness: 0.65 })
    .jpeg({ quality: 80 })
    .toBuffer();

  const fgBuf = await sharp(buf)
    .rotate()
    .resize({
      width: 1280,
      height: 720,
      fit: 'inside',
    })
    .png()
    .toBuffer();

  return await sharp(bgBuf)
    .composite([{ input: fgBuf, gravity: 'center' }])
    .jpeg({ quality: 90, progressive: true })
    .toBuffer();
}
