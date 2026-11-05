// Import vendored renderer and themes first so base highlight.js languages are registered
// @ts-ignore - vendored JS files
import { renderMarkdown, stripPreviewMeta } from '../vendor/renderer.js';
// @ts-ignore - vendored JS files
import { themes, buildStyles, themeCategories } from '../vendor/themes.js';

import { ensureExtraLanguagesRegistered } from './hljs-extra.js';
import {
  preprocessMarkdown,
  PreprocessOptions,
  PreprocessWarning,
} from './preprocess.js';

// Register extra highlight.js languages and aliases on top of vendor base languages
ensureExtraLanguagesRegistered();

export * from './preprocess.js';
export * from './hljs-extra.js';

export interface ThemeInfo {
  id: string;
  name: string;
  tag: string;
  category: string;
  description: string;
  primary: string;
  font: string;
  surface: string;
  codeTheme: 'dark' | 'light';
  codeChrome: 'mac' | 'label' | 'plain';
}

export interface FooterCardOptions {
  title?: string;
  author?: string;
  canonicalUrl: string;
  licenseName?: string;
  publishedAt?: string;
}

export interface RenderArticleOptions {
  themeId?: string;               // default: 'tech-blue'
  accent?: string;                // optional primary color override (e.g. '#f75c7e')
  fontSize?: number;              // default: 15
  fontFamily?: 'theme' | 'sans' | 'serif' | 'rounded';
  macCode?: boolean;              // default: true
  galleryMode?: 'stack' | 'grid' | 'collage'; // default: 'stack'
  linksToFootnotes?: boolean;     // default: true
  imageMap?: Map<string, string>; // original src -> WeChat mmbiz url or preview path
  headerCoverUrl?: string;        // optional cover image inserted at top
  footerCard?: FooterCardOptions; // optional end-of-article provenance card
  preprocess?: PreprocessOptions;
}

export interface RenderArticleResult {
  html: string;
  imageRefs: string[];
  warnings: PreprocessWarning[];
  theme: ThemeInfo;
}

/**
 * Returns the list of all 28 available themes with categorized metadata.
 */
export function listThemes(): ThemeInfo[] {
  return themes.map((t: any) => ({
    id: t.id,
    name: t.name,
    tag: t.tag,
    category: (themeCategories as Record<string, string>)[t.id] || '其它',
    description: t.description,
    primary: t.primary,
    font: t.font || 'sans',
    surface: t.surface || '#ffffff',
    codeTheme: t.codeTheme || 'dark',
    codeChrome: t.codeChrome || 'mac',
  }));
}

/**
 * Retrieves a theme object by ID, falling back to 'tech-blue'.
 */
