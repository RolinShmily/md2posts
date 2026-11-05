import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import type { FsSourceOptions } from '@md2wechat/sources';

export interface AppConfig {
  source: FsSourceOptions;
  site: {
    url: string;
    postPath: string;
    author: string;
    license: string;
  };
  render: {
    theme: string;
    accent?: string;
    fontSize: number;
    fontFamily: 'theme' | 'sans' | 'serif' | 'rounded';
    macCode: boolean;
    galleryMode: 'stack' | 'grid' | 'collage';
    linksToFootnotes: boolean;
    shiftBodyHeadings: boolean;
    imageCaptionMode: 'smart' | 'none' | 'all';
    insertHeaderCover: boolean;
    appendCopyrightCard: boolean;
  };
  sync: {
    stateFile: string;
    maxPerRun: number;
    syncUpdated: boolean;
    defaultCover?: string;
    downloadRemoteImages: boolean;
    openComment: 0 | 1;
    onlyFansCanComment: 0 | 1;
  };
  wechat: {
    appId: string;
    appSecret: string;
  };
  notify?: {
    webhookUrl?: string;
    onSuccess?: boolean;
    onFailure?: boolean;
  };
}

function resolveConfigRelativePath(targetPath: string, baseDir: string): string {
  const trimmed = targetPath.trim();
  if (trimmed.startsWith('~/')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  if (trimmed.includes('{postDir}')) {
    return trimmed;
  }
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(baseDir, trimmed);
}

export function loadConfig(configPath?: string): AppConfig {
  let resolvedPath = configPath
    ? path.resolve(configPath)
    : path.resolve(process.cwd(), 'config.yaml');

  if (!configPath && !fs.existsSync(resolvedPath)) {
    const examplePath = path.resolve(process.cwd(), 'config.example.yaml');
    if (fs.existsSync(examplePath)) {
      resolvedPath = examplePath;
    }
  }
  const configDir = path.dirname(resolvedPath);

  let rawYaml = '';
  if (fs.existsSync(resolvedPath)) {
    rawYaml = fs.readFileSync(resolvedPath, 'utf8');
  }

  const parsed = rawYaml ? YAML.parse(rawYaml) || {} : {};

  // Resolve environment variables for sensitive credentials
  const appId = process.env.WECHAT_APPID || parsed.wechat?.appId || '';
  const appSecret = process.env.WECHAT_SECRET || parsed.wechat?.appSecret || '';

  const rawPostsRoot = parsed.source?.postsRoot || parsed.source?.root || '../SrP-BloG/content/posts';
  const rawRepoRoot = parsed.source?.repoRoot || '../SrP-BloG';
  const rawStateFile = parsed.sync?.stateFile || './state.json';
  const rawDefaultCover = parsed.sync?.defaultCover;
  const rawAssetRoots: string[] = Array.isArray(parsed.source?.assetRoots)
    ? parsed.source.assetRoots
    : ['{postDir}', '../SrP-BloG/public'];

  return {
    source: {
      postsRoot: resolveConfigRelativePath(rawPostsRoot, configDir),
      repoRoot: resolveConfigRelativePath(rawRepoRoot, configDir),
      layout: parsed.source?.layout || 'bundle',
      assetRoots: rawAssetRoots.map((r) => resolveConfigRelativePath(String(r), configDir)),
      gitPull: Boolean(parsed.source?.gitPull),
      siteUrl: parsed.site?.url || 'https://blog.srprolin.com',
      postPathPattern: parsed.site?.postPath || '/posts/{slug}/',
      fieldMapping: parsed.fields || {},
    },
    site: {
      url: parsed.site?.url || 'https://blog.srprolin.com',
      postPath: parsed.site?.postPath || '/posts/{slug}/',
      author: parsed.site?.author || 'RoL1n_SrP',
      license: parsed.site?.license || 'CC BY-NC-SA 4.0',
    },
    render: {
      theme: parsed.render?.theme || 'tech-blue',
      accent: parsed.render?.accent || undefined,
      fontSize: parsed.render?.fontSize || 15,
      fontFamily: parsed.render?.fontFamily || 'theme',
      macCode: parsed.render?.macCode !== false,
      galleryMode: parsed.render?.galleryMode || 'stack',
      linksToFootnotes: parsed.render?.linksToFootnotes !== false,
      shiftBodyHeadings: parsed.render?.shiftBodyHeadings !== false,
      imageCaptionMode: parsed.render?.imageCaptionMode || 'smart',
      insertHeaderCover: Boolean(parsed.render?.insertHeaderCover),
      appendCopyrightCard: parsed.render?.appendCopyrightCard !== false,
    },
    sync: {
      stateFile: resolveConfigRelativePath(rawStateFile, configDir),
      maxPerRun: parsed.sync?.maxPerRun || 5,
      syncUpdated: Boolean(parsed.sync?.syncUpdated),
      defaultCover: rawDefaultCover
        ? resolveConfigRelativePath(String(rawDefaultCover), configDir)
        : undefined,
      downloadRemoteImages: parsed.sync?.downloadRemoteImages !== false,
      openComment: parsed.sync?.openComment === 1 ? 1 : 0,
      onlyFansCanComment: parsed.sync?.onlyFansCanComment === 1 ? 1 : 0,
    },
    wechat: {
      appId,
      appSecret,
    },
    notify: {
      webhookUrl: process.env.MD2WECHAT_WEBHOOK_URL || parsed.notify?.webhookUrl || undefined,
      onSuccess: parsed.notify?.onSuccess !== false,
      onFailure: parsed.notify?.onFailure !== false,
    },
  };
}
