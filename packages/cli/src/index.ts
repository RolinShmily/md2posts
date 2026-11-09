#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { WeChatClient } from '@md2posts/wechat-sdk';
import { HeyBoxClient } from '@md2posts/heybox-sdk';
import { listThemes } from '@md2posts/renderer';
import {
  loadConfig,
  SyncPipeline,
  parseArticleSelection,
  CheckPostItem,
  StateStore,
} from '@md2posts/sync-core';

function printBanner() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║       md2posts - Markdown 博客多平台排版与同步工具        ║');
  console.log('║       支持: 微信公众号草稿箱 (WeChat) | 小黑盒 (HeyBox)    ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');
}

function printUsage() {
  printBanner();
  console.log(`用法（在仓库根目录执行，可先运行 pnpm build）:
  pnpm cli <command> [options]

命令:
  diagnose                微信 API 与出口 IP 白名单诊断（只读，不修改文件）
  check                   离线扫描博客：报告【新增待同步】与【已修改可手动推】文章（零微信请求）
  baseline                将当前已发布文章标记为基线（--status 查看位置/篇数，--import <file> 从其他机器导入）
  preview <slug>          离线渲染指定文章为独立页面（支持 --to wechat 或 --to heybox）
  push [slug1 slug2 ...]  推送文章到草稿箱（支持 --to wechat / heybox / all，不传 slug 进入勾选列表）
  sync                    自动增量同步【新文章】到草稿箱（默认忽略老文章修改，受 maxPerRun 限制）
  login                   登录并保存平台凭据 (例如: pnpm cli login --to heybox)
  themes                  列出内置的 28 套精美主题

通用选项:
  --to <platform>         目标发布平台: wechat (默认) | heybox (小黑盒) | all (双端同步)
  -c, --config <path>     指定配置文件路径 (默认: ./config.yaml)
  --pull                  强制执行 git pull 拉取博客仓库更新
  --no-pull               强制跳过 git pull
  --repo <path>           指定/切换要 pull 的本地 Git 博客仓库路径（留空则自动从 postsRoot 寻找 .git）
  --posts <path>          指定/切换博客文章所在目录 (如: /path/to/blog/content/posts)
  --branch <name>         指定 pull 的 Git 分支名 (默认: main 或当前分支)
  --sort <asc|desc>       文章列表排序方式: asc (默认，从第 1 篇顺排) | desc (倒序，最新发表在最前)
  --asc / --desc          快捷指定正序或倒序
  -i, --select            进入交互式文章选择推送模式
  --filter <keyword>      交互式选择时按关键词过滤文章 (匹配 slug 或标题)
  --include-updated       在 sync 时破例把修改过的历史文章也纳入自动推送
  --initial-push          本机尚无基线时，明确允许把当前待推文章当作首次推送
  --dry-run               开启演练模式，写接口不发真实请求
  --force                 强制新建草稿（跳过 update 原草稿尝试）
  -o, --output <path>     指定 preview 输出文件或目录路径
  -t, --theme <id>        指定渲染主题 ID (如: tech-blue, fullstack-blue, klein)
  -h, --help              显示此帮助信息
`);
}

function loadConfigWithOverrides(configPath?: string, values?: any) {
  const config = loadConfig(configPath);
  if (!values) return config;

  if (values.pull) config.source.gitPull = true;
  if (values['no-pull']) config.source.gitPull = false;
  if (values.repo) config.source.repoRoot = path.resolve(values.repo);
  if (values.posts) config.source.postsRoot = path.resolve(values.posts);
  if (values.branch) config.source.gitBranch = String(values.branch).trim();
  if (values.sort) config.source.sortOrder = String(values.sort).toLowerCase() as 'asc' | 'desc';
  if (values.asc) config.source.sortOrder = 'asc';
  if (values.desc) config.source.sortOrder = 'desc';
  return config;
}