export function getTheme(themeId = 'tech-blue'): any {
  return themes.find((t: any) => t.id === themeId) || themes.find((t: any) => t.id === 'tech-blue') || themes[0];
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function unescapeHtmlAttr(str: string): string {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Builds an end-of-article provenance & copyright section in WeChat-safe inline style.
 */
function buildFooterCard(card: FooterCardOptions, primaryColor: string): string {
  const {
    title,
    author = 'RoL1n_SrP',
    canonicalUrl,
    licenseName = 'CC BY-NC-SA 4.0',
    publishedAt,
  } = card;

  return `
<section style="margin:2.5em 8px 1.2em;padding:14px 16px;background-color:#f8f9fa;border:1px solid #e9ecef;border-left:4px solid ${escapeHtml(
    primaryColor
  )};border-radius:6px;font-size:13px;line-height:1.7;color:#495057;">
  ${title ? `<p style="margin:0 0 6px;font-weight:700;color:#212529;">${escapeHtml(title)}</p>` : ''}
  <p style="margin:0 0 4px;"><span style="color:#868e96;">本文作者：</span><strong>${escapeHtml(author)}</strong>${
    publishedAt ? ` · <span style="color:#868e96;">发布时间：</span>${escapeHtml(publishedAt)}` : ''
  }</p>
  <p style="margin:0 0 4px;"><span style="color:#868e96;">许可协议：</span><span style="color:${escapeHtml(
    primaryColor
  )};font-weight:600;">${escapeHtml(licenseName)}</span></p>
  <p style="margin:0;word-break:break-all;"><span style="color:#868e96;">原文链接：</span><span style="color:#495057;font-family:Menlo,Consolas,monospace;font-size:12px;">${escapeHtml(
    canonicalUrl
  )}</span></p>
</section>`;
}

/**
 * Renders Markdown to WeChat-compatible HTML using md-wechat renderer + full preprocessing.
 */
export function renderArticle(
  rawMarkdown: string,
  options: RenderArticleOptions = {}
): RenderArticleResult {
  const {
    themeId = 'tech-blue',
    accent,
    fontSize = 15,
    fontFamily = 'theme',
    macCode = true,
    galleryMode = 'stack',
    linksToFootnotes = true,
    imageMap,
    headerCoverUrl,
    footerCard,
    preprocess = {},
  } = options;

  const themeObj = getTheme(themeId);
  const themeMeta: ThemeInfo = {
    id: themeObj.id,
    name: themeObj.name,
    tag: themeObj.tag,
    category: (themeCategories as Record<string, string>)[themeObj.id] || '其它',
    description: themeObj.description,
    primary: accent || themeObj.primary,
    font: themeObj.font || 'sans',
    surface: themeObj.surface || '#ffffff',
    codeTheme: themeObj.codeTheme || 'dark',
    codeChrome: themeObj.codeChrome || 'mac',
  };

  // 1. Preprocess
  const preprocessed = preprocessMarkdown(rawMarkdown, preprocess);

  // 2. Render through md-wechat renderer
  const rawHtml = renderMarkdown(preprocessed.markdown, themeObj, {
    accent,
    fontSize,
    fontFamily,
    macCode,
    galleryMode,
    linkFootnotes: linksToFootnotes,
  });

  // 3. Strip preview-specific attributes (data-line, data-gallery-mode)
  let cleanHtml = stripPreviewMeta(rawHtml);

  // 4. Scoped replacement of src="..." only on <img ...> tags
  if (imageMap && imageMap.size > 0) {
    const lookup = new Map<string, string>();
    for (const [rawSrc, newSrc] of imageMap.entries()) {
      if (!rawSrc || !newSrc) continue;
      lookup.set(rawSrc, newSrc);
      try {
        const decoded = decodeURIComponent(rawSrc);
        lookup.set(decoded, newSrc);
        lookup.set(encodeURI(decoded), newSrc);
        if (decoded.startsWith('./')) {
          lookup.set(decoded.slice(2), newSrc);
          lookup.set(encodeURI(decoded.slice(2)), newSrc);
        } else if (!/^(https?:|\/)/i.test(decoded)) {
          lookup.set(`./${decoded}`, newSrc);
          lookup.set(`./${encodeURI(decoded)}`, newSrc);
        }
      } catch {
        // Ignore malformed URI
      }
    }

    cleanHtml = cleanHtml.replace(
      /(<img\b[^>]*?\bsrc=")([^"]*)("[^>]*>)/gi,
      (fullMatch: string, prefix: string, srcAttr: string, suffix: string) => {
        const rawAttr = unescapeHtmlAttr(srcAttr);
        let replacement = lookup.get(srcAttr) || lookup.get(rawAttr);
        if (!replacement) {
          try {
            const decodedAttr = decodeURIComponent(rawAttr);
            replacement = lookup.get(decodedAttr);
          } catch {
            // Ignore
          }
        }
        if (replacement) {
          return `${prefix}${escapeHtml(replacement)}${suffix}`;
        }
        return fullMatch;
      }
    );
  }

  // 5. Insert header cover if configured
  if (headerCoverUrl) {
    const coverTag = `<section style="margin:0 0 1.6em;text-align:center;"><img src="${escapeHtml(
      headerCoverUrl
    )}" style="display:block;max-width:100%;margin:0 auto;border-radius:8px;" /></section>`;
    cleanHtml = cleanHtml.replace(/^(<section[^>]*>)/i, `$1${coverTag}`);
  }

  // 6. Insert footer copyright card if configured
  if (footerCard) {
    const cardHtml = buildFooterCard(footerCard, themeMeta.primary);
    const lastCloseIndex = cleanHtml.lastIndexOf('</section>');
    if (lastCloseIndex !== -1) {
      cleanHtml =
        cleanHtml.slice(0, lastCloseIndex) + cardHtml + cleanHtml.slice(lastCloseIndex);
    } else {
      cleanHtml += cardHtml;
    }
  }

  return {
    html: cleanHtml,
    imageRefs: preprocessed.imageRefs,
    warnings: preprocessed.warnings,
    theme: themeMeta,
  };
}
