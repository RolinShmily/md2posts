/**
 * Preflight credential checks.
 *
 * Purpose: a headless/systemd run must fail fast and loudly when a target platform
 * has no usable credentials. Without this, every post fails with the same opaque API
 * error (e.g. WeChat `40013 invalid appid`), the run still exits 0, and systemd reports
 * "Finished" — so nobody notices the whole sync was a no-op.
 */

export interface CredentialStatus {
  ready: boolean;
  /** Blocking problems: the target cannot work until these are fixed. */
  errors: string[];
  /** Suspicious but non-blocking (e.g. malformed AppID); API will confirm. */
  warnings: string[];
}

const PLACEHOLDER_PATTERNS = [
  /^your[-_]?/i,
  /^<.*>$/,
  /^(changeme|change-me|placeholder|example|dummy|test|todo|xxx+)$/i,
  /^wx?x+$/i,
];

function isPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  return PLACEHOLDER_PATTERNS.some((re) => re.test(trimmed));
}

const ENV_HINT =
  '请在 config.yaml 的 wechat.appId / wechat.appSecret 填写后重启服务' +
  '（systemctl restart md2posts-sync.timer）。也可用环境变量 WECHAT_APPID / WECHAT_SECRET ' +
  '作为兜底，但 config.yaml 优先级更高。';

/**
 * Validates WeChat Official Account credentials before any network call.
 *
 * Only presence is checked for the secret: callers may hold a client whose secret is
 * private, and echoing secret material into logs must be avoided.
 */
export function checkWeChatCredentials(appId?: string, hasAppSecret = false): CredentialStatus {
  const errors: string[] = [];
  const warnings: string[] = [];
  const id = (appId || '').trim();

  if (!id) {
    errors.push(`微信 AppID 为空。${ENV_HINT}`);
  } else if (isPlaceholder(id)) {
    errors.push(`微信 AppID 仍是占位值 "${id}"。${ENV_HINT}`);
  } else if (!/^wx[0-9a-zA-Z]{16}$/.test(id)) {
    // Real AppIDs look like `wx` + 16 chars; a mismatch usually means a copy/paste slip
    // and the API answers 40013. Warn instead of blocking, to stay permissive.
    warnings.push(`微信 AppID "${id}" 格式不像官方 AppID（通常为 wx + 16 位字符），接口可能返回 40013`);
  }

  if (!hasAppSecret) {
    errors.push(`微信 AppSecret 为空或仍是占位值。${ENV_HINT}`);
  }

  return { ready: errors.length === 0, errors, warnings };
}

/**
 * Validates that a usable HeyBox session exists.
 */
export function checkHeyBoxSession(hasSession: boolean, sessionFile?: string): CredentialStatus {
  if (hasSession) return { ready: true, errors: [], warnings: [] };

  const where = sessionFile?.trim() || '(默认路径未找到)';
  return {
    ready: false,
    errors: [
      `未找到小黑盒登录凭据（期望位置: ${where}）。` +
        '有桌面环境的机器上运行 `pnpm cli login --to heybox` 扫码，然后把 session.json 复制到该路径；' +
        '或直接在该环境运行同一条命令完成浏览器登录。',
    ],
    warnings: [],
  };
}

export type PlatformTarget = 'wechat' | 'heybox';

export interface ResolvedTargets {
  /** Target(s) that actually run, narrowed by credential readiness. */
  effective: PlatformTarget | 'all';
  /** Requested but unusable targets: skipped with a warning, not fatal. */
  skipped: Array<{ target: PlatformTarget; status: CredentialStatus }>;
  /** True when nothing can run (every requested target is unready). */
  blocked: boolean;
}

/**
 * Narrows the requested target by credential readiness.
 *
 * A missing credential on one platform must never prevent the other platform from
 * syncing — only when *every* requested platform is unusable does the run abort.
 */
export function resolveTargets(
  requested: PlatformTarget | 'all',
  statuses: Record<PlatformTarget, CredentialStatus>
): ResolvedTargets {
  const wanted: PlatformTarget[] =
    requested === 'all' ? ['wechat', 'heybox'] : [requested];

  const ready = wanted.filter((t) => statuses[t].ready);
  const skipped = wanted
    .filter((t) => !statuses[t].ready)
    .map((t) => ({ target: t, status: statuses[t] }));

  if (ready.length === 0) {
    return { effective: requested === 'all' ? 'all' : requested, skipped, blocked: true };
  }

  const effective: PlatformTarget | 'all' =
    ready.length === wanted.length ? requested : (ready[0] as PlatformTarget);

  return { effective, skipped, blocked: false };
}

/**
 * Formats a credential failure into one actionable multi-line message.
 */
export function formatCredentialFailure(target: string, status: CredentialStatus): string {
  return [
    `[Preflight] 目标平台「${target}」凭据未就绪，已中止本次运行（未推送任何文章）：`,
    ...status.errors.map((e) => `  - ${e}`),
  ].join('\n');
}
