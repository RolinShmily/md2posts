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
  postsRoot?: string;             // 本地文章目录（若指定则优先使用）
  postsPath?: string;             // 仓库内文章相对路径，默认 'content/posts'
  repoRoot?: string;              // 本地 Git 仓库目录（留空且配置了 repoUrl 时自动缓存在 .cache/blog-repo）
  repoUrl?: string;               // 远程 Git 仓库 URL（默认远程拉取）
  gitRemote?: string;             // 远端名称，默认 'origin'
  gitBranch?: string;             // 目标分支，默认 'main' 或当前分支
  pullInterval?: string | number; // 自动拉取冷却周期（如 '24h', '1d', 默认 '24h'，一天内不重复拉取）
  layout?: 'bundle' | 'flat';     // default: 'bundle' (slug/index.md)
  assetRoots?: string[];          // default: ['{postDir}', '{repoRoot}/public']
  gitPull?: boolean;              // default: true (默认从远程拉取最新更新)
  siteUrl?: string;               // default: 'https://blog.srprolin.com'
  postPathPattern?: string;       // default: '/posts/{slug}/'
  fieldMapping?: FieldMapping;
}

export interface PrepareOptions {
  forcePull?: boolean;
  lastPullAt?: string;
  onPullSuccess?: (nowIso: string) => void;
}

export interface SourceAdapter {
  prepare?(options?: PrepareOptions): Promise<void>;
  scanPosts(): Promise<SourcePost[]>;
  getPost(id: string): Promise<SourcePost | null>;
}