async function runDiagnose(configPath?: string) {
  printBanner();
  const config = loadConfig(configPath);

  console.log('正在执行公众号 API 与权限全链路诊断...\n');

  const client = new WeChatClient({
    appId: config.wechat.appId,
    appSecret: config.wechat.appSecret,
  });

  const report = await client.diagnose();

  for (const step of report.steps) {
    const symbol = step.ok ? '✓' : '✗';
    console.log(`[${symbol}] ${step.title}:`);
    console.log(`    状态: ${step.message}`);
    if (step.code) {
      console.log(`    错误码: ${step.code}`);
    }
    if (step.detail) {
      console.log(`    微信返回详情: ${step.detail}`);
    }
    if (step.remediation) {
      console.log(`    👉 解决方案: ${step.remediation}`);
    }
    console.log('');
  }

  console.log('════════════════════════════════════════════════════════════');
  if (report.ok) {
    console.log('🎉 诊断结论：所有检查项全部通过！当前服务器可正常使用 draft 接口自动推入草稿箱。');
  } else if (!report.ipWhitelistOk) {
    console.log('⚠️  诊断结论：当前服务器出口 IP 不在公众号白名单内，请按上方提示添加后重试。');
  } else if (!report.canUseDraftApi) {
    console.log('⚠️  诊断结论：当前账号草稿箱接口未授权（48001），请使用本地 preview 命令生成 HTML 后手动粘贴。');
  } else {
    console.log('❌ 诊断结论：存在未通过项，请对照上方提示检查配置。');
  }
}

async function runCheck(configPath?: string, cliValues?: any) {
  printBanner();
  const config = loadConfigWithOverrides(configPath, cliValues);
  const pipeline = new SyncPipeline(config);

  const report = await pipeline.check({ forcePull: cliValues?.pull });
  console.log(`正在扫描博客目录: ${config.source.postsRoot} ...\n`);

  console.log('📊 扫描与状态统计:');
  console.log(`   - 文章总数:           ${report.total} 篇 (已发布: ${report.published}, 草稿: ${report.drafts})`);
  console.log(`   - 🆕 新增待自动同步:   ${report.newCount} 篇 (运行 sync 将自动推送)`);
  console.log(`   - ✏️  历史文章已修改:   ${report.updatedCount} 篇 (sync 默认跳过，可用 push 手动选推)`);
  console.log(`   - 📦 已设基线未修改:   ${report.baselinedCount} 篇`);
  console.log(`   - ✅ 已同步且未修改:   ${report.unchangedCount} 篇\n`);

  const newItems = report.items.filter((item) => item.status === 'new');
  const updatedItems = report.items.filter((item) => item.status === 'updated');

  if (newItems.length > 0) {
    console.log('🆕 待自动同步的新文章 (sync 将自动推送):');
    for (const item of newItems) {
      console.log(`   【新增】 [${item.id}] ${item.title}`);
      if (item.title !== item.normalizedTitle) {
        console.log(`            └─ 微信裁剪标题: "${item.normalizedTitle}"`);
      }
      if (!item.hasCover) {
        console.log(`            └─ ⚠️  无 frontmatter 封面 (image:)，将使用 sync.defaultCover 兜底；若未配置则本次同步会因缺封面而失败`);
      }
    }
    console.log('');
  }

  if (updatedItems.length > 0) {
    console.log('✏️  检测到内容修改的历史文章 (sync 默认不推，如需推送请运行 `pnpm cli push`):');
    for (const item of updatedItems) {
      console.log(`   【已改】 [${item.id}] ${item.title}`);
    }
    console.log('');
  }

  if (newItems.length === 0 && updatedItems.length === 0) {
    console.log('✨ 博客无新增或修改文章。\n');
  }
}

