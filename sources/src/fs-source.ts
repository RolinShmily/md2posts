import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import YAML from 'yaml';
import type {
  SourceAdapter,
  SourcePost,
  FsSourceOptions,
  FieldMapping,
} from './types.js';

const execFileAsync = promisify(execFile);

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg', '.gif']);

/**
 * Resolves a potentially dotted field key (e.g. "cover.image") on a frontmatter object.
 */
function getNestedField(obj: Record<string, unknown>, keyPath: string): unknown {
  if (!keyPath) return undefined;
  if (keyPath in obj) return obj[keyPath];
  const parts = keyPath.split('.');
  let current: any = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Formats a YAML date or string value as YYYY-MM-DD when applicable.
 */
function formatDateString(val: unknown): string | undefined {
  if (val == null || val === '') return undefined;
  if (val instanceof Date && !isNaN(val.getTime())) {
    const y = val.getUTCFullYear();
    const m = String(val.getUTCMonth() + 1).padStart(2, '0');
    const d = String(val.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const str = String(val).trim();
  return str || undefined;
}

/**
 * Parses YAML frontmatter and body content from a Markdown file.
 */
export function parseFrontmatter(raw: string): { data: Record<string, unknown>; content: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { data: {}, content: raw };
  }

  const yamlBlock = match[1];
  const content = match[2];

  try {
    const parsed = YAML.parse(yamlBlock);
    const data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    return { data: data as Record<string, unknown>, content };
  } catch {
    return { data: {}, content };
  }
}

function collectLocalAssets(rootDir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(rootDir)) return out;

  const walk = (dir: string) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (item.name.startsWith('.')) continue;
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        walk(fullPath);
      } else if (item.isFile()) {
        if (/\.mdx?$/i.test(item.name) || item.name.endsWith('.thumb.webp')) continue;
        const ext = path.extname(item.name).toLowerCase();
        if (IMAGE_EXTENSIONS.has(ext)) {
          out.push(fullPath);
        }
      }
    }
  };

  walk(rootDir);
  return out.sort();
}

/**
 * Traverses parent directories upwards starting from startDir to locate the containing .git directory.
 */
export function findGitRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

export class FsSource implements SourceAdapter {
  private readonly postsRoot: string;
  private readonly repoRoot?: string;
  private readonly repoUrl?: string;
  private readonly gitRemote?: string;
  private readonly gitBranch?: string;
  private readonly layout: 'bundle' | 'flat';
  private readonly gitPull: boolean;
  private readonly siteUrl: string;
  private readonly postPathPattern: string;
  private readonly fieldMapping: Required<FieldMapping>;

  constructor(options: FsSourceOptions) {
    this.postsRoot = path.resolve(options.postsRoot);
    this.repoRoot = options.repoRoot ? path.resolve(options.repoRoot) : undefined;
    this.repoUrl = options.repoUrl ? options.repoUrl.trim() : undefined;
    this.gitRemote = options.gitRemote ? options.gitRemote.trim() : undefined;
    this.gitBranch = options.gitBranch ? options.gitBranch.trim() : undefined;
    this.layout = options.layout || 'bundle';
    this.gitPull = Boolean(options.gitPull);
    this.siteUrl = (options.siteUrl || 'https://blog.srprolin.com').replace(/\/+$/, '');
    this.postPathPattern = options.postPathPattern || '/posts/{slug}/';

    this.fieldMapping = {
      title: options.fieldMapping?.title || 'title',
      summary: options.fieldMapping?.summary || 'description',
      cover: options.fieldMapping?.cover || 'image',
      date: options.fieldMapping?.date || 'published',
      updated: options.fieldMapping?.updated || 'updated',
      draft: options.fieldMapping?.draft || 'draft',
    };
  }

  /**
   * Optional pre-run hook to pull latest git commits from the chosen repository.
   */
  public async prepare(): Promise<void> {
    if (!this.gitPull) return;

    let targetDir = this.repoRoot;

    // 1. If repoUrl is configured and target directory does not exist, clone it first
    if (this.repoUrl && targetDir && !fs.existsSync(targetDir)) {
      try {
        console.log(`[Git] 正在从远程克隆仓库: ${this.repoUrl} -> ${targetDir} ...`);
        const cloneArgs = ['clone', this.repoUrl, targetDir];
        if (this.gitBranch) {
          cloneArgs.push('-b', this.gitBranch);
        }
        await execFileAsync('git', cloneArgs, { timeout: 60_000 });
      } catch (err: any) {
        throw new Error(`[FsSource] git clone ${this.repoUrl} 失败: ${err.message}`);
      }
    }

    // 2. If repoRoot was not explicitly set, auto-detect by walking up from postsRoot to find .git
    if (!targetDir) {
      targetDir = findGitRoot(this.postsRoot) || undefined;
    }

    if (!targetDir || !fs.existsSync(targetDir)) {
      throw new Error(
        `[FsSource] 开启了 gitPull，但在文章目录 ${this.postsRoot} 所在路径未找到 .git 仓库，且未在配置中指定 repoRoot`
      );
    }

    try {
      const pullArgs = ['pull', '--ff-only'];
      if (this.gitRemote) {
        pullArgs.push(this.gitRemote);
        if (this.gitBranch) {
          pullArgs.push(this.gitBranch);
        }
      }
      console.log(`[Git] 正在拉取博客仓库更新: ${targetDir} (${pullArgs.join(' ')}) ...`);
      await execFileAsync('git', pullArgs, {
        cwd: targetDir,
        timeout: 30_000,
      });
    } catch (err: any) {
      throw new Error(`[FsSource] 在仓库目录 ${targetDir} 执行 git pull 失败: ${err.message}`);
    }
  }

