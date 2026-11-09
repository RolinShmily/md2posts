import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import sharp from 'sharp';
import MarkdownIt from 'markdown-it';
import {
  getSignedParams,
  getWorkshopParams,
  getCosAuthorization,
} from './signing.js';
import { HeyBoxError } from './errors.js';

export interface HeyBoxSession {
  userId: string;
  cookieHeader: string;
  cookies: Array<{ name: string; value: string; domain?: string; path?: string }>;
}

export interface UploadedMediaResult {
  url: string;
  width: number;
  height: number;
  filename: string;
}

export interface CreateDraftResult {
  draftId: string;
  shareUrl?: string;
  raw: any;
}

export function resolveDefaultSessionPath(): string {
  if (process.env.XHH_OPERATOR_HOME) {
    return path.join(path.resolve(process.env.XHH_OPERATOR_HOME), 'session.json');
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'xiaoheihe-cli', 'session.json');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'xiaoheihe-cli', 'session.json');
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'xiaoheihe-cli', 'session.json');
}

export function resolveHeyBoxSessionFile(specified?: string): string {
  if (specified && specified.trim()) {
    return path.resolve(specified.trim());
  }
  const localCache = path.resolve(process.cwd(), '.cache', 'heybox-session.json');
  if (fs.existsSync(localCache)) return localCache;

  const defaultSys = resolveDefaultSessionPath();
  if (fs.existsSync(defaultSys)) return defaultSys;

  return localCache;
}

/**
 * Builds the exact `<img>` shape XiaoHeiHe's editor itself produces.
 *
 * Verified empirically against the official editor output:
 * - `data-original` only  -> 1 image node (correct)
 * - `src` + `data-original` -> 2 image nodes (duplicated, one squashed thumb)
 * - `src` only            -> 2 image nodes
 *
 * So we must never emit a `src` attribute here.
 */
export function toXiaoHeiHeImgTag(media: {
  url: string;
  width: number;
  height: number;
}): string {
  return `<img data-original="${media.url}" data-width="${media.width}" data-height="${media.height}" />`;
}

export class HeyBoxApiClient {
  private readonly sessionPath: string;
  private session: HeyBoxSession | null = null;
  private readonly baseUrl = 'https://api.xiaoheihe.cn';

  constructor(sessionFile?: string) {
    this.sessionPath = resolveHeyBoxSessionFile(sessionFile);
  }

  /**
   * Loads session from disk. Returns null if file not found or invalid.
   */
  public getSession(): HeyBoxSession | null {
    if (this.session) return this.session;
    if (!fs.existsSync(this.sessionPath)) return null;

    try {
      const data = JSON.parse(fs.readFileSync(this.sessionPath, 'utf8'));
      if (!Array.isArray(data.cookies) || data.cookies.length === 0) {
        return null;
      }
      const userId =
        data.user_id ||
        data.cookies.find((c: any) => c.name === 'heybox_id')?.value ||
        data.cookies.find((c: any) => c.name === 'user_id')?.value;

      if (!userId) {
        return null;
      }

      const cookieHeader = data.cookies
        .map((c: any) => `${c.name}=${c.value}`)
        .join('; ');

      this.session = {
        userId: String(userId),
        cookieHeader,
        cookies: data.cookies,
      };
      return this.session;
    } catch {
      return null;
    }
  }

  public hasSession(): boolean {
    return this.getSession() !== null;
  }