async function runBaseline(
  configPath?: string,
  options: {
    exceptSlug?: string;
    beforeDate?: string;
    onlySlugs?: string[];
    pullRemoteDrafts?: boolean;
    forcePull?: boolean;
    status?: boolean;
    importFrom?: string;
  } = {},
  cliValues?: any
) {
  printBanner();
  const config = loadConfigWithOverrides(configPath, cliValues);

  // Read-only baseline inspection: no git pull, no platform calls.
  if (options.status) {
    printBaselineStatus(config.sync.stateFile);
    return;
  }

  // Adopt another machine's baseline (merge, never overwrite local records).
  if (options.importFrom) {
    const src = path.resolve(options.importFrom);
    if (!fs.existsSync(src)) {
      throw new Error(`导入失败：找不到文件 ${src}`);
    }
    const store = new StateStore(config.sync.stateFile);
    const { added, skipped } = store.importFrom(JSON.parse(fs.readFileSync(src, 'utf8')));
    console.log(`✓ 已从 ${src} 导入基线`);
    console.log(`  本机状态文件: ${config.sync.stateFile}`);
    console.log(`  新增记录: ${added} 篇   已存在跳过: ${skipped} 篇`);
    const stats = store.getStats();
    console.log(`  当前共记录 ${stats.posts} 篇（baselined ${stats.baselined} / synced ${stats.synced}）\n`);
    return;
  }

  const pipeline = new SyncPipeline(config);

  if (options.pullRemoteDrafts) {
    console.log(`正在从微信公众号后台拉取「草稿箱」与「已发表列表」并匹配本地文章...`);
    const res = await pipeline.baseline(options);
    console.log(`✓ 草稿箱匹配成功并绑定 draftMediaId: ${res.matchedDraftCount} 篇`);
    if (res.publishListUnauthorized) {
      console.log(`ℹ️  已发表列表接口 (freepublish/batchget) 返回 48001（个人号不支持查询已发表列表，已自动跳过；已发表过的老文章可通过 \`baseline <slug1> <slug2>\` 手动标记）`);
    } else {
      console.log(`✓ 已发表列表匹配成功:               ${res.matchedPublishedCount} 篇`);
    }
    console.log(`  状态已写入: ${config.sync.stateFile}\n`);
    return;
  }

  console.log(`正在为本地文章建立基准（baseline）...`);
  const res = await pipeline.baseline(options);
  console.log(`✓ 成功将 ${res.baselinedCount} 篇已发布文章标记为基线！`);
  console.log(`  状态已写入: ${config.sync.stateFile}`);
  console.log(`  后续运行 sync 时将只自动同步新发表的文章。\n`);
}

