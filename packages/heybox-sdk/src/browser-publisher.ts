import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import type { HeyBoxPreparedResult } from './types.js';
import { HeyBoxError } from './errors.js';

export interface BrowserPublisherOptions {
  sessionFile?: string;
  browserChannel?: 'chrome' | 'msedge';
  headless?: boolean;
  timeoutMs?: number;
}

const DEFAULT_SESSION_FILE = path.resolve(process.cwd(), '.cache', 'heybox-session.json');
const CREATOR_ARTICLE_NEW_URL = 'https://www.xiaoheihe.cn/creator/editor/draft/article/new';

/**
 * Resolves the preferred browser channel installed on the system (Chrome or Edge).
 */
function resolveBrowserChannel(preferred?: 'chrome' | 'msedge'): 'chrome' | 'msedge' | undefined {
  if (preferred) return preferred;

  const isWin = process.platform === 'win32';
  if (isWin) {
    const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    if (fs.existsSync(chromePath)) return 'chrome';
    if (fs.existsSync(edgePath)) return 'msedge';
    return undefined;
  }

  const isMac = process.platform === 'darwin';
  if (isMac) {
    if (fs.existsSync('/Applications/Google Chrome.app')) return 'chrome';
    if (fs.existsSync('/Applications/Microsoft Edge.app')) return 'msedge';
    return undefined;
  }

  // Linux: check whether system Chrome or Edge binary actually exists
  const linuxChromePaths = [
    '/usr/bin/google-chrome',
    '/opt/google/chrome/chrome',
    '/usr/bin/google-chrome-stable',
  ];
  if (linuxChromePaths.some((p) => fs.existsSync(p))) return 'chrome';

  const linuxEdgePaths = ['/usr/bin/microsoft-edge', '/opt/microsoft/msedge/msedge'];
  if (linuxEdgePaths.some((p) => fs.existsSync(p))) return 'msedge';

  return undefined;
}

/**
 * Launches an interactive browser window for the user to log in to XiaoHeiHe Creator Center,
 * then captures and saves the session state to disk.
 */
export async function loginInteractively(
  options: {
    sessionFile?: string;
    browserChannel?: 'chrome' | 'msedge';
    timeoutMs?: number;
  } = {}
): Promise<string> {
  const sessionFile = options.sessionFile || DEFAULT_SESSION_FILE;
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });

  const channel = resolveBrowserChannel(options.browserChannel);
  console.log(`[HeyBox] 正在启动浏览器 (${channel || 'chromium'})...`);

  const browser = await chromium.launch({
    channel,
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 850 },
  });
  const page = await context.newPage();

  console.log(`[HeyBox] 正在前往小黑盒创作者中心登录页...`);
  await page.goto(CREATOR_ARTICLE_NEW_URL, { waitUntil: 'domcontentloaded' });

  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║  👉 请在弹出的浏览器窗口中完成小黑盒登录 (扫码或验证码)    ║');
  console.log('║  登录成功后脚本将自动捕获登录态并保存到本地缓存！          ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  const maxWaitMs = options.timeoutMs || 180_000; // 3 minutes
  const startTime = Date.now();
  let loggedIn = false;

  while (Date.now() - startTime < maxWaitMs) {
    await page.waitForTimeout(1500);

    // Check cookies for heybox_id (definitive proof of login on XiaoHeiHe)
    const cookies = await context.cookies().catch(() => []);
    const heyboxIdCookie = cookies.find(
      (c) => c.name === 'heybox_id' && c.value && c.value !== '0'
    );
    if (heyboxIdCookie) {
      await page.waitForTimeout(1000);
      loggedIn = true;
      break;
    }
  }

  if (!loggedIn) {
    await browser.close().catch(() => {});
    throw new HeyBoxError('登录超时（未在 3 分钟内完成登录），操作已取消。', 'LOGIN_TIMEOUT');
  }

  // Save session state with explicit user_id for full API compatibility
  const cookies = await context.cookies();
  const heyboxId = cookies.find((c) => c.name === 'heybox_id')?.value;
  const storageData = await context.storageState();
  const enhancedSession = {
    user_id: heyboxId || '',
    ...storageData,
  };
  fs.writeFileSync(sessionFile, JSON.stringify(enhancedSession, null, 2), 'utf8');
  await browser.close().catch(() => {});

  console.log(`✓ 登录成功！小黑盒登录态已保存至: ${sessionFile}`);
  return sessionFile;
}

/**
 * Checks whether a valid session file exists.
 */
export function hasSavedSession(sessionFile?: string): boolean {
  const target = sessionFile || DEFAULT_SESSION_FILE;
  if (!fs.existsSync(target)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(target, 'utf8'));
    return Array.isArray(data.cookies) && data.cookies.length > 0;
  } catch {
    return false;
  }
}

/**
 * Automatically publishes or saves draft to XiaoHeiHe using Playwright headless browser automation.
 */
