import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import type { FsSourceOptions } from '@md2posts/sources';

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
    target?: 'wechat' | 'heybox' | 'all';
    platforms?: ('wechat' | 'heybox')[];
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
  heybox?: {
    sessionFile?: string;
    browserChannel?: 'chrome' | 'msedge';
    headless?: boolean;
    codeBlockMode?: 'auto' | 'terminal' | 'image';
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
  // Tokens are expanded later, once the concrete post (and its Git repo root) is known.
  if (trimmed.includes('{postDir}') || trimmed.includes('{repoRoot}')) {
    return trimmed;
  }
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(baseDir, trimmed);
}

function loadEnvFile(envPath: string): void {
  if (!fs.existsSync(envPath)) return;
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        if (process.env[key] === undefined) {
          process.env[key] = val;
        }
      }
    }
  } catch {
    // Ignore unreadable env files
  }
}

export function loadConfig(configPath?: string): AppConfig {
  let resolvedPath = configPath
    ? path.resolve(configPath)
    : path.resolve(process.cwd(), 'config.yaml');

  if (!configPath && !fs.existsSync(resolvedPath)) {
    const canonicalExample = path.resolve(process.cwd(), 'config.yaml.example');
    const legacyExample = path.resolve(process.cwd(), 'config.example.yaml');
    if (fs.existsSync(canonicalExample)) {
      resolvedPath = canonicalExample;
    } else if (fs.existsSync(legacyExample)) {
      resolvedPath = legacyExample;
    }
  }
  const configDir = path.dirname(resolvedPath);

  // Automatically load local .env if present without requiring external dependencies
  loadEnvFile(path.join(configDir, '.env'));
  loadEnvFile(path.resolve(process.cwd(), '.env'));
  loadEnvFile('/etc/md2posts/md2posts.env');

  let rawYaml = '';
  let parsed: any = {};
  if (fs.existsSync(resolvedPath)) {
    rawYaml = fs.readFileSync(resolvedPath, 'utf8');
    try {
      parsed = YAML.parse(rawYaml) || {};
    } catch (err: any) {
      console.warn(`[配置警告] 配置文件 ${resolvedPath} 解析失败 (YAML 语法/缩进错误): ${err.message}`);
      console.warn(`           建议重新执行 \`cp config.yaml.example config.yaml\` 进行重置。\n`);
      parsed = {};
    }
  }

  // Resolve environment variables for sensitive credentials.
  // Environment wins over config.yaml, which is convenient for containers/systemd but makes
  // "the config looks right yet the API says invalid appid" very hard to diagnose — so any
  // divergence is reported explicitly.
  const configAppId = String(parsed.wechat?.appId || '').trim();
  const configAppSecret = String(parsed.wechat?.appSecret || '').trim();
  const envAppId = (process.env.WECHAT_APPID || '').trim();
  const envAppSecret = (process.env.WECHAT_SECRET || '').trim();

  if (envAppId && configAppId && envAppId !== configAppId) {
    console.warn(
      `[Config] 环境变量 WECHAT_APPID (${envAppId.slice(0, 6)}…) 与 config.yaml 中的 AppID 不一致，` +
        '将使用环境变量。若接口报 40013，请检查 /etc/md2posts/md2posts.env 或 shell 环境。'
    );
  }
  if (envAppSecret && configAppSecret && envAppSecret !== configAppSecret) {
    console.warn(
      '[Config] 环境变量 WECHAT_SECRET 与 config.yaml 中的 AppSecret 不一致，将使用环境变量。'
    );
  }

  const appId = envAppId || configAppId;
  const appSecret = envAppSecret || configAppSecret;

  const rawRepoUrl = parsed.source?.repoUrl ? String(parsed.source.repoUrl).trim() : undefined;
  const rawGitRemote = parsed.source?.gitRemote || parsed.source?.remote || 'origin';
  const rawGitBranch = parsed.source?.gitBranch || parsed.source?.branch || 'main';
  const rawPostsPath = parsed.source?.postsPath || 'content/posts';
  const rawGitPull = Boolean(parsed.source?.gitPull ?? rawRepoUrl); // 若配置了 repoUrl 则默认开启拉取
  const rawPostsRoot = parsed.source?.postsRoot || parsed.source?.root;
  const rawRepoRoot = parsed.source?.repoRoot;
  const rawStateFile = parsed.sync?.stateFile || './state.json';
  const rawDefaultCover = parsed.sync?.defaultCover;
  const rawAssetRoots: string[] = Array.isArray(parsed.source?.assetRoots)
    ? parsed.source.assetRoots
    : ['{postDir}', '{repoRoot}/public'];

  const siteUrl = (parsed.site?.url || 'https://blog.example.com').replace(/\/+$/, '');

  return {
    source: {
      postsRoot: rawPostsRoot ? resolveConfigRelativePath(rawPostsRoot, configDir) : undefined,
      postsPath: rawPostsPath,
      repoRoot: rawRepoRoot ? resolveConfigRelativePath(rawRepoRoot, configDir) : undefined,
      repoUrl: rawRepoUrl,
      gitRemote: String(rawGitRemote).trim(),
      gitBranch: String(rawGitBranch).trim(),
      layout: parsed.source?.layout || 'bundle',
      assetRoots: rawAssetRoots.map((r) => resolveConfigRelativePath(String(r), configDir)),
      gitPull: rawGitPull,
      sortOrder: (parsed.source?.sortOrder as 'asc' | 'desc') || 'asc',
      siteUrl,
      postPathPattern: parsed.site?.postPath || '/posts/{slug}/',
      fieldMapping: parsed.fields || {},
    },
    site: {
      url: siteUrl,
      postPath: parsed.site?.postPath || '/posts/{slug}/',
      author: parsed.site?.author || 'Author',
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
      target: (parsed.sync?.target || 'wechat').toLowerCase(),
      platforms: Array.isArray(parsed.sync?.platforms)
        ? parsed.sync.platforms
        : (parsed.sync?.target || 'wechat') === 'all'
        ? ['wechat', 'heybox']
        : [(parsed.sync?.target || 'wechat') as 'wechat' | 'heybox'],
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
    heybox: {
      sessionFile: parsed.heybox?.sessionFile
        ? resolveConfigRelativePath(parsed.heybox.sessionFile, configDir)
        : undefined,
      browserChannel: parsed.heybox?.browserChannel,
      headless: parsed.heybox?.headless !== false,
      codeBlockMode: parsed.heybox?.codeBlockMode,
    },
    notify: {
      webhookUrl:
        process.env.MD2POSTS_WEBHOOK_URL ||
        process.env.MD2WECHAT_WEBHOOK_URL ||
        parsed.notify?.webhookUrl ||
        undefined,
      onSuccess: parsed.notify?.onSuccess !== false,
      onFailure: parsed.notify?.onFailure !== false,
    },
  };
}
