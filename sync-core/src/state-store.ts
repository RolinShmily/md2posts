import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface PostSyncState {
  contentHash: string;
  title: string;
  draftMediaId?: string;
  status: 'baselined' | 'synced';
  pushedAt: string;
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
      this.filePath = path.join(os.homedir(), '.local', 'share', 'md2wechat', 'state.json');
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
            `[StateStore] 另一个 md2wechat 同步进程 (PID: ${info.pid}) 正在运行中，已阻止并发写入。`
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
