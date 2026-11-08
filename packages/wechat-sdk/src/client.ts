import { TokenManager, TokenStore, FileTokenStore } from './token.js';
import { WeChatError, extractIpFromErrorMessage } from './errors.js';
import type {
  DraftArticleInput,
  DraftCountResult,
  DraftAddResult,
  DraftGetResult,
  DraftArticleDetail,
  DraftBatchGetResult,
  MaterialBatchGetResult,
  PublishSubmitResult,
  PublishStatusResult,
  PublishBatchGetResult,
} from './endpoints/draft.js';

export interface WeChatClientOptions {
  appId: string;
  appSecret: string;
  baseUrl?: string;
  tokenStore?: TokenStore;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  dryRun?: boolean;
}

export interface DiagnoseStepResult {
  step: 'credentials' | 'token' | 'ip_whitelist' | 'draft_permission';
  title: string;
  ok: boolean;
  code?: number;
  message: string;
  detail?: string;
  remediation?: string;
}

export interface DiagnoseReport {
  ok: boolean;
  canUseDraftApi: boolean;
  ipWhitelistOk: boolean;
  detectedIp?: string;
  steps: DiagnoseStepResult[];
}

export class WeChatClient {
  public readonly appId: string;
  private readonly appSecret: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly dryRun: boolean;
  private readonly tokenManager: TokenManager;

  constructor(options: WeChatClientOptions) {
    this.appId = (options.appId || '').trim();
    this.appSecret = (options.appSecret || '').trim();
    this.baseUrl = (options.baseUrl || 'https://api.weixin.qq.com').replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
    this.dryRun = Boolean(options.dryRun);

    this.tokenManager = new TokenManager({
      appId: this.appId,
      appSecret: this.appSecret,
      baseUrl: this.baseUrl,
      tokenStore: options.tokenStore || new FileTokenStore(),
      timeoutMs: this.timeoutMs,
    });
  }