async function runPreview(slug: string, configPath?: string, output?: string, themeId?: string, cliValues?: any) {
  printBanner();
  const config = loadConfigWithOverrides(configPath, cliValues);
  const targetPlatform = (cliValues?.to || 'wechat').toLowerCase() as 'wechat' | 'heybox';
  if (themeId) config.render.theme = themeId;

  const pipeline = new SyncPipeline(config);
  console.log(`正在为文章 [${slug}] 生成离线预览 (目标: ${targetPlatform}) ...`);
  const res = await pipeline.preview(slug, { to: targetPlatform, output, theme: themeId });

  if (res.target === 'heybox' && res.heybox) {
    const { bundleDir, prepared } = res.heybox;
    const codeImgCount = Array.from(prepared.assets.keys()).filter((k) =>
      k.startsWith('assets/code_')
    ).length;

    console.log(`✓ 小黑盒专属发布包已生成！`);
    console.log(`  发布包目录: ${bundleDir}`);
    console.log(`  文章标题:   ${prepared.title}`);
    console.log(
      `  社区专区:   ${
        prepared.metadata.community
          ? `${prepared.metadata.community}${prepared.metadata.gameId ? ` (GameID: ${prepared.metadata.gameId})` : ''}`
          : '草稿模式（发布时在后台自主选择）'
      }`
    );
    console.log(`  话题标签:   ${prepared.metadata.hashtags.map((h) => `#${h}#`).join(' ') || '无'}`);
    console.log(`  代码块转图: ${codeImgCount} 张 (防止手机端排版打散)`);
    console.log(`  16:9 封面:  ${prepared.coverBuffer ? '已裁切生成 (cover_16_9.jpg)' : '未找到封面'}`);
    console.log(
      `  站外链接:   ${prepared.externalLinkCount ?? 0} 个（已全部转为纯文字，正文不含任何 URL）`
    );
    for (const w of prepared.warnings) {
      console.log(`  ⚠️  ${w}`);
    }
    console.log(`\n💡 提示：双击打开 ${bundleDir}/preview.html 可预览小黑盒效果！`);
    console.log(`   👉 点击页面顶部【一键复制小黑盒富文本】，并在小黑盒「发布文章」编辑区直接 Ctrl+V 粘贴即可！\n`);
    return;
  }

  const outputPath = output
    ? path.resolve(output)
    : path.resolve(process.cwd(), `preview-${slug}.html`);

  fs.writeFileSync(outputPath, res.fullPageHtml, 'utf8');

  console.log(`✓ 预览文件已成功生成！`);
  console.log(`  文件路径: ${outputPath}`);
  console.log(`  标题:     ${res.normalizedTitle}`);
  console.log(`  配图数量: ${res.post.localAssetPaths.length}`);

  if (res.warnings.length > 0) {
    console.log('\n⚠️  排版提示与警告:');
    for (const w of res.warnings) {
      console.log(`  - ${w}`);
    }
  }

  console.log('\n💡 提示：双击在浏览器中打开该文件，可直观查看手机排版效果并点击「一键复制富文本」！\n');
}

function formatStatusBadge(status: CheckPostItem['status']): string {
  switch (status) {
    case 'new':
      return '🆕 新增  ';
    case 'updated':
      return '✏️ 已修改';
    case 'unchanged':
      return '✅ 已同步';
    case 'baselined':
      return '📦 基线  ';
    default:
      return '📝 草稿  ';
  }
}

async function promptInteractiveSelection(
  pipeline: SyncPipeline,
  filterKeyword?: string,
  initialSortOrder: 'asc' | 'desc' = 'asc'
): Promise<string[]> {
  const report = await pipeline.check();
  let baseItems = report.items.filter((item) => item.status !== 'draft');

  if (filterKeyword) {
    const kw = filterKeyword.toLowerCase();
    baseItems = baseItems.filter(
      (item) => item.id.toLowerCase().includes(kw) || item.title.toLowerCase().includes(kw)
    );
  }

  if (baseItems.length === 0) {
    console.log('未找到符合条件的已发布文章。\n');
    return [];
  }

  const statusPriority: Record<CheckPostItem['status'], number> = {
    new: 0,
    updated: 1,
    unchanged: 2,
    baselined: 3,
    draft: 4,
  };

  let currentSort: 'asc' | 'desc' = initialSortOrder;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      const sortedItems = [...baseItems];
      const dir = currentSort === 'desc' ? -1 : 1;

      sortedItems.sort((a, b) => {
        const pDiff = statusPriority[a.status] - statusPriority[b.status];
        if (pDiff !== 0) return pDiff;
        const dateA = a.publishedAt || '';
        const dateB = b.publishedAt || '';
        const cmp = dateA.localeCompare(dateB);
        if (cmp !== 0) return cmp * dir;
        return a.id.localeCompare(b.id, undefined, { numeric: true }) * dir;
      });

      console.log(`📋 可选推送文章列表（当前: ${currentSort === 'asc' ? '【正序 (从第 1 篇起)】' : '【倒序 (最新发表在前)】'}）：\n`);
      console.log(`  ${'序号'.padEnd(4)}  ${'状态'.padEnd(8)}  ${'发布日期'.padEnd(10)}  ${'Slug'.padEnd(24)}  标题`);
      console.log('  ' + '─'.repeat(80));

      sortedItems.forEach((item, idx) => {
        const numStr = `[${idx + 1}]`.padStart(4);
        const badge = formatStatusBadge(item.status);
        const dateStr = (item.publishedAt || '----------').padEnd(10);
        const slugStr = item.id.padEnd(24);
        console.log(`  ${numStr}  ${badge}  ${dateStr}  ${slugStr}  ${item.normalizedTitle}`);
      });

      console.log('\n💡 输入说明：');
      console.log('   - 输入序号可单选或多选：如 `1`、`1,3,5`、`1-5`（序号严格对应文章篇号）');
      console.log('   - 输入 `new` 选全部新增文章，输入 `updated` 选全部已修改文章');
      console.log('   - 输入 `r` 或 `sort` 可瞬间切换【正序 / 倒序】');
      console.log('   - 也可直接输入文章 slug（如 `1-minecraft-1`），输入 `q` 取消退出\n');

      const answer = await rl.question('👉 请输入要推送的文章 (输入 r 翻转排序，q 退出): ');
      const trimmed = answer.trim().toLowerCase();

      if (trimmed === 'r' || trimmed === 'sort' || trimmed === 'reverse') {
        currentSort = currentSort === 'asc' ? 'desc' : 'asc';
        console.log(`\n🔄 已切换排序方式为: ${currentSort === 'asc' ? '【正序 (从第 1 篇起)】' : '【倒序 (最新发表在前)】'}\n`);
        continue;
      }

      return parseArticleSelection(answer, sortedItems);
    }
  } finally {
    rl.close();
  }
}

