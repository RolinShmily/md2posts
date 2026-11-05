export interface WeChatErrorDetail {
  errcode: number;
  errmsg: string;
  action?: string;
  extractedIp?: string;
}

export class WeChatError extends Error {
  public readonly errcode: number;
  public readonly errmsg: string;
  public readonly action?: string;
  public readonly extractedIp?: string;
  public readonly friendlyMessage: string;

  constructor(detail: WeChatErrorDetail) {
    const { errcode, errmsg, action, extractedIp } = detail;
    const friendly = formatWeChatErrorMessage(errcode, errmsg, action, extractedIp);
    super(`[WeChat API Error ${errcode}] ${friendly} (${errmsg})`);
    this.name = 'WeChatError';
    this.errcode = errcode;
    this.errmsg = errmsg;
    this.action = action;
    this.extractedIp = extractedIp;
    this.friendlyMessage = friendly;
  }

  /**
   * True when the error indicates an expired or invalidated token that can be refreshed.
   */
  public isTokenExpired(): boolean {
    return this.errcode === 40001 || this.errcode === 42001 || this.errcode === 40014;
  }

  /**
   * True when the error is an IP whitelist rejection.
   */
  public isIpWhitelistRejection(): boolean {
    return this.errcode === 40164;
  }

  /**
   * True when the error indicates account capability / certification permission denial.
   */
  public isUnauthorized(): boolean {
    return this.errcode === 48001;
  }

  /**
   * True when quota is exhausted.
   */
  public isQuotaExceeded(): boolean {
    return this.errcode === 45009;
  }

  /**
   * True when the error indicates an invalid or deleted media_id (e.g. draft was deleted/published in MP backend).
   */
  public isInvalidMediaId(): boolean {
    return (
      this.errcode === 40007 ||
      /invalid media_id|media_id.*not exist|no such media/i.test(this.errmsg)
    );
  }

  /**
   * True when the error is a non-recoverable config/auth/quota/payload error that should not fallback from update to add.
   */
  public isNonFallbackError(): boolean {
    return (
      this.isIpWhitelistRejection() ||
      this.isUnauthorized() ||
      this.isQuotaExceeded() ||
      this.errcode === 40001 ||
      this.errcode === 40013 ||
      this.errcode === 45001 ||
      this.errcode === 45002 ||
      this.errcode === 45003 ||
      this.errcode === 45004
    );
  }
}

export function extractIpFromErrorMessage(errmsg: string): string | undefined {
  // Typical errmsg: "invalid ip 1.2.3.4 ipv6 ::1, not in whitelist rid: ..."
  const match = errmsg.match(/invalid ip\s+([0-9a-fA-F:.]+)/i);
  return match ? match[1].trim() : undefined;
}

export function formatWeChatErrorMessage(
  errcode: number,
  errmsg: string,
  action?: string,
  extractedIp?: string
): string {
  const ip = extractedIp || extractIpFromErrorMessage(errmsg);
  const actionPrefix = action ? `执行「${action}」失败：` : '';

  switch (errcode) {
    case 40001:
      return `${actionPrefix}AppSecret 错误或 access_token 无效。请检查环境变量 WECHAT_SECRET 是否正确。`;
    case 40013:
      return `${actionPrefix}AppID 无效。请检查环境变量 WECHAT_APPID 是否正确。`;
    case 40164:
      return `${actionPrefix}当前服务器出口 IP (${ip || '未知'}) 未加入微信公众号 IP 白名单。请前往「微信公众平台 -> 开发 -> 基本配置 -> IP白名单」添加该 IP。`;
    case 42001:
      return `${actionPrefix}access_token 已超时过期，已触发自动刷新。`;
    case 45009:
      return `${actionPrefix}接口今日调用频次已达公众号上限（45009），请明天再试。`;
    case 48001:
      return `${actionPrefix}API 功能未授权（48001）。当前公众号账号主体（个人主体或未认证）无权调用该接口。`;
    case 40007:
      return `${actionPrefix}不合法的 media_id（40007）。可能封面素材已被删除或已失效。`;
    case 45001:
      return `${actionPrefix}多媒体文件大小超出限制（45001）。`;
    case 45002:
      return `${actionPrefix}图文消息正文字数或 HTML 体积超过微信限制（45002）。微信要求纯文本少于 2 万字且 HTML < 1MB。`;
    case 45003:
      return `${actionPrefix}文章标题过长（45003）。微信要求标题不超过 32 个字。`;
    case 45004:
      return `${actionPrefix}文章摘要过长（45004）。微信要求摘要不超过 120 个字。`;
    default:
      return `${actionPrefix}微信接口返回错误 (代码 ${errcode})：${errmsg}`;
  }
}