  /**
   * Run a 3-step diagnostic check:
   * 1. Credentials presence
   * 2. Token acquisition (checks AppSecret & IP whitelist)
   * 3. Draft API permission (calls draft/count to verify if account can manage drafts)
   */
  public async diagnose(): Promise<DiagnoseReport> {
    const steps: DiagnoseStepResult[] = [];
    let detectedIp: string | undefined;
    let ipWhitelistOk = false;
    let canUseDraftApi = false;

    // Step 1: Credentials check
    const credsOk = Boolean(
      this.appId && this.appSecret && this.appId.length > 5 && this.appSecret.length > 10
    );
    if (!credsOk) {
      steps.push({
        step: 'credentials',
        title: '公众号开发凭据检查',
        ok: false,
        message: '未提供有效的 AppID 或 AppSecret',
        remediation: '请检查环境变量 WECHAT_APPID 与 WECHAT_SECRET 是否已配置。',
      });
      return { ok: false, canUseDraftApi: false, ipWhitelistOk: false, steps };
    }

    steps.push({
      step: 'credentials',
      title: '公众号开发凭据检查',
      ok: true,
      message: `AppID 已就绪 (${this.appId.slice(0, 4)}...${this.appId.slice(-4)})`,
    });

    // Step 2: Access Token & IP Whitelist check
    try {
      await this.tokenManager.getAccessToken(true);
      ipWhitelistOk = true;
      steps.push({
        step: 'token',
        title: '获取 Access Token 与 IP 白名单验证',
        ok: true,
        message: '成功获取 access_token，当前服务器出口 IP 在公众号白名单内',
      });
    } catch (err: any) {
      if (err instanceof WeChatError) {
        if (err.isIpWhitelistRejection()) {
          detectedIp = err.extractedIp || extractIpFromErrorMessage(err.errmsg);
          steps.push({
            step: 'ip_whitelist',
            title: 'IP 白名单校验',
            ok: false,
            code: 40164,
            message: `出口 IP ${detectedIp ? `[${detectedIp}]` : ''} 不在公众号白名单中`,
            detail: err.errmsg,
            remediation: `请登录微信公众平台 ->「开发 - 基本配置 - IP白名单」，添加 IP: ${detectedIp || '当前服务器出口IP'}。`,
          });
        } else {
          steps.push({
            step: 'token',
            title: '获取 Access Token',
            ok: false,
            code: err.errcode,
            message: err.friendlyMessage,
            detail: err.errmsg,
          });
        }
      } else {
        steps.push({
          step: 'token',
          title: '获取 Access Token',
          ok: false,
          message: `网络或未知异常: ${err.message}`,
        });
      }
      return { ok: false, canUseDraftApi: false, ipWhitelistOk, detectedIp, steps };
    }

    // Step 3: Draft API permission check
    try {
      const count = await this.draft.count();
      canUseDraftApi = true;
      steps.push({
        step: 'draft_permission',
        title: '草稿箱 API 权限校验 (draft/count)',
        ok: true,
        message: `当前账号草稿箱接口权限正常可用！草稿箱现有文章数：${count}`,
      });
    } catch (err: any) {
      if (err instanceof WeChatError) {
        if (err.isUnauthorized()) {
          steps.push({
            step: 'draft_permission',
            title: '草稿箱 API 权限校验 (draft/count)',
            ok: false,
            code: 48001,
            message: '当前公众号主体未授权调用草稿箱接口（48001 api unauthorized）',
            detail: err.errmsg,
            remediation:
              '微信对部分个人主体或未认证账号关闭了该接口。需退回「本地渲染 HTML + 手动粘贴」路线。',
          });
        } else {
          steps.push({
            step: 'draft_permission',
            title: '草稿箱 API 权限校验 (draft/count)',
            ok: false,
            code: err.errcode,
            message: err.friendlyMessage,
            detail: err.errmsg,
          });
        }
      } else {
        steps.push({
          step: 'draft_permission',
          title: '草稿箱 API 权限校验 (draft/count)',
          ok: false,
          message: `调用 draft/count 异常: ${err.message}`,
        });
      }
    }

    const allOk = steps.every((s) => s.ok);
    return {
      ok: allOk,
      canUseDraftApi,
      ipWhitelistOk,
      detectedIp,
      steps,
    };
  }

  /**
   * Draft Box APIs (`cgi-bin/draft/*`)
   */
  public readonly draft = {
    count: async (): Promise<number> => {
      const res = await this.post<DraftCountResult>('/cgi-bin/draft/count', {}, '查询草稿箱总数');
      return res.total_count ?? 0;
    },

    add: async (articles: DraftArticleInput[]): Promise<string> => {
      if (this.dryRun) {
        return `dry-run-draft-${Date.now()}`;
      }
      const res = await this.post<DraftAddResult>(
        '/cgi-bin/draft/add',
        { articles },
        '新增草稿'
      );
      return res.media_id;
    },

    get: async (mediaId: string): Promise<DraftArticleDetail[]> => {
      const res = await this.post<DraftGetResult>(
        '/cgi-bin/draft/get',
        { media_id: mediaId },
        '获取草稿详情'
      );
      return res.news_item || [];
    },

    update: async (mediaId: string, index: number, article: DraftArticleInput): Promise<void> => {
      if (this.dryRun) return;
      await this.post(
        '/cgi-bin/draft/update',
        {
          media_id: mediaId,
          index,
          articles: article,
        },
        '更新草稿'
      );
    },

    delete: async (mediaId: string): Promise<void> => {
      if (this.dryRun) return;
      await this.post(
        '/cgi-bin/draft/delete',
        { media_id: mediaId },
        '删除草稿'
      );
    },

    batchGet: async (offset = 0, count = 20, noContent: 0 | 1 = 0): Promise<DraftBatchGetResult> => {
      return await this.post<DraftBatchGetResult>(
        '/cgi-bin/draft/batchget',
        { offset, count, no_content: noContent },
        '批量获取草稿列表'
      );
    },
  };

