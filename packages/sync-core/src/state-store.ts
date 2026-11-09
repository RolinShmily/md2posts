import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface PostSyncState {
  contentHash: string;
  title: string;
  draftMediaId?: string;
  heyboxDraftId?: string;
  status: 'baselined' | 'synced';
  pushedAt: string;
  heyboxSyncedAt?: string;
}

export interface ImageCacheEntry {
  wechatUrl: string;
  uploadedAt: string;
}

export interface CoverCacheEntry {
  mediaId: string;
  wechatUrl?: string;
  uploadedAt: string;
}

export interface SyncStateData {
  version: 1;
  baselineCreatedAt?: string;
  lastGitPullAt?: string;
  posts: Record<string, PostSyncState>;
  images: Record<string, ImageCacheEntry>;
  covers: Record<string, CoverCacheEntry>;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === 'EPERM';
  }
}

export class StateStore {
  public readonly filePath: string;
  public readonly lockPath: string;
  private data: SyncStateData;
  private lockDepth = 0;

  constructor(filePath?: string) {
    if (filePath) {
      if (filePath.startsWith('~/')) {
        this.filePath = path.join(os.homedir(), filePath.slice(2));
      } else {
        this.filePath = path.resolve(filePath);
      }
    } else {
      this.filePath = path.join(os.homedir(), '.local', 'share', 'md2posts', 'state.json');
    }
    this.lockPath = `${this.filePath}.lock`;
    this.data = this.load();
  }

  /**
   * Executes an async operation while holding an exclusive cross-process lockfile.
   * Re-entrant within the same StateStore instance.
   */
  public async withLock<T>(fn: () => Promise<T>): Promise<T> {
    if (this.lockDepth > 0) {
      this.lockDepth++;
      try {
        return await fn();
      } finally {
        this.lockDepth--;
      }
    }

    this.acquireLockFile();
    this.lockDepth = 1;
    try {
      // Reload latest state from disk after acquiring lock
      this.data = this.load();
      return await fn();
    } finally {
      this.lockDepth = 0;
      this.releaseLockFile();
    }
  }