  /**
   * Scans and returns all posts from the filesystem, sorted newest first.
   */
  public async scanPosts(): Promise<SourcePost[]> {
    if (!fs.existsSync(this.postsRoot)) {
      return [];
    }

    const posts: SourcePost[] = [];

    if (this.layout === 'bundle') {
      const entries = fs.readdirSync(this.postsRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const slug = entry.name;
        const post = this.materializePost(slug);
        if (post) {
          posts.push(post);
        }
      }
    } else {
      const entries = fs.readdirSync(this.postsRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const slug = path.basename(entry.name, '.md');
        const post = this.materializePost(slug);
        if (post) {
          posts.push(post);
        }
      }
    }

    // Sort descending by publishedAt, then descending by slug (numeric-aware)
    posts.sort((a, b) => {
      const dateA = a.publishedAt || '';
      const dateB = b.publishedAt || '';
      const cmp = dateB.localeCompare(dateA);
      if (cmp !== 0) return cmp;
      return b.id.localeCompare(a.id, undefined, { numeric: true });
    });

    return posts;
  }

  /**
   * Retrieves a single post by its slug / ID.
   */
  public async getPost(id: string): Promise<SourcePost | null> {
    return this.materializePost(id);
  }

  private materializePost(slug: string): SourcePost | null {
    let filePath: string;
    let postDir: string;

    if (this.layout === 'bundle') {
      postDir = path.join(this.postsRoot, slug);
      filePath = path.join(postDir, 'index.md');
    } else {
      postDir = this.postsRoot;
      filePath = path.join(this.postsRoot, `${slug}.md`);
    }

    if (!fs.existsSync(filePath)) {
      return null;
    }

    const rawMarkdown = fs.readFileSync(filePath, 'utf8');
    const { data, content: bodyMarkdown } = parseFrontmatter(rawMarkdown);

    // Discover sibling local assets for bundle layout
    const localAssetPaths =
      this.layout === 'bundle' ? collectLocalAssets(postDir) : [];

    const rawTitle = getNestedField(data, this.fieldMapping.title);
    const rawSummary = getNestedField(data, this.fieldMapping.summary);
    const rawCover = getNestedField(data, this.fieldMapping.cover);
    const rawPublished = getNestedField(data, this.fieldMapping.date);
    const rawUpdated = getNestedField(data, this.fieldMapping.updated);
    const rawDraft = getNestedField(data, this.fieldMapping.draft);

    const title = String(rawTitle ?? slug).trim();
    const summary = String(rawSummary ?? '').trim();
    const coverRaw = rawCover ? String(rawCover).trim() : undefined;
    const publishedAt = formatDateString(rawPublished);
    const updatedAt = formatDateString(rawUpdated);
    const draft = Boolean(rawDraft);

    const canonicalPath = this.postPathPattern.replace('{slug}', slug);
    const canonicalUrl = `${this.siteUrl}${canonicalPath.startsWith('/') ? '' : '/'}${canonicalPath}`;

    // Compute composite hash
    const hash = crypto.createHash('sha256');
    hash.update(`title:${title}\n`);
    hash.update(`summary:${summary}\n`);
    hash.update(`cover:${coverRaw || ''}\n`);
    hash.update(`body:${bodyMarkdown}\n`);

    for (const assetPath of localAssetPaths) {
      try {
        const fileBuf = fs.readFileSync(assetPath);
        const fileHash = crypto.createHash('sha256').update(fileBuf).digest('hex');
        const relName = path.relative(postDir, assetPath).split(path.sep).join('/');
        hash.update(`asset:${relName}:${fileHash}\n`);
      } catch {
        // Ignore file read error in hash
      }
    }

    const contentHash = hash.digest('hex');

    return {
      id: slug,
      filePath,
      postDir,
      rawMarkdown,
      bodyMarkdown,
      contentHash,
      frontmatter: data,
      title,
      summary,
      coverRaw,
      publishedAt,
      updatedAt,
      draft,
      canonicalUrl,
      localAssetPaths,
    };
  }
}