async function runPush(
  slugs: string[],
  configPath?: string,
  options: { dryRun?: boolean; force?: boolean; interactive?: boolean; filter?: string } = {},
  cliValues?: any
) {
  printBanner();
  const config = loadConfigWithOverrides(configPath, cliValues);
  const client = new WeChatClient({
    appId: config.wechat.appId,
    appSecret: config.wechat.appSecret,
    dryRun: options.dryRun,
  });

  const pipeline = new SyncPipeline(config, client);

  let targetSlugs = [...slugs];
  if (targetSlugs.length === 0 || options.interactive) {
    const selected = await promptInteractiveSelection(
      pipeline,
      options.filter,
      config.source.sortOrder || 'asc'
    );
    for (const s of selected) {
      if (!targetSlugs.includes(s)) targetSlugs.push(s);
    }
  }

  if (targetSlugs.length === 0) {
    console.log('未选择任何文章，操作已取消。\n');
    return;
  }

  // 与 sync 保持一致：命令行 --to > config.yaml 的 sync.target > wechat 默认值
  const targetPlatform = (cliValues?.to || config.sync.target || 'wechat').toLowerCase();
  const targetDesc =
    targetPlatform === 'heybox' ? '小黑盒' : targetPlatform === 'all' ? '微信 + 小黑盒' : '微信草稿箱';

  console.log(
    `\n准备${options.dryRun ? '【模拟演练】' : ''}推送 ${targetSlugs.length} 篇文章到 [${targetDesc}]...\n`
  );

  let successCount = 0;
  let failCount = 0;

  for (const slug of targetSlugs) {
    try {
      console.log(`⏳ 正在处理 [${slug}] ...`);
      const res = await pipeline.push(slug, {
        to: targetPlatform as 'wechat' | 'heybox' | 'all',
        force: options.force,
        dryRun: options.dryRun,
      });

      if (res.wechat) {
        console.log(`✓ [${res.id}] 微信公众号推送成功！`);
        console.log(`    微信标题:    ${res.wechat.normalizedTitle}`);
        console.log(`    操作类型:    ${res.wechat.isUpdate ? '更新现有草稿' : '新建草稿'}`);
        console.log(`    草稿MediaId: ${res.wechat.mediaId}`);
        if (res.wechat.warnings.length > 0) {
          console.log(`    ⚠️  排版提示 (${res.wechat.warnings.length} 条): ${res.wechat.warnings[0]}`);
        }
      }

      if (res.heybox) {
        console.log(`✓ [${slug}] 小黑盒: ${res.heybox.message}`);
        console.log(`    发布包路径: ${res.heybox.bundleDir}`);
      }

      successCount++;
      console.log('');
    } catch (err: any) {
      failCount++;
      console.error(`✗ [${slug}] 推送失败: ${err.message}\n`);
    }
  }

  if (targetSlugs.length > 1) {
    console.log(`📊 批量推送完成：成功 ${successCount} 篇，失败 ${failCount} 篇。\n`);
  }

  // 单篇失败也要让调用方（systemd / CI）拿到非 0 退出码。
  if (failCount > 0) {
    process.exitCode = 1;
  }
}

/**
 * Full baseline report for `pnpm cli baseline --status`.
 */
function printBaselineStatus(stateFile: string): void {
  const exists = fs.existsSync(stateFile);
  const store = new StateStore(stateFile);
  const stats = store.getStats();

  console.log('📌 同步基线（baseline）状态\n');
  console.log(`  状态文件: ${stateFile}`);
  console.log(`  文件存在: ${exists ? '是' : '否（本机尚未建立基线）'}`);
  console.log(`  已记录文章: ${stats.posts} 篇  (baselined ${stats.baselined} / synced ${stats.synced})`);
  console.log(`  基线建立于: ${stats.baselineCreatedAt || '(未记录)'}`);
  console.log(`  最近拉取博客: ${stats.lastGitPullAt || '(未记录)'}`);
  console.log(`  图片缓存: ${stats.images} 条    封面缓存: ${stats.covers} 条`);
  console.log('');
  console.log('  说明: 该文件是【机器本地】的，不随 Git 仓库同步。');
  console.log('        换机器 / VPS 时可用 `pnpm cli baseline --import <state.json>` 搬运，');
  console.log('        或在新机器上直接运行 `pnpm cli baseline` 重新建立。\n');
}

/**
 * Prints where the sync baseline lives and what it currently knows.
 * The state file is machine-local, which is the usual source of "why did a fresh VPS
 * push articles that were already published elsewhere?".
 */
