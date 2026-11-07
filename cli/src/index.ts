#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { WeChatClient } from '@md2posts/wechat-sdk';
import { HeyBoxClient, HeyBoxPublisher } from '@md2posts/heybox-sdk';
import { listThemes } from '@md2posts/renderer';
import { FsSource } from '@md2posts/sources';
import {
  loadConfig,
  SyncPipeline,
  parseArticleSelection,
  CheckPostItem,
} from '@md2posts/sync-core';

function printBanner() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║       md2posts - Markdown 博客多平台排版与同步工具        ║');
  console.log('║       支持: 微信公众号草稿箱 (WeChat) | 小黑盒 (HeyBox)    ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');
}

function printUsage() {
  printBanner();
  console.log(`用法:
  md2posts <command> [options]

命令:
  diagnose                微信 API 与出口 IP 白名单诊断（只读，不修改文件）
  check                   离线扫描博客：报告【新增待同步】与【已修改可手动推】文章（零微信请求）
  baseline                将当前已发布文章标记为基线，跳过历史文章自动推送
  preview <slug>          离线渲染指定文章为独立页面（支持 --to wechat 或 --to heybox）
  push [slug1 slug2 ...]  推送文章到草稿箱（支持 --to wechat / heybox / all，不传 slug 进入勾选列表）
  sync                    自动增量同步【新文章】到草稿箱（默认忽略老文章修改，受 maxPerRun 限制）
  themes                  列出内置的 28 套精美主题

通用选项:
  --to <platform>         目标发布平台: wechat (默认) | heybox (小黑盒) | all (双端同步)
  -c, --config <path>     指定配置文件路径 (默认: ./config.yaml)
  --pull                  强制执行 git pull 拉取博客仓库更新
  --no-pull               强制跳过 git pull
  --repo <path>           指定/切换要 pull 的本地 Git 博客仓库路径（留空则自动从 postsRoot 寻找 .git）
  --posts <path>          指定/切换博客文章所在目录 (如: /path/to/blog/content/posts)
  --branch <name>         指定 pull 的 Git 分支名 (默认: main 或当前分支)
  -i, --select            进入交互式文章选择推送模式
  --filter <keyword>      交互式选择时按关键词过滤文章 (匹配 slug 或标题)
  --include-updated       在 sync 时破例把修改过的历史文章也纳入自动推送
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
        console.log(`            └─ ⚠️  无 frontmatter 封面，将触发自动兜底`);
      }
    }
    console.log('');
  }

  if (updatedItems.length > 0) {
    console.log('✏️  检测到内容修改的历史文章 (sync 默认不推，如需推送请运行 `md2posts push`):');
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
  } = {},
  cliValues?: any
) {
  printBanner();
  const config = loadConfigWithOverrides(configPath, cliValues);
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
  const targetPlatform = (cliValues?.to || 'wechat').toLowerCase();

  if (targetPlatform === 'heybox') {
    const publisher = new HeyBoxPublisher(config);
    const source = new FsSource(config.source);
    await source.prepare?.();
    const post = await source.getPost(slug);
    if (!post) {
      throw new Error(`[Pipeline] 未找到文章: ${slug}`);
    }
    const { bundleDir, prepared } = await publisher.exportPackage(post, output);
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
    console.log(`\n💡 提示：双击打开 ${bundleDir}/preview.html 可预览小黑盒效果！`);
    console.log(`   👉 点击页面顶部【一键复制小黑盒富文本】，并在小黑盒「发布文章」编辑区直接 Ctrl+V 粘贴即可！\n`);
    return;
  }

  if (themeId) {
    config.render.theme = themeId;
  }

  const pipeline = new SyncPipeline(config);
  console.log(`正在渲染文章 [${slug}] (主题: ${config.render.theme}) ...`);

  const res = await pipeline.preview(slug);
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
  filterKeyword?: string
): Promise<string[]> {
  const report = await pipeline.check();
  let publishedItems = report.items.filter((item) => item.status !== 'draft');

  if (filterKeyword) {
    const kw = filterKeyword.toLowerCase();
    publishedItems = publishedItems.filter(
      (item) => item.id.toLowerCase().includes(kw) || item.title.toLowerCase().includes(kw)
    );
  }

  // Sort priority: 'new' first, 'updated' second, then others (keeping newest date order within each group)
  const statusPriority: Record<CheckPostItem['status'], number> = {
    new: 0,
    updated: 1,
    unchanged: 2,
    baselined: 3,
    draft: 4,
  };
  publishedItems.sort((a, b) => statusPriority[a.status] - statusPriority[b.status]);

  if (publishedItems.length === 0) {
    console.log('未找到符合条件的已发布文章。\n');
    return [];
  }

  console.log('📋 可选推送文章列表（优先展示【新增】与【已修改】文章）：\n');
  console.log(`  ${'序号'.padEnd(4)}  ${'状态'.padEnd(8)}  ${'发布日期'.padEnd(10)}  ${'Slug'.padEnd(22)}  标题`);
  console.log('  ' + '─'.repeat(78));

  publishedItems.forEach((item, idx) => {
    const numStr = `[${idx + 1}]`.padStart(4);
    const badge = formatStatusBadge(item.status);
    const dateStr = (item.publishedAt || '----------').padEnd(10);
    const slugStr = item.id.padEnd(22);
    console.log(`  ${numStr}  ${badge}  ${dateStr}  ${slugStr}  ${item.normalizedTitle}`);
  });

  console.log('\n💡 输入说明：');
  console.log('   - 输入序号可单选或多选：如 `1`、`1,3,5`、`1-3`');
  console.log('   - 输入 `new` 选全部新增文章，输入 `updated` 选全部已修改文章');
  console.log('   - 也可直接输入文章 slug（如 `45-immortalwrt-1`），输入 `q` 取消退出\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question('👉 请输入要推送的文章: ');
    return parseArticleSelection(answer, publishedItems);
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
    const selected = await promptInteractiveSelection(pipeline, options.filter);
    for (const s of selected) {
      if (!targetSlugs.includes(s)) targetSlugs.push(s);
    }
  }

  if (targetSlugs.length === 0) {
    console.log('未选择任何文章，操作已取消。\n');
    return;
  }

  const targetPlatform = (cliValues?.to || 'wechat').toLowerCase();
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

      // 1. WeChat Push
      if (targetPlatform === 'wechat' || targetPlatform === 'all') {
        const res = await pipeline.push(slug, { force: options.force });
        console.log(`✓ [${res.id}] 微信公众号推送成功！`);
        console.log(`    微信标题:    ${res.normalizedTitle}`);
        console.log(`    操作类型:    ${res.isUpdate ? '更新现有草稿' : '新建草稿'}`);
        console.log(`    草稿MediaId: ${res.mediaId}`);
        if (res.warnings.length > 0) {
          console.log(`    ⚠️  排版提示 (${res.warnings.length} 条): ${res.warnings[0]}`);
        }
      }

      // 2. HeyBox Push / Export
      if (targetPlatform === 'heybox' || targetPlatform === 'all') {
        const heyPublisher = new HeyBoxPublisher(config);
        const source = new FsSource(config.source);
        const post = await source.getPost(slug);
        if (post) {
          const heyRes = await heyPublisher.publishDraft(post, { dryRun: options.dryRun });
          console.log(`✓ [${slug}] 小黑盒: ${heyRes.message}`);
          console.log(`    发布包路径: ${heyRes.bundleDir}`);
        }
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
}

async function runSync(configPath?: string, dryRun = false, includeUpdated = false, cliValues?: any) {
  printBanner();
  const config = loadConfigWithOverrides(configPath, cliValues);
  const client = new WeChatClient({
    appId: config.wechat.appId,
    appSecret: config.wechat.appSecret,
    dryRun,
  });

  const pipeline = new SyncPipeline(config, client);
  const modeDesc = includeUpdated || config.sync.syncUpdated ? '新增 + 已修改文章' : '仅新发表文章';
  console.log(
    `开始执行${dryRun ? '【模拟演练】' : ''}自动同步 (策略: ${modeDesc}, 单次上限: ${config.sync.maxPerRun} 篇)...`
  );

  const report = await pipeline.sync({
    includeUpdated: includeUpdated || undefined,
    forcePull: cliValues?.pull,
  });

  console.log('\n📊 同步完成报告:');
  console.log(`  - 扫描文章:         ${report.scanned} 篇`);
  console.log(`  - 成功推入草稿箱:   ${report.pushed.length} 篇`);
  console.log(`  - 失败文章:         ${report.failed.length} 篇`);
  if (report.skippedUpdatedCount > 0) {
    console.log(
      `  - 已跳过修改的老文章: ${report.skippedUpdatedCount} 篇 (默认不自动更新老文章，如需推送请运行 md2posts push)`
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
    console.log('\n❌ 推送失败文章:');
    for (const f of report.failed) {
      console.log(`  [${f.id}] 错误: ${f.error}`);
    }
  }
  console.log('');
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
      'include-updated': { type: 'boolean' },
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
        },
        parsed.values
      );
      break;

    case 'preview': {
      const slug = parsed.positionals[0];
      if (!slug) {
        console.error('错误: 请指定要预览的文章 slug，例如: md2posts preview 45-immortalwrt-1\n');
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