  /**
   * Media APIs (uploadimg for body images)
   */
  public readonly media = {
    /**
     * Upload an article body image to WeChat (`cgi-bin/media/uploadimg`).
     * Returns permanent CDN URL: `https://mmbiz.qpic.cn/...`
     */
    uploadImage: async (buffer: Uint8Array | ArrayBuffer, filename: string): Promise<string> => {
      if (this.dryRun) {
        return `https://mmbiz.qpic.cn/dry_run/${encodeURIComponent(filename)}`;
      }

      const form = new FormData();
      const blob = new Blob([buffer as any], {
        type: filename.endsWith('.png') ? 'image/png' : 'image/jpeg',
      });
      form.append('media', blob, filename);

      const res = await this.postFormData<{ url: string }>(
        '/cgi-bin/media/uploadimg',
        form,
        '上传正文图片'
      );
      return res.url;
    },
  };

  /**
   * Material APIs (for permanent cover thumb_media_id)
   */
  public readonly material = {
    /**
     * Upload a permanent image material for draft cover (`cgi-bin/material/add_material?type=image`).
     * Returns `{ mediaId, url }`.
     */
    addImage: async (
      buffer: Uint8Array | ArrayBuffer,
      filename: string
    ): Promise<{ mediaId: string; url?: string }> => {
      if (this.dryRun) {
        return {
          mediaId: `dry-run-cover-${Date.now()}`,
          url: `https://mmbiz.qpic.cn/dry_run_cover/${encodeURIComponent(filename)}`,
        };
      }

      const form = new FormData();
      const blob = new Blob([buffer as any], {
        type: filename.endsWith('.png') ? 'image/png' : 'image/jpeg',
      });
      form.append('media', blob, filename);

      const res = await this.postFormData<{ media_id: string; url?: string }>(
        '/cgi-bin/material/add_material?type=image',
        form,
        '上传永久封面素材'
      );
      return {
        mediaId: res.media_id,
        url: res.url,
      };
    },

    delete: async (mediaId: string): Promise<void> => {
      if (this.dryRun) return;
      await this.post(
        '/cgi-bin/material/del_material',
        { media_id: mediaId },
        '删除永久素材'
      );
    },

    batchGet: async (
      type: 'image' | 'video' | 'voice' | 'news' = 'image',
      offset = 0,
      count = 20
    ): Promise<MaterialBatchGetResult> => {
      return await this.post<MaterialBatchGetResult>(
        '/cgi-bin/material/batchget_material',
        { type, offset, count },
        '批量获取永久素材'
      );
    },
  };

  /**
   * FreePublish APIs (`cgi-bin/freepublish/*`, reserved for certified Official Accounts)
   */
  public readonly publish = {
    submit: async (mediaId: string): Promise<{ publishId: string; msgDataId?: string }> => {
      if (this.dryRun) {
        return { publishId: `dry-run-publish-${Date.now()}` };
      }
      const res = await this.post<PublishSubmitResult>(
        '/cgi-bin/freepublish/submit',
        { media_id: mediaId },
        '提交发布草稿'
      );
      return {
        publishId: res.publish_id,
        msgDataId: res.msg_data_id,
      };
    },

    get: async (publishId: string): Promise<PublishStatusResult> => {
      return await this.post<PublishStatusResult>(
        '/cgi-bin/freepublish/get',
        { publish_id: publishId },
        '查询发布状态'
      );
    },

    batchGet: async (offset = 0, count = 20, noContent: 0 | 1 = 1): Promise<PublishBatchGetResult> => {
      return await this.post<PublishBatchGetResult>(
        '/cgi-bin/freepublish/batchget',
        { offset, count, no_content: noContent },
        '批量获取已发表文章列表'
      );
    },
  };