  private acquireLockFile(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const payload = JSON.stringify({ pid: process.pid, createdAt: Date.now() });

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx');
        fs.writeFileSync(fd, payload, 'utf8');
        fs.closeSync(fd);
        return;
      } catch (err: any) {
        if (err.code !== 'EEXIST') {
          throw new Error(`[StateStore] 无法创建锁文件 ${this.lockPath}: ${err.message}`);
        }

        // Check if existing lock is stale
        try {
          const raw = fs.readFileSync(this.lockPath, 'utf8');
          const info = JSON.parse(raw);
          const ageMs = Date.now() - Number(info.createdAt || 0);
          const alive = isProcessAlive(Number(info.pid));
          if (!alive || ageMs > 30 * 60 * 1000) {
            fs.unlinkSync(this.lockPath);
            continue;
          }
          throw new Error(
            `[StateStore] 另一个 md2posts 同步进程 (PID: ${info.pid}) 正在运行中，已阻止并发写入。`
          );
        } catch (readErr: any) {
          if (readErr.message?.includes('正在运行中')) {
            throw readErr;
          }
          // Corrupted or vanished lock file -> remove and retry once
          try {
            fs.unlinkSync(this.lockPath);
          } catch {}
        }
      }
    }

    throw new Error(`[StateStore] 获取文件锁失败: ${this.lockPath}`);
  }

  private releaseLockFile(): void {
    try {
      if (fs.existsSync(this.lockPath)) {
        fs.unlinkSync(this.lockPath);
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  public getLastGitPullAt(): string | undefined {
    return this.data.lastGitPullAt;
  }

  public setLastGitPullAt(isoDate: string): void {
    this.data.lastGitPullAt = isoDate;
    this.save();
  }

  public getPost(slug: string): PostSyncState | undefined {
    return this.data.posts[slug];
  }

  public setPost(slug: string, state: PostSyncState): void {
    this.data.posts[slug] = state;
  }

  public getImage(sha256: string): ImageCacheEntry | undefined {
    return this.data.images[sha256];
  }

  public setImage(sha256: string, entry: ImageCacheEntry): void {
    this.data.images[sha256] = entry;
  }

  public getCover(sha256: string): CoverCacheEntry | undefined {
    return this.data.covers[sha256];
  }

  public setCover(sha256: string, entry: CoverCacheEntry): void {
    this.data.covers[sha256] = entry;
  }

  public markBaseline(posts: Array<{ id: string; title: string; contentHash: string }>): void {
    const now = new Date().toISOString();
    if (!this.data.baselineCreatedAt) {
      this.data.baselineCreatedAt = now;
    }
    for (const post of posts) {
      if (!this.data.posts[post.id]) {
        this.data.posts[post.id] = {
          contentHash: post.contentHash,
          title: post.title,
          status: 'baselined',
          pushedAt: now,
        };
      }
    }
    this.save();
  }

  public getAllPosts(): Record<string, PostSyncState> {
    return this.data.posts;
  }

  /** Number of articles this state file has ever recorded (baseline + synced). */
  public countPosts(): number {
    return Object.keys(this.data.posts).length;
  }

  /** True when no article has been recorded yet (fresh clone / new machine). */
  public isEmpty(): boolean {
    return this.countPosts() === 0;
  }

  /** When the baseline was first established, if ever. */
  public getBaselineCreatedAt(): string | undefined {
    return this.data.baselineCreatedAt;
  }

  /** Counts by record status plus cache sizes, for CLI inspection. */
  public getStats(): {
    posts: number;
    baselined: number;
    synced: number;
    images: number;
    covers: number;
    lastGitPullAt?: string;
    baselineCreatedAt?: string;
  } {
    const entries = Object.values(this.data.posts);
    return {
      posts: entries.length,
      baselined: entries.filter((e) => e.status === 'baselined').length,
      synced: entries.filter((e) => e.status === 'synced').length,
      images: Object.keys(this.data.images).length,
      covers: Object.keys(this.data.covers).length,
      lastGitPullAt: this.data.lastGitPullAt,
      baselineCreatedAt: this.data.baselineCreatedAt,
    };
  }

  /**
   * Merges another machine's state into this one.
   *
   * Only fills in articles this machine has never seen: an existing record is authoritative
   * locally (its contentHash may be newer), so imports never overwrite or downgrade it.
   */
  public importFrom(source: unknown): { added: number; skipped: number } {
    const data = source as Partial<SyncStateData> | null;
    if (!data || typeof data !== 'object' || typeof data.posts !== 'object' || !data.posts) {
      throw new Error('[StateStore] 导入失败：文件内容不是有效的 state.json（缺少 posts 字段）');
    }

    const incoming = data.posts as Record<string, PostSyncState>;
    let added = 0;
    let skipped = 0;

    for (const [id, entry] of Object.entries(incoming)) {
      if (!entry || typeof entry !== 'object' || typeof entry.contentHash !== 'string') {
        skipped++;
        continue;
      }
      if (this.data.posts[id]) {
        skipped++;
        continue;
      }
      this.data.posts[id] = {
        contentHash: entry.contentHash,
        title: String(entry.title || id),
        status: entry.status === 'synced' ? 'synced' : 'baselined',
        pushedAt: String(entry.pushedAt || new Date().toISOString()),
        ...(entry.draftMediaId ? { draftMediaId: String(entry.draftMediaId) } : {}),
        ...(entry.heyboxDraftId ? { heyboxDraftId: String(entry.heyboxDraftId) } : {}),
        ...(entry.heyboxSyncedAt ? { heyboxSyncedAt: String(entry.heyboxSyncedAt) } : {}),
      };
      added++;
    }

    // Keep the earliest baseline timestamp so the "baseline existed since" stays meaningful.
    if (data.baselineCreatedAt) {
      const incomingDate = String(data.baselineCreatedAt);
      if (!this.data.baselineCreatedAt || incomingDate < this.data.baselineCreatedAt) {
        this.data.baselineCreatedAt = incomingDate;
      }
    }

    this.save();
    return { added, skipped };
  }

  public save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.filePath);
    } catch (err: any) {
      throw new Error(`[StateStore] Failed to write state file ${this.filePath}: ${err.message}`);
    }
  }

  private load(): SyncStateData {
    try {
      if (!fs.existsSync(this.filePath)) {
        return {
          version: 1,
          posts: {},
          images: {},
          covers: {},
        };
      }
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        version: 1,
        baselineCreatedAt: parsed.baselineCreatedAt,
        lastGitPullAt: parsed.lastGitPullAt,
        posts: parsed.posts || {},
        images: parsed.images || {},
        covers: parsed.covers || {},
      };
    } catch (err: any) {
      console.warn(`[StateStore] Warning reading ${this.filePath}: ${err.message}. Starting with fresh state.`);
      return {
        version: 1,
        posts: {},
        images: {},
        covers: {},
      };
    }
  }
}
