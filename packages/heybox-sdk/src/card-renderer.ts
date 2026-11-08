import fs from 'node:fs';
import sharp from 'sharp';

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