  /**
   * Internal HTTP POST helper with exponential backoff retry & token refresh handling.
   */
  private async post<T>(path: string, body: Record<string, unknown>, action: string): Promise<T> {
    let retries = 0;
    let tokenRefreshed = false;

    while (true) {
      const accessToken = await this.tokenManager.getAccessToken();
      const url = new URL(`${this.baseUrl}${path}`);
      url.searchParams.set('access_token', accessToken);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      let res: Response;
      try {
        res = await fetch(url.toString(), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err: any) {
        clearTimeout(timer);
        if (err.name === 'AbortError') {
          throw new Error(`[WeChat SDK]「${action}」请求超时 (${this.timeoutMs}ms)`);
        }
        if (retries < this.maxRetries) {
          retries++;
          await new Promise((r) => setTimeout(r, this.retryDelayMs * Math.pow(2, retries - 1)));
          continue;
        }
        throw new Error(`[WeChat SDK]「${action}」网络请求失败: ${err.message}`);
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        if (res.status >= 500 && retries < this.maxRetries) {
          retries++;
          await new Promise((r) => setTimeout(r, this.retryDelayMs * Math.pow(2, retries - 1)));
          continue;
        }
        throw new Error(`[WeChat SDK]「${action}」HTTP 状态异常: ${res.status} ${res.statusText}`);
      }

      let data: any;
      try {
        data = await res.json();
      } catch (err: any) {
        if (retries < this.maxRetries) {
          retries++;
          await new Promise((r) => setTimeout(r, this.retryDelayMs * Math.pow(2, retries - 1)));
          continue;
        }
        throw new Error(`[WeChat SDK]「${action}」响应 JSON 解析失败: ${err.message}`);
      }

      if (data.errcode && data.errcode !== 0) {
        const error = new WeChatError({
          errcode: data.errcode,
          errmsg: data.errmsg || 'Unknown error',
          action,
        });

        // If token expired, force refresh and retry once
        if (error.isTokenExpired() && !tokenRefreshed) {
          tokenRefreshed = true;
          await this.tokenManager.getAccessToken(true);
          continue;
        }
        throw error;
      }

      return data as T;
    }
  }

  /**
   * Internal multipart/form-data upload helper.
   */
  private async postFormData<T>(path: string, form: FormData, action: string): Promise<T> {
    let retries = 0;
    let tokenRefreshed = false;

    while (true) {
      const accessToken = await this.tokenManager.getAccessToken();
      const url = new URL(`${this.baseUrl}${path}`);
      url.searchParams.set('access_token', accessToken);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      let res: Response;
      try {
        res = await fetch(url.toString(), {
          method: 'POST',
          body: form,
          signal: controller.signal,
        });
      } catch (err: any) {
        clearTimeout(timer);
        if (err.name === 'AbortError') {
          throw new Error(`[WeChat SDK]「${action}」上传超时 (${this.timeoutMs}ms)`);
        }
        if (retries < this.maxRetries) {
          retries++;
          await new Promise((r) => setTimeout(r, this.retryDelayMs * Math.pow(2, retries - 1)));
          continue;
        }
        throw new Error(`[WeChat SDK]「${action}」上传网络错误: ${err.message}`);
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        if (res.status >= 500 && retries < this.maxRetries) {
          retries++;
          await new Promise((r) => setTimeout(r, this.retryDelayMs * Math.pow(2, retries - 1)));
          continue;
        }
        throw new Error(`[WeChat SDK]「${action}」上传 HTTP 状态异常: ${res.status} ${res.statusText}`);
      }

      let data: any;
      try {
        data = await res.json();
      } catch (err: any) {
        if (retries < this.maxRetries) {
          retries++;
          await new Promise((r) => setTimeout(r, this.retryDelayMs * Math.pow(2, retries - 1)));
          continue;
        }
        throw new Error(`[WeChat SDK]「${action}」上传响应 JSON 解析失败: ${err.message}`);
      }

      if (data.errcode && data.errcode !== 0) {
        const error = new WeChatError({
          errcode: data.errcode,
          errmsg: data.errmsg || 'Unknown upload error',
          action,
        });
        if (error.isTokenExpired() && !tokenRefreshed) {
          tokenRefreshed = true;
          await this.tokenManager.getAccessToken(true);
          continue;
        }
        throw error;
      }

      return data as T;
    }
  }
}
