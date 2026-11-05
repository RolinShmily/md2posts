import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import type { WeChatClient } from '@md2wechat/wechat-sdk';
import type { StateStore } from './state-store.js';

export interface ProcessedImage {
  buffer: Buffer;
  format: 'png' | 'jpeg';
  filename: string;
  sha256: string;
  byteLength: number;
}

export interface ImageProcessorOptions {
  maxByteSize?: number;          // default 900KB
  maxWidth?: number;             // default 1920px
  downloadRemote?: boolean;      // default true
  remoteTimeoutMs?: number;      // default 15_000
}

/**
 * Resolves a local image reference against the post directory and configured assetRoots.
 */
export function resolveLocalAssetPath(
  rawRef: string,
  postDir: string,
  assetRoots: string[] = ['{postDir}']
): string | null {
  if (!rawRef || /^https?:\/\//i.test(rawRef) || rawRef.startsWith('data:')) {
    return null;
  }

  let decoded = rawRef.trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Keep raw if malformed percent-encoding
  }

  if (path.isAbsolute(decoded) && fs.existsSync(decoded) && fs.statSync(decoded).isFile()) {
    return decoded;
  }

  const cleanRel = decoded.replace(/^\.\/+/, '').replace(/^\/+/, '');
  const roots = assetRoots.length > 0 ? assetRoots : ['{postDir}'];

  for (const rootPattern of roots) {
    const rootDir = rootPattern.replace(/\{postDir\}/g, postDir);
    const candidate = path.resolve(rootDir, cleanRel);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  // Fallback directly in postDir
  const directCandidate = path.resolve(postDir, cleanRel);
  if (fs.existsSync(directCandidate) && fs.statSync(directCandidate).isFile()) {
    return directCandidate;
  }

  return null;
}

export class ImageProcessor {
  private readonly maxByteSize: number;
  private readonly maxWidth: number;
  private readonly downloadRemote: boolean;
  private readonly remoteTimeoutMs: number;

  constructor(options: ImageProcessorOptions = {}) {
    this.maxByteSize = options.maxByteSize ?? 900 * 1024; // 900KB (safe margin under WeChat 1MB limit)
    this.maxWidth = options.maxWidth ?? 1920;
    this.downloadRemote = options.downloadRemote ?? true;
    this.remoteTimeoutMs = options.remoteTimeoutMs ?? 15_000;
  }

  /**
   * Processes an image from a buffer or file path into a WeChat-safe format (JPG or PNG) <= 900KB.
   */
  public async processImage(
    input: Buffer | Uint8Array | string,
    originalFilename = 'image.png'
  ): Promise<ProcessedImage> {
    let rawBuf: Buffer;
    if (typeof input === 'string') {
      rawBuf = fs.readFileSync(input);
    } else {
      rawBuf = Buffer.isBuffer(input) ? input : Buffer.from(input);
    }

    const rawSha256 = crypto.createHash('sha256').update(rawBuf).digest('hex');
    const metadata = await sharp(rawBuf).metadata();
    const origFormat = (metadata.format || '').toLowerCase();
    const hasAlpha = Boolean(metadata.hasAlpha);

    // Fast path: already png/jpeg and within size limit
    if (
      (origFormat === 'png' || origFormat === 'jpeg' || origFormat === 'jpg') &&
      rawBuf.byteLength <= this.maxByteSize
    ) {
      const ext = origFormat === 'png' ? '.png' : '.jpg';
      const cleanName = `${path.basename(originalFilename, path.extname(originalFilename))}${ext}`;
      return {
        buffer: rawBuf,
        format: origFormat === 'png' ? 'png' : 'jpeg',
        filename: cleanName,
        sha256: rawSha256,
        byteLength: rawBuf.byteLength,
      };
    }

    // Try PNG first if image has alpha channel
    if (hasAlpha && (origFormat === 'png' || origFormat === 'webp')) {
      let pngPipeline = sharp(rawBuf).rotate();
      if (metadata.width && metadata.width > this.maxWidth) {
        pngPipeline = pngPipeline.resize({
          width: this.maxWidth,
          withoutEnlargement: true,
          fit: 'inside',
        });
      }
      const pngBuf = await pngPipeline.png({ compressionLevel: 9 }).toBuffer();
      if (pngBuf.byteLength <= this.maxByteSize) {
        const cleanName = `${path.basename(originalFilename, path.extname(originalFilename))}.png`;
        return {
          buffer: pngBuf,
          format: 'png',
          filename: cleanName,
          sha256: rawSha256,
          byteLength: pngBuf.byteLength,
        };
      }
    }

    // Progressive JPEG compression steps until <= maxByteSize
    const steps = [
      { width: this.maxWidth, quality: 85 },
      { width: 1600, quality: 78 },
      { width: 1280, quality: 70 },
      { width: 1024, quality: 60 },
    ];

    let outputBuf: Buffer | null = null;
    for (const step of steps) {
      let pipeline = sharp(rawBuf).rotate();
      if (hasAlpha) {
        pipeline = pipeline.flatten({ background: '#ffffff' });
      }
      const targetWidth = metadata.width ? Math.min(metadata.width, step.width) : step.width;
      pipeline = pipeline.resize({
        width: targetWidth,
        withoutEnlargement: true,
        fit: 'inside',
      });
      outputBuf = await pipeline.jpeg({ quality: step.quality, progressive: true }).toBuffer();
      if (outputBuf.byteLength <= this.maxByteSize) {
        break;
      }
    }

    const finalBuf = outputBuf!;
    const cleanName = `${path.basename(originalFilename, path.extname(originalFilename))}.jpg`;

    return {
      buffer: finalBuf,
      format: 'jpeg',
      filename: cleanName,
      sha256: rawSha256,
      byteLength: finalBuf.byteLength,
    };
  }

