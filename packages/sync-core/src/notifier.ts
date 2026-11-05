import type { SyncReport } from './pipeline.js';

export interface NotifyConfig {
  webhookUrl?: string;
  onSuccess?: boolean;
  onFailure?: boolean;
}

/**
 * Sends optional webhook notifications (Feishu / Lark / WeCom / DingTalk / Generic JSON)
 * when articles are pushed or when sync errors occur.
 */
export async function sendSyncNotification(
  notifyConfig: NotifyConfig | undefined,
  report: SyncReport
): Promise<void> {
  const webhookUrl = (notifyConfig?.webhookUrl || process.env.MD2WECHAT_WEBHOOK_URL || '').trim();
  if (!webhookUrl) return;

  const hasPushed = report.pushed.length > 0;
  const hasFailed = report.failed.length > 0;

  const shouldNotifySuccess = notifyConfig?.onSuccess !== false && hasPushed;
  const shouldNotifyFailure = notifyConfig?.onFailure !== false && hasFailed;

  if (!shouldNotifySuccess && !shouldNotifyFailure) {
    return;
  }

  const lines: string[] = ['【md2wechat 公众号草稿同步通知】'];
  if (hasPushed) {
    lines.push(`✅ 成功推入草稿箱 (${report.pushed.length} 篇)：`);
    for (const item of report.pushed) {
      lines.push(`  • [${item.id}] ${item.normalizedTitle} (${item.isUpdate ? '更新' : '新建'})`);
    }
  }
  if (hasFailed) {
    lines.push(`❌ 同步失败 (${report.failed.length} 篇)：`);
    for (const fail of report.failed) {
      lines.push(`  • [${fail.id}] ${fail.error}`);
    }
  }
  if (report.skippedDueToLimit > 0) {
    lines.push(`⏳ 另有 ${report.skippedDueToLimit} 篇待下一轮同步。`);
  }

  const text = lines.join('\n');

  let body: Record<string, unknown>;
  if (/feishu\.cn|larksuite\.com/i.test(webhookUrl)) {
    body = { msg_type: 'text', content: { text } };
  } else if (/qyapi\.weixin\.qq\.com|oapi\.dingtalk\.com/i.test(webhookUrl)) {
    body = { msgtype: 'text', text: { content: text } };
  } else {
    body = {
      event: 'md2wechat_sync',
      text,
      pushedCount: report.pushed.length,
      failedCount: report.failed.length,
      timestamp: new Date().toISOString(),
    };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err: any) {
    console.warn(`[Notifier] 发送 Webhook 通知失败: ${err.message}`);
  }
}
