export interface HeyBoxMetadata {
  community?: string;
  gameId?: string | number;
  hashtags: string[];
  kind: 'article' | 'image_text';
}

/**
 * Clean, decoupled article input for HeyBox publishing.
 * Can be satisfied by SourcePost or any blog article object.
 */
export interface HeyBoxArticleInput {
  id: string;
  title: string;
  bodyMarkdown: string;
  canonicalUrl: string;
  frontmatter?: Record<string, unknown>;
  coverRaw?: string;
  localAssetPaths?: string[];
  postDir?: string;
}

export interface HeyBoxPreparedResult {
  article: HeyBoxArticleInput;
  title: string;
  markdown: string;
  richHtml: string;
  coverBuffer?: Buffer;
  assets: Map<string, Buffer>; // relative filename in output -> Buffer
  metadata: HeyBoxMetadata;
  previewHtml: string;
  /** Non-fatal publishing hints (e.g. too many external links). */
  warnings: string[];
  /** External (non platform-internal, non own-domain) URLs still present in the body. */
  externalLinkCount?: number;
}

export interface HeyBoxPublishResult {
  slug: string;
  title: string;
  bundleDir: string;
  hasCover: boolean;
  codeImagesCount: number;
  publishedViaCli: boolean;
  publishedViaBrowser?: boolean;
  draftId?: string;
  draftUrl?: string;
  message: string;
}

export type HeyBoxCodeBlockMode = 'auto' | 'terminal' | 'image';


export interface HeyBoxPrepareOptions {
  assetRoots?: string[];
  defaultCoverPath?: string;
  codeBlockMode?: HeyBoxCodeBlockMode;
  /** Blog site URL; its host (and subdomains) is treated as "own domain" and never linked. */
  siteUrl?: string;
}

export interface HeyBoxPublishOptions {
  dryRun?: boolean;
  outDir?: string;
  headless?: boolean;
  skipBrowser?: boolean;
}

export interface HeyBoxClientOptions {
  cliPath?: string;
  outputDir?: string;
  sessionFile?: string;
  browserChannel?: 'chrome' | 'msedge';
  headless?: boolean;
  browserTimeoutMs?: number;
  assetRoots?: string[];
  defaultCoverPath?: string;
  codeBlockMode?: HeyBoxCodeBlockMode;
  siteUrl?: string;
  dryRun?: boolean;
  /** Optional nested config support for AppConfig */
  source?: { assetRoots?: string[] };
  sync?: { defaultCover?: string };
}
