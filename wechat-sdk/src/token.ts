import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WeChatError } from './errors.js';

export interface CachedToken {
  accessToken: string;
  expiresAt: number; // Unix timestamp in ms
}

export interface TokenStore {
  get(): Promise<CachedToken | null>;
  set(token: CachedToken): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryTokenStore implements TokenStore {
  private current: CachedToken | null = null;

  public async get(): Promise<CachedToken | null> {
    return this.current;
  }

  public async set(token: CachedToken): Promise<void> {
    this.current = token;
  }

  public async clear(): Promise<void> {
    this.current = null;
  }
}

export class FileTokenStore implements TokenStore {
  private readonly filePath: string;

  constructor(filePath?: string) {
    if (filePath) {
      if (filePath.startsWith('~/')) {
        this.filePath = path.join(os.homedir(), filePath.slice(2));
      } else {
        this.filePath = path.resolve(filePath);
      }
    } else {
      this.filePath = path.join(os.homedir(), '.cache', 'md2wechat', 'wechat-token.json');
    }
  }

  public async get(): Promise<CachedToken | null> {
    try {
      if (!fs.existsSync(this.filePath)) return null;
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const data = JSON.parse(raw);
      if (typeof data.accessToken === 'string' && typeof data.expiresAt === 'number') {
        return data as CachedToken;
      }
      return null;
    } catch {
      return null;
    }
  }

  public async set(token: CachedToken): Promise<void> {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmpPath = `${this.filePath}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(token, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      console.warn(`[FileTokenStore] Failed to write token file: ${(err as Error).message}`);
    }
  }

  public async clear(): Promise<void> {
    try {
      if (fs.existsSync(this.filePath)) {
        fs.unlinkSync(this.filePath);
      }
    } catch {
      // Ignore
    }
  }
}

export interface TokenManagerOptions {
  appId: string;
  appSecret: string;
  baseUrl?: string;
  tokenStore?: TokenStore;
  timeoutMs?: number;
}

export class TokenManager {
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly baseUrl: string;
  private readonly store: TokenStore;
  private readonly timeoutMs: number;
  private refreshPromise: Promise<string> | null = null;

  constructor(options: TokenManagerOptions) {
    this.appId = options.appId.trim();
    this.appSecret = options.appSecret.trim();
    this.baseUrl = (options.baseUrl || 'https://api.weixin.qq.com').replace(/\/+$/, '');
    this.store = options.tokenStore || new FileTokenStore();
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /**
   * Retrieves a valid access token, using cache when available or refreshing.
   * Concurrent requests are de-duplicated so only one refresh call hits WeChat servers.
   */
  public async getAccessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh) {
      const cached = await this.store.get();
      // Keep a 5-minute (300,000 ms) safety window
      if (cached && cached.expiresAt - Date.now() > 300_000) {
        return cached.accessToken;
      }
    }

    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = (async () => {
      try {
        const token = await this.fetchNewToken();
        await this.store.set(token);
        return token.accessToken;
      } finally {
        this.refreshPromise = null;
      }
    })();

    return this.refreshPromise;
  }

  public async clearCache(): Promise<void> {
    await this.store.clear();
  }

  private async fetchNewToken(): Promise<CachedToken> {
    const url = new URL(`${this.baseUrl}/cgi-bin/token`);
    url.searchParams.set('grant_type', 'client_credential');
    url.searchParams.set('appid', this.appId);
    url.searchParams.set('secret', this.appSecret);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method: 'GET',
        signal: controller.signal,
      });
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error(`[WeChat Token] Request timed out after ${this.timeoutMs}ms.`);
      }
      throw new Error(`[WeChat Token] Network error: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new Error(`[WeChat Token] HTTP status ${res.status}: ${res.statusText}`);
    }

    const data = (await res.json()) as any;
    if (data.errcode && data.errcode !== 0) {
      throw new WeChatError({
        errcode: data.errcode,
        errmsg: data.errmsg || 'Unknown token error',
        action: '获取 access_token',
      });
    }

    if (!data.access_token) {
      throw new Error('[WeChat Token] Missing access_token in response');
    }

    const expiresInSec = typeof data.expires_in === 'number' ? data.expires_in : 7200;
    return {
      accessToken: data.access_token,
      expiresAt: Date.now() + expiresInSec * 1000,
    };
  }
}