export async function publishDraftWithBrowser(
  prepared: HeyBoxPreparedResult,
  options: BrowserPublisherOptions = {}
): Promise<{ draftId?: string; draftUrl?: string; message: string }> {
  const sessionFile = options.sessionFile || DEFAULT_SESSION_FILE;

  if (!hasSavedSession(sessionFile)) {
    throw new HeyBoxError(
      '未找到小黑盒登录凭据，请先执行登录命令 `pnpm cli login --to heybox`！',
      'NO_SESSION'
    );
  }

  const channel = resolveBrowserChannel(options.browserChannel);
  const headless = options.headless ?? true;

  console.log(`[HeyBox] 正在启动无头浏览器自动推流 (${channel || 'chromium'})...`);
  const browser = await chromium.launch({
    channel,
    headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const context = await browser.newContext({
      storageState: sessionFile,
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();

    console.log(`[HeyBox] 正在加载创作者中心文章编辑器...`);
    await page.goto(CREATOR_ARTICLE_NEW_URL, {
      waitUntil: 'domcontentloaded',
      timeout: options.timeoutMs || 30_000,
    });

    await page.waitForTimeout(1500);

    // 1. Verify Authentication Status
    const cookies = await context.cookies().catch(() => []);
    const hasHeyboxId = cookies.some(
      (c) => c.name === 'heybox_id' && c.value && c.value !== '0'
    );

    if (!hasHeyboxId) {
      throw new HeyBoxError(
        '小黑盒登录态已过期，请运行 `pnpm cli login --to heybox` 重新登录！',
        'AUTH_EXPIRED'
      );
    }

    // 2. Wait for Body and Title Editors
    const bodyEditorSelector = '.article__edit-content--inner > .ProseMirror';
    const titleEditorSelector = '.editor-article__title .ProseMirror, .editor-title__container .ProseMirror';

    await page.waitForSelector(bodyEditorSelector, { timeout: 15_000 });

    // 3. Set Title
    console.log(`[HeyBox] 正在填入文章标题: "${prepared.title}" ...`);
    await page.evaluate(
      ({ selector, title }) => {
        const titleEl = document.querySelector(selector) as HTMLElement | null;
        if (titleEl) {
          titleEl.focus();
          const sel = window.getSelection();
          if (sel) {
            sel.selectAllChildren(titleEl);
            document.execCommand('delete');
            document.execCommand('insertText', false, title);
          } else {
            titleEl.innerHTML = `<p>${title}</p>`;
          }
          titleEl.dispatchEvent(new Event('input', { bubbles: true }));
        }
      },
      { selector: titleEditorSelector, title: prepared.title }
    );

    await page.waitForTimeout(500);

    // 4. Inject Rich Text Body with Base64 Images
    console.log(`[HeyBox] 正在注入排版富文本与代码卡片图...`);
    const bodyEditor = page.locator(bodyEditorSelector);
    await bodyEditor.click();

    await page.evaluate(
      ({ selector, richHtml }) => {
        const bodyEl = document.querySelector(selector) as HTMLElement | null;
        if (bodyEl) {
          bodyEl.focus();
          const sel = window.getSelection();
          if (sel) {
            sel.selectAllChildren(bodyEl);
            document.execCommand('delete');
          }
          document.execCommand('insertHTML', false, richHtml);
          bodyEl.dispatchEvent(new Event('input', { bubbles: true }));
        }
      },
      { selector: bodyEditorSelector, richHtml: prepared.richHtml }
    );

    // 5. Wait for inline images to finish uploading
    console.log(`[HeyBox] 正在等待小黑盒处理并上传内联图片...`);
    await page
      .waitForFunction(
        () => {
          const uploading = document.querySelectorAll(
            '.article__image-item-uploading, .article__image-wrapper.loading'
          );
          return uploading.length === 0;
        },
        { timeout: 35_000 }
      )
      .catch(() => {
        console.warn(`[HeyBox] 等待图片全部上传提示超时，尝试继续保存草稿...`);
      });

    await page.waitForTimeout(1000);

    // 6. Click "保存草稿" Button
    console.log(`[HeyBox] 正在提交草稿箱...`);
    const saveDraftBtn = page.locator('button.editor-publish__save-draft');
    if (await saveDraftBtn.isVisible()) {
      await saveDraftBtn.click();
    } else {
      // Fallback click via text
      await page.getByText('保存草稿', { exact: true }).click();
    }

    // 7. Wait for URL change or draft save indicator
    await page.waitForTimeout(2000);
    const finalUrl = page.url();
    let draftId: string | undefined;

    if (finalUrl.includes('/draft/article/')) {
      draftId = finalUrl.split('/draft/article/')[1]?.split('?')[0];
    }

    // Update session state in case cookies were refreshed
    await context.storageState({ path: sessionFile }).catch(() => {});

    console.log(`✓ [HeyBox] 小黑盒草稿保存成功！(草稿ID: ${draftId || '已保存'})`);

    return {
      draftId,
      draftUrl: finalUrl,
      message: `已通过自动化无头浏览器成功保存至小黑盒草稿箱！(草稿地址: ${finalUrl})`,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}