  /**
   * Fetches a remote image URL into a processed buffer.
   */
  public async fetchRemoteImage(url: string): Promise<ProcessedImage | null> {
    if (!this.downloadRemote) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.remoteTimeoutMs);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        },
      });

      if (!res.ok) {
        return null;
      }

      const arrayBuf = await res.arrayBuffer();
      const filename = path.basename(new URL(url).pathname) || 'remote.jpg';
      return await this.processImage(Buffer.from(arrayBuf), filename);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Resolves a Markdown image ref into a local file path or remote download,
   * checks cache BEFORE running sharp or network requests, uploads to WeChat if needed,
   * and returns the WeChat mmbiz URL.
   */
  public async resolveAndUploadImage(
    rawRef: string,
    postDir: string,
    client: WeChatClient,
    stateStore: StateStore,
    assetRoots: string[] = ['{postDir}']
  ): Promise<string | null> {
    if (/^https?:\/\//i.test(rawRef)) {
      const urlCacheKey = crypto.createHash('sha256').update(`url:${rawRef}`).digest('hex');
      const cachedByUrl = stateStore.getImage(urlCacheKey);
      if (cachedByUrl) {
        return cachedByUrl.wechatUrl;
      }

      const processed = await this.fetchRemoteImage(rawRef);
      if (!processed) {
        return null;
      }

      const cachedByContent = stateStore.getImage(processed.sha256);
      if (cachedByContent) {
        stateStore.setImage(urlCacheKey, cachedByContent);
        return cachedByContent.wechatUrl;
      }

      const wechatUrl = await client.media.uploadImage(processed.buffer, processed.filename);
      const entry = { wechatUrl, uploadedAt: new Date().toISOString() };
      stateStore.setImage(processed.sha256, entry);
      stateStore.setImage(urlCacheKey, entry);
      return wechatUrl;
    }

    const fullPath = resolveLocalAssetPath(rawRef, postDir, assetRoots);
    if (!fullPath) {
      return null;
    }

    // Check cache by raw file SHA-256 BEFORE invoking sharp
    const rawBuf = fs.readFileSync(fullPath);
    const rawSha256 = crypto.createHash('sha256').update(rawBuf).digest('hex');
    const cached = stateStore.getImage(rawSha256);
    if (cached) {
      return cached.wechatUrl;
    }

    const processed = await this.processImage(rawBuf, path.basename(fullPath));
    const wechatUrl = await client.media.uploadImage(processed.buffer, processed.filename);

    stateStore.setImage(rawSha256, {
      wechatUrl,
      uploadedAt: new Date().toISOString(),
    });

    return wechatUrl;
  }

  /**
   * Prepares and uploads a cover image to WeChat permanent material (`thumb_media_id`).
   * Checks SHA-256 cache before running sharp.
   */
  public async uploadCover(
    coverPath: string,
    client: WeChatClient,
    stateStore: StateStore
  ): Promise<{ mediaId: string; url?: string }> {
    const rawBuf = fs.readFileSync(coverPath);
    const rawSha256 = crypto.createHash('sha256').update(rawBuf).digest('hex');

    const cached = stateStore.getCover(rawSha256);
    if (cached) {
      return { mediaId: cached.mediaId, url: cached.wechatUrl };
    }

    const processed = await this.processImage(rawBuf, path.basename(coverPath));
    const res = await client.material.addImage(processed.buffer, processed.filename);

    stateStore.setCover(rawSha256, {
      mediaId: res.mediaId,
      wechatUrl: res.url,
      uploadedAt: new Date().toISOString(),
    });

    return res;
  }
}