  /**
   * Dispatches signed request to XiaoHeiHe API.
   */
  public async request(
    reqPath: string,
    options: {
      params?: Record<string, string | number>;
      form?: Record<string, string>;
      isWrite?: boolean;
    } = {}
  ): Promise<any> {
    const session = this.getSession();
    if (!session) {
      throw new HeyBoxError('未找到小黑盒登录凭据，请先执行登录或配置 sessionFile！', 'NO_SESSION');
    }

    const sp = getSignedParams(reqPath);
    const queryParams: Record<string, string> = {
      os_type: 'web',
      app: 'heybox',
      client_type: 'web',
      version: '999.0.4',
      web_version: '3.0',
      x_app: 'heybox_website',
      x_client_type: 'web',
      x_os_type: 'Mac',
      hkey: sp.hkey,
      _time: String(sp._time),
      nonce: sp.nonce,
    };

    if (options.isWrite || options.form) {
      const extra = getWorkshopParams(sp);
      queryParams._rnd = extra._rnd;
    }

    if (options.params) {
      for (const [k, v] of Object.entries(options.params)) {
        queryParams[k] = String(v);
      }
    }

    const qs = new URLSearchParams(queryParams).toString();
    const url = `${this.baseUrl}${reqPath}?${qs}`;

    const reqHeaders: Record<string, string> = {
      Cookie: session.cookieHeader,
      'User-Agent': 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36',
      Origin: 'https://www.xiaoheihe.cn',
      Referer: 'https://www.xiaoheihe.cn/',
      Accept: 'application/json',
    };

    const fetchOptions: RequestInit = {
      method: options.form ? 'POST' : 'GET',
      headers: reqHeaders,
    };

    if (options.form) {
      const fd = new URLSearchParams();
      for (const [k, v] of Object.entries(options.form)) {
        fd.append(k, v);
      }
      fetchOptions.body = fd.toString();
      reqHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    const resp = await fetch(url, fetchOptions);
    if (!resp.ok) {
      throw new HeyBoxError(`小黑盒 API 网络异常 (HTTP ${resp.status})`, 'NETWORK_ERROR');
    }

    const data: any = await resp.json();
    if (data.status !== 'ok') {
      if (['relogin', 'not_login', 'need_login', 'login_required'].includes(data.status)) {
        throw new HeyBoxError('小黑盒登录态已过期，请重新登录！', 'AUTH_EXPIRED');
      }
      throw new HeyBoxError(
        data.msg || data.error?.message || `小黑盒 API 请求失败 (${data.status})`,
        data.status
      );
    }

    return data;
  }

  /**
   * Uploads an image Buffer directly to XiaoHeiHe's Tencent Cloud COS bucket.
   */
  public async uploadImage(
    buffer: Buffer,
    filename: string,
    mimetype = 'image/png'
  ): Promise<UploadedMediaResult> {
    const meta = await sharp(buffer).metadata();
    const width = meta.width || 800;
    const height = meta.height || 600;

    // 1. Get COS upload info
    const infoRes = await this.request('/bbs/app/api/qcloud/cos/upload/info/v2', {
      form: {
        file_infos: JSON.stringify([
          {
            filename,
            fsize: buffer.length,
            width,
            height,
            mimetype,
          },
        ]),
        scope: 'bbs',
        need_cache: '0',
      },
    });

    const info = infoRes.result || {};
    const key = info.keys?.[0];
    const bucket = info.bucket;
    const region = info.region || 'ap-shanghai';

    if (!key || !bucket) {
      throw new HeyBoxError('获取小黑盒上传节点失败', 'COS_INFO_FAILED');
    }

    // 2. Get COS upload token
    const tokenRes = await this.request('/bbs/app/api/qcloud/cos/upload/token/v2', {
      form: {
        bucket,
        keys: JSON.stringify([key]),
        mimetypes: JSON.stringify([mimetype]),
        is_multipart_upload: '0',
      },
    });

    const token = tokenRes.result || {};
    const creds = token.credentials;
    const start = parseInt(token.startTime, 10);
    const end = parseInt(token.expiredTime, 10);

    if (!creds?.tmpSecretId || !creds?.tmpSecretKey || !creds?.sessionToken) {
      throw new HeyBoxError('获取腾讯云 COS 上传凭据失败', 'COS_TOKEN_FAILED');
    }

    // 3. Direct HTTP PUT to Tencent Cloud COS
    const host = `${bucket}.cos.${region}.myqcloud.com`;
    const cosPath = '/' + key.replace(/^\/+/, '');
    const auth = getCosAuthorization(
      creds,
      'PUT',
      cosPath,
      { host, 'content-type': mimetype },
      start,
      end
    );

    const putResp = await fetch(`https://${host}${cosPath}`, {
      method: 'PUT',
      headers: {
        Host: host,
        'Content-Type': mimetype,
        'Content-Length': String(buffer.length),
        'x-cos-security-token': creds.sessionToken,
        Authorization: auth,
      },
      body: new Uint8Array(buffer),
    });

    if (!putResp.ok) {
      throw new HeyBoxError(`上传图片至腾讯云 COS 失败 (HTTP ${putResp.status})`, 'COS_PUT_FAILED');
    }

    // 4. Callback to finalize
    const callbackRes = await this.request('/bbs/app/api/qcloud/cos/upload/callback/v2', {
      params: { is_finished: 'true' },
      form: { keys: JSON.stringify([key]) },
    });

    const previewUrls = callbackRes.result?.preview_urls;
    if (!Array.isArray(previewUrls) || !previewUrls[0]) {
      throw new HeyBoxError('完成上传时未返回图片 CDN 链接', 'COS_CALLBACK_FAILED');
    }

    return {
      url: previewUrls[0],
      width,
      height,
      filename,
    };
  }

  /**
   * Resolves communities / hashtags to XiaoHeiHe topic IDs.
   */
  public async resolveTopics(
    communities: string[] = [],
    hashtags: string[] = []
  ): Promise<{ topicIds: string; hashtagList: string[] }> {
    const topicIdList: string[] = [];
    const validHashtags: string[] = [];

    // Search communities
    for (const name of communities) {
      if (!name.trim()) continue;
      try {
        const resp = await this.request('/bbs/app/api/post_editor/topic_selection/search', {
          params: { q: name.trim(), only_hashtag: '0' },
        });
        const items = resp.result?.search_result || [];
        const match = items.find(
          (it: any) =>
            it.search_type === 'topic' &&
            (it.name === name.trim() || it.title === name.trim())
        );
        if (match?.topic_id) {
          topicIdList.push(String(match.topic_id));
        }
      } catch {}
    }

    // Search hashtags
    for (const tag of hashtags) {
      if (!tag.trim()) continue;
      try {
        const resp = await this.request('/bbs/app/api/post_editor/topic_selection/search', {
          params: { q: tag.trim(), only_hashtag: '0' },
        });
        const items = resp.result?.search_result || [];
        const match = items.find(
          (it: any) =>
            it.search_type === 'hashtag' &&
            (it.name === tag.trim() || it.name === tag.trim().toLowerCase())
        );
        if (match?.name) {
          validHashtags.push(match.name);
        }
      } catch {}
    }

    return {
      topicIds: topicIdList.join(','),
      hashtagList: validHashtags,
    };
  }

  /**
   * Publishes or saves an article draft directly to XiaoHeiHe via pure TypeScript API.
   */
  public async createArticleDraft(params: {
    title: string;
    markdown: string;
    richHtml?: string;
    images?: Array<{ buffer: Buffer; filename: string; mimetype?: string }>;
    communities?: string[];
    hashtags?: string[];
    onProgress?: (current: number, total: number, filename: string) => void;
  }): Promise<CreateDraftResult> {
    const { title, images = [], communities = [], hashtags = [] } = params;

    let renderedHtml = params.richHtml;
    if (!renderedHtml) {
      const md = new MarkdownIt({ html: true, breaks: true, linkify: false });
      md.renderer.rules.heading_open = (tokens, idx) => {
        const level = parseInt(tokens[idx].tag.slice(1), 10);
        return `<${level <= 2 ? 'h2' : 'h3'}>`;
      };
      md.renderer.rules.heading_close = (tokens, idx) => {
        const level = parseInt(tokens[idx].tag.slice(1), 10);
        return `</${level <= 2 ? 'h2' : 'h3'}>\n`;
      };
      renderedHtml = md.render(params.markdown);
    }

    // 2. Upload all images to Tencent Cloud COS (deduplicated by content hash)
    const uploadedImages: UploadedMediaResult[] = [];
    // Content hash -> upload result, so identical bytes are only uploaded once
    // even when they appear under multiple filenames.
    const uploadsByHash = new Map<string, UploadedMediaResult>();

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      if (params.onProgress) {
        params.onProgress(i + 1, images.length, img.filename);
      }

      const contentHash = crypto.createHash('sha256').update(img.buffer).digest('hex');
      let res = uploadsByHash.get(contentHash);
      if (!res) {
        res = await this.uploadImage(img.buffer, img.filename, img.mimetype || 'image/png');
        uploadsByHash.set(contentHash, res);
      } else {
        console.log(`[HeyBox] 跳过重复素材（内容相同）：${img.filename}`);
      }
      // Keep the filename alias so HTML replacement still resolves this reference.
      uploadedImages.push({ ...res, filename: img.filename });

      const cleanName = path.basename(img.filename);

      // Replace both regular body images and the cover. The cover now also appears at the top
      // of the body for HeyBox, so its inlined Base64 must be swapped for the CDN tag too.
      {
        const rawName = cleanName;
        const encName = encodeURIComponent(cleanName);
        const candidates = rawName === encName ? [rawName] : [rawName, encName];

        // IMPORTANT: XiaoHeiHe's editor emits `<img data-original=... data-width=... data-height=...>`
        // with NO `src` attribute. When `src` is present the editor materializes TWO image nodes
        // per tag (a squashed thumb + a cropped full-size copy), so images appear duplicated.
        const imgTag = toXiaoHeiHeImgTag(res);

        for (const name of candidates) {
          const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regex = new RegExp(`<img\\b[^>]*?\\bsrc=["'](?:\\./)?(?:assets/)?${escaped}["'][^>]*>`, 'gi');
          renderedHtml = renderedHtml.replace(regex, imgTag);
        }

        // Also replace inlined Base64 data URL if present
        const b64Prefix = `data:${img.mimetype || 'image/png'};base64,${img.buffer.slice(0, 48).toString('base64').slice(0, 32)}`;
        const b64Regex = new RegExp(
          `<img\\b[^>]*?\\bsrc=["']${b64Prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"']*["'][^>]*>`,
          'gi'
        );
        renderedHtml = renderedHtml.replace(b64Regex, imgTag);
      }
    }

    // 3. Resolve topic and hashtag IDs
    const selection = await this.resolveTopics(communities, hashtags);

    // 4. Build XiaoHeiHe blocks payload:
    // Block 0 MUST contain the entire article HTML.
    // XiaoHeiHe article API treats Block 0 as the full article body, and subsequent blocks as media metadata.
    const seenImageUrls = new Set<string>();
    const imageBlocks: Array<{ type: string; url: string; width: string; height: string }> = [];
    for (const img of uploadedImages) {
      if (img.filename.includes('cover')) continue;
      if (seenImageUrls.has(img.url)) continue; // identical bytes already listed
      seenImageUrls.add(img.url);
      imageBlocks.push({
        type: 'img',
        url: img.url,
        width: String(img.width),
        height: String(img.height),
      });
    }

    const blocks: any[] = [{ type: 'html', text: renderedHtml }, ...imageBlocks];

    const form: Record<string, string> = {
      title,
      text: JSON.stringify(blocks),
      post_type: '1',
      link_tag: '11',
      draft: '1',
      view_limit: '1',
      original: '1',
      words_count: String(renderedHtml.replace(/<[^>]+>/g, '').length),
    };

    if (selection.topicIds) {
      form.topic_ids = selection.topicIds;
    }
    if (selection.hashtagList.length > 0) {
      form.hashtags = JSON.stringify(selection.hashtagList);
    }

    // 5. Submit post draft
    const postRes = await this.request('/bbs/app/api/link/post', {
      form,
      isWrite: true,
    });

    const draftId = String(postRes.link_id || postRes.result?.link_id || postRes.result?.link?.link_id || '');
    const shareUrl = postRes.result?.link?.share_url || (draftId ? `https://api.xiaoheihe.cn/v3/bbs/app/api/web/share?link_id=${draftId}` : undefined);

    return {
      draftId,
      shareUrl,
      raw: postRes,
    };
  }
}