function printBaselineInfo(stateFile: string): void {
  const store = new StateStore(stateFile);
  const recorded = store.countPosts();
  const createdAt = store.getBaselineCreatedAt();

  if (recorded === 0) {
    console.log(`基线文件: ${stateFile}  (空 — 本机从未建立过基线)`);
    console.log('  ⚠️  空基线时 sync 会中止；先运行 `pnpm cli baseline` 或复制原机器的 state.json。');
    return;
  }

  const baselineDesc = createdAt ? `建立于 ${createdAt}` : '建立时间未记录';
  console.log(`基线文件: ${stateFile}`);
  console.log(`  已记录文章: ${recorded} 篇 (${baselineDesc})`);
}

/**
 * Prints failures grouped by identical error message.
 * A single misconfiguration (e.g. invalid AppID) otherwise repeats the same 200-char
 * error for every article and buries the actionable part in the journal.
 */
function normalizeFailureMessage(message: string): string {
  return (
    message
      // 微信/小黑盒返回的请求追踪号每次都不同，会阻止相同错误合并
      .replace(/\s*rid:\s*[0-9a-f-]+/gi, '')
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
  );
}

function printGroupedFailures(failed: Array<{ id: string; error: string }>): void {
  const groups = new Map<string, string[]>();
  for (const f of failed) {
    const key = normalizeFailureMessage(f.error);
    const list = groups.get(key) ?? [];
    list.push(f.id);
    groups.set(key, list);
  }

  console.log('\n❌ 推送失败文章:');
  let index = 1;
  for (const [error, ids] of groups) {
    console.log(`  ${index++}. ${error}`);
    console.log(`     受影响文章 (${ids.length}): ${ids.join(', ')}`);
  }
}

async function runSync(
  configPath?: string,
  dryRun = false,
  includeUpdated = false,
  cliValues?: any
) {
  const allowInitialPush = Boolean(cliValues?.['initial-push']);
  printBanner();
  const config = loadConfigWithOverrides(configPath, cliValues);
  const targetPlatform = (cliValues?.to || config.sync.target || 'wechat').toLowerCase() as
    | 'wechat'
    | 'heybox'
    | 'all';

  const client = new WeChatClient({
    appId: config.wechat.appId,
    appSecret: config.wechat.appSecret,
    dryRun,
  });

  const pipeline = new SyncPipeline(config, client);
  const modeDesc = includeUpdated || config.sync.syncUpdated ? '新增 + 已修改文章' : '仅新发表文章';
  console.log(
    `开始执行${dryRun ? '【模拟演练】' : ''}自动同步 (目标: ${targetPlatform}, 策略: ${modeDesc}, 单次上限: ${config.sync.maxPerRun} 篇)...`
  );
  printBaselineInfo(config.sync.stateFile);

  const report = await pipeline.sync({
    to: targetPlatform,
    includeUpdated: includeUpdated || undefined,
    forcePull: cliValues?.pull,
    dryRun,
    allowInitialPush,
  });

  console.log('\n📊 同步完成报告:');
  console.log(`  - 扫描文章:         ${report.scanned} 篇`);
  console.log(`  - 成功推入草稿箱:   ${report.pushed.length} 篇`);
  console.log(`  - 失败文章:         ${report.failed.length} 篇`);
  if (report.skippedUpdatedCount > 0) {
    console.log(
      `  - 已跳过修改的老文章: ${report.skippedUpdatedCount} 篇 (默认不自动更新老文章，如需推送请运行 pnpm cli push)`
    );
  }
  if (report.skippedDueToLimit > 0) {
    console.log(`  - 剩余待推送新文章: ${report.skippedDueToLimit} 篇 (由于达到单次上限而保留至下次)`);
  }

  if (report.pushed.length > 0) {
    console.log('\n✓ 成功推入草稿箱:');
    for (const p of report.pushed) {
      console.log(`  [${p.id}] ${p.normalizedTitle} (mediaId: ${p.mediaId})`);
    }
  }

  if (report.failed.length > 0) {
    printGroupedFailures(report.failed);
  }
  console.log('');

  // 让 systemd / 监控能看到失败：只要有文章失败就以非 0 退出。
  if (report.failed.length > 0) {
    process.exitCode = 1;
  }
}

