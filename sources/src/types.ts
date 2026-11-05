export interface SourcePost {
  id: string;                    // unique slug, e.g. "45-immortalwrt-1"
  filePath: string;              // absolute path to index.md
  postDir: string;               // absolute path to post directory
  rawMarkdown: string;           // full file content
  bodyMarkdown: string;          // content without frontmatter
  contentHash: string;           // composite sha256
  frontmatter: Record<string, unknown>;
  title: string;
  summary: string;
  coverRaw?: string;             // raw frontmatter cover value
  publishedAt?: string;
  updatedAt?: string;
  draft: boolean;
  canonicalUrl: string;          // e.g. "https://blog.srprolin.com/posts/45-immortalwrt-1/"
  localAssetPaths: string[];     // paths of sibling images in postDir
}

export interface FieldMapping {
  title?: string;                // default: 'title'
  summary?: string;              // default: 'description'
  cover?: string;                // default: 'image' (supports dotted path e.g. 'cover.image')
  date?: string;                 // default: 'published'
  updated?: string;              // default: 'updated'
  draft?: string;                // default: 'draft'
}

export interface FsSourceOptions {
  postsRoot: string;
  repoRoot?: string;
  layout?: 'bundle' | 'flat';     // default: 'bundle' (slug/index.md)
  assetRoots?: string[];          // default: ['{postDir}']
  gitPull?: boolean;              // default: false
  siteUrl?: string;               // default: 'https://blog.srprolin.com'
  postPathPattern?: string;       // default: '/posts/{slug}/'
  fieldMapping?: FieldMapping;
}

export interface SourceAdapter {
  prepare?(): Promise<void>;
  scanPosts(): Promise<SourcePost[]>;
  getPost(id: string): Promise<SourcePost | null>;
}