async function runLogin(configPath?: string, cliValues?: any) {
  printBanner();
  const config = loadConfigWithOverrides(configPath, cliValues);
  const target = (cliValues?.to || 'heybox').toLowerCase();

  if (target === 'heybox' || target === 'xiaoheihe') {
    const client = new HeyBoxClient({
      sessionFile: config.heybox?.sessionFile,
      browserChannel: config.heybox?.browserChannel,
    });
    console.log('正在启动小黑盒浏览器交互式扫码登录...\n');
    const sessionFile = await client.login();
    console.log(`\n✓ 小黑盒登录态已成功保存至: ${sessionFile}`);
    console.log('后续执行 pnpm cli push --to heybox 即可全自动直接推入小黑盒草稿箱！\n');
    return;
  }

  console.log(`目前仅支持小黑盒登录凭据捕获: pnpm cli login --to heybox\n`);
}

function runThemes() {
  printBanner();
  const themes = listThemes();
  console.log(`内置 28 套公众号排版主题（全部可在 config.yaml 的 render.theme 中使用）：\n`);
  console.log(
    `${'ID'.padEnd(18)} ${'名称'.padEnd(8)} ${'分类'.padEnd(6)} ${'主色'.padEnd(10)} ${'定位'}`
  );
  console.log('─'.repeat(70));
  for (const t of themes) {
    console.log(
      `${t.id.padEnd(18)} ${t.name.padEnd(8)} ${t.category.padEnd(6)} ${t.primary.padEnd(10)} ${t.tag}`
    );
  }
  console.log('\n⭐ 推荐教程/技术博客选用: tech-blue (科技蓝), fullstack-blue (全栈蓝), 或 klein (克莱因蓝)\n');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    printUsage();
    return;
  }

  const command = args[0];

  const parsed = parseArgs({
    args: args.slice(1),
    options: {
      to: { type: 'string' },
      config: { type: 'string', short: 'c' },
      output: { type: 'string', short: 'o' },
      theme: { type: 'string', short: 't' },
      select: { type: 'boolean', short: 'i' },
      filter: { type: 'string' },
      sort: { type: 'string' },
      asc: { type: 'boolean' },
      desc: { type: 'boolean' },
      'include-updated': { type: 'boolean' },
      'initial-push': { type: 'boolean' },
      status: { type: 'boolean' },
      import: { type: 'string' },
      remote: { type: 'boolean' },
      except: { type: 'string' },
      before: { type: 'string' },
      pull: { type: 'boolean' },
      'no-pull': { type: 'boolean' },
      repo: { type: 'string' },
      posts: { type: 'string' },
      branch: { type: 'string' },
      'dry-run': { type: 'boolean' },
      force: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  const configPath = parsed.values.config;

  switch (command) {
    case 'diagnose':
      await runDiagnose(configPath);
      break;

    case 'check':
      await runCheck(configPath, parsed.values);
      break;

    case 'baseline':
      await runBaseline(
        configPath,
        {
          exceptSlug: parsed.values.except,
          beforeDate: parsed.values.before,
          onlySlugs: parsed.positionals.length > 0 ? parsed.positionals : undefined,
          pullRemoteDrafts: parsed.values.remote,
          forcePull: parsed.values.pull,
          status: parsed.values.status,
          importFrom: parsed.values.import,
        },
        parsed.values
      );
      break;

    case 'preview': {
      const slug = parsed.positionals[0];
      if (!slug) {
        console.error('错误: 请指定要预览的文章 slug，例如: pnpm cli preview 45-immortalwrt-1\n');
        process.exit(1);
      }
      await runPreview(slug, configPath, parsed.values.output, parsed.values.theme, parsed.values);
      break;
    }

    case 'push': {
      await runPush(
        parsed.positionals,
        configPath,
        {
          dryRun: parsed.values['dry-run'],
          force: parsed.values.force,
          interactive: parsed.values.select,
          filter: parsed.values.filter,
        },
        parsed.values
      );
      break;
    }

    case 'sync':
      await runSync(configPath, parsed.values['dry-run'], parsed.values['include-updated'], parsed.values);
      break;

    case 'themes':
      runThemes();
      break;

    case 'login':
    case 'heybox-login':
      await runLogin(configPath, parsed.values);
      break;

    default:
      console.error(`未知命令: "${command}"\n`);
      printUsage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('\n❌ 执行异常:', err.message);
  process.exit(1);
});
