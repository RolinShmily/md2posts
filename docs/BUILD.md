# 构建与开发规范（BUILD & DEV）

本文是 md2posts 的开发手册：环境、常用命令、编码约定、测试策略与验证流程。
系统设计见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

---

## 1. 环境要求

| 项 | 版本 | 说明 |
|---|---|---|
| Node.js | **>= 20**（建议 22） | 依赖 `fetch`、`node:test`、ESM |
| pnpm | **>= 10** | `pnpm-workspace.yaml` 的 `allowBuilds` 需要 10+ |
| Git | 任意近期版本 | `sources` 会 `clone/pull` 博客仓库 |
| Chromium（可选） | 任意 | 小黑盒扫码登录与浏览器兜底通道 |

```bash
node -v && pnpm -v
```

---

## 2. 常用命令

### 2.1 仓库根目录

```bash
pnpm install          # 安装依赖（预置 .npmrc，见「依赖策略」）
pnpm build            # 全量编译（拓扑序，tsc -> dist/）
pnpm test             # 全量测试（逐包执行）
pnpm typecheck        # 仅类型检查，不产出文件
pnpm cli <command>    # 运行编译后的 CLI（仓库根目录，唯一入口）
```

### 2.2 单包操作

```bash
pnpm --filter @md2posts/heybox-sdk build
pnpm --filter @md2posts/heybox-sdk test

# 单个测试文件
cd src/heybox-sdk && npx tsx --test test/heybox.test.ts
```

### 2.3 CLI 自检序列（改完代码先跑这一套）

```bash
pnpm build
pnpm cli themes                      # 渲染器可用
pnpm cli check                       # 扫描/拉取/哈希比对可用
pnpm cli preview <slug> --to heybox  # 小黑盒转换可用（不联网）
pnpm cli push <slug> --dry-run --to heybox   # 组装发布包，不发写请求
```

---

## 3. 目录与命名约定

```text
src/<pkg>/
├── src/            # 仅此目录参与编译
│   └── index.ts    # 包的唯一公共出口
├── test/           # *.test.ts，node:test + tsx
├── package.json    # name @md2posts/<pkg>，ESM
└── tsconfig.json   # extends ../../tsconfig.base.json
```

- **跨包引用只能通过 `@md2posts/<pkg>` 的 barrel（`src/index.ts`）**，禁止深路径导入其他包的内部文件。
- 包内文件用 `./xxx.js` 后缀导入（NodeNext ESM 要求）。
- 新增包：建目录 → 加 `tsconfig.json`（复制现有包）→ 在 `pnpm-workspace.yaml` 的 `src/*` 下自动纳入 → 在依赖方 `package.json` 写 `workspace:*`。

---

## 3.5 同步基线（baseline）

「基线」就是 `sync.stateFile`（默认 `./state.json`，相对 `config.yaml` 所在目录解析）。它记录每篇文章的 `contentHash`、平台草稿 ID 与图片缓存，用来回答**哪些文章已经推送过**。

要点：

- **基线是机器本地的，不随仓库同步。** 新克隆的 VPS 上它是空的，此时所有文章都会被判为“新增”。
- 空基线 + 存在待推文章时，`sync` **会中止**并提示，避免把已在别处发布过的文章再推一遍：

  ```text
  [Baseline] 本机尚无同步基线，但检测到 61 篇待推送文章，已中止以避免误推。
    状态文件: /path/to/state.json
    1) 若这些文章此前已在别处推送过：先建立基线 —— `pnpm cli baseline`，或把原机器的 state.json 复制过来；
    2) 若这是一批确实需要推送的新文章：加 `--initial-push` 明确同意；
    3) 只想先看看会推什么：`pnpm cli check`。
  ```

- `sync` 启动时会打印基线位置与已记录篇数；`pnpm cli check` 可用于零写入地预览会推什么。
- 多机同步（例如本地 + VPS）：把一台机器上的 `state.json` 复制到另一台的同一路径，即可共享“已推送”认知。
- `pnpm cli baseline` 会把当前所有已发布文章标记为“已推送过”，**不调用任何平台接口**；`baseline --remote` 还会额外从微信草稿箱/已发表列表回填草稿 ID。

基线相关命令一览：

```bash
pnpm cli baseline                       # 就地建立基线（当前所有已发布文章 → 已推过）
pnpm cli baseline --status              # 查看基线位置/篇数/建立时间（只读，不拉取、不联网）
pnpm cli baseline --import state.json   # 从其他机器搬运基线（合并，不覆盖本机已有记录）
pnpm cli baseline --remote              # 额外从微信草稿箱/已发表列表回填草稿 ID
pnpm cli baseline <slug...>             # 只把指定文章标记为已推过
```


## 4. 编码规范

### 4.1 语言与类型

- TypeScript `strict` 全开，**不使用 `any` 逃逸**；平台原始响应可用 `any`，但必须在边界处立刻收敛为具体类型。
- `tsconfig.base.json` 已开启 `noUnusedLocals` / `noUnusedParameters` / `noImplicitReturns` / `noFallthroughCasesInSwitch`（由 `pnpm build` 与 `pnpm typecheck` 强制执行）。未使用的形参用 `_` 前缀显式标记。
- 对外导出的类型集中在 `types.ts`；不为"以后可能用"预留字段。
- 公共函数必须显式标注返回类型。

### 4.2 错误处理

- **禁止 `catch {}` 吞异常**。要么记录并降级（`console.warn` + 明确替代路径），要么抛出。
- 平台错误统一转成可判定错误（`WeChatError` / `HeyBoxError` 带 `code`），CLI 层按 `code` 打印可操作提示。
- 降级必须有日志说明降级原因与后果，例如：

```ts
try {
  await apiPush();
} catch (err: any) {
  console.warn(`[HeyBox] API 推送失败 (${err.message})，降级为浏览器通道`);
  // 继续走下一级
}
```

### 4.3 副作用与可测试性

- 纯计算（转换、清洗、签名、裁剪规则）与 IO（网络、文件）分离；纯函数优先导出以便单测。
- 例：`buildCodeBlockSvg()` 只产字符串，`renderCodeBlockToImage()` 才落 PNG。
- 需要联网的编排（上传、提交）不要塞进纯函数；测试用桩替换 `uploadImage` / `request`。

### 4.4 注释

- 注释解释**为什么**，而不是复述代码。
- 凡是"反直觉但必须这样写"的地方，必须留下实测依据：

```ts
// 实测：<img> 带 src 时编辑器会生成两个图片节点（缩略图 + 裁切大图）。
// 官方编辑器只输出 data-original，故此处绝不写 src。
```

### 4.5 日志

- 统一前缀 `[HeyBox]` / `[Pipeline]` / `[Git]`，便于 `journalctl` 过滤。
- 进度/降级用 `console.warn`，致命错误抛出由 CLI 统一渲染。

---

## 5. 依赖策略

- **lockfile 视为源码**：不手工改 `pnpm-lock.yaml`，不静默升降级。
- 安装默认加 `--ignore-scripts`；确实需要构建脚本（如 `sharp`、`esbuild`）时，在 `pnpm-workspace.yaml` 的 `allowBuilds` 白名单里显式声明，并复核来源。
- 新增依赖的准入判断：
  1. 能否用 Node 内置模块实现？
  2. 体积与传递依赖是否可控？
  3. 是否只为一个函数引入整个库？
- 当前外部运行时依赖仅有：`markdown-it`（渲染）、`highlight.js`（高亮）、`yaml`（frontmatter）、`sharp`（图像）、`playwright-core`（浏览器通道）。`wechat-sdk` 保持零依赖。

---

## 6. 测试策略

框架：`node:test` + `tsx`，无额外测试运行器。约定：

| 层级 | 位置 | 要求 |
|---|---|---|
| 纯函数/规则 | 各包 `test/*.test.ts` | 必测边界：空输入、编码差异、超长内容 |
| 回归缺陷 | 同上 | **每修一个 bug 就补一条断言**，断言要能复现原问题 |
| 端到端 | `sync-core/test/e2e-pipeline.test.ts` | 用 mock HTTP server，禁止真实平台请求 |
| 快照 | `renderer/test/fixtures/` | 主题输出按 golden 快照比对 |

约束：

- 测试**不得联网**、不得读取用户真实凭据、不得写入仓库目录（用 `os.tmpdir()`）。
- 需要平台响应的用例，注入桩函数而非 mock 全局 `fetch`。
- 断言要指向可观测结果（生成的 HTML、尺寸、块数量），不要断言实现细节。

参考写法：

```ts
// 用桩替换网络方法，断言"上传了几次"
const client = new HeyBoxApiClient();
let uploads = 0;
(client as any).uploadImage = async () => { uploads++; return { url: 'https://cdn/x.png', width: 1, height: 1, filename: 'x.png' }; };
(client as any).request = async () => ({ link_id: 1 });
```

---

## 7. 验证流程（Definition of Done）

改动必须走完下列 5 步，缺一不可：

### 步骤 1 — 静态检查

```bash
pnpm typecheck
pnpm build
```

### 步骤 2 — 全量测试

```bash
pnpm test        # 期望：全部 pass，0 fail
```

### 步骤 3 — 离线产物校验

```bash
pnpm cli preview <slug> --to heybox
# 检查 out/heybox/<slug>/：
#   article.md           转换后的 Markdown
#   article.rich.html    平台富文本（不应出现 <table> / 嵌套 <p> / 残留 data:image）
#   preview.html         人工过一眼排版
#   assets/              代码卡片、表格卡片、封面
```

### 步骤 4 — 演练（不写平台）

```bash
pnpm cli push <slug> --to heybox --dry-run
pnpm cli push <slug> --to wechat  --dry-run
```

关注输出中的「上传 N 项素材」是否与实际引用数一致（多出来 = 有未引用素材或封面重复）。

小黑盒还要看「站外链接」计数：`preview` 会打印数量，超过 5 个会给出告警。

链接处理是固定行为、没有开关：社区规范禁止“外站引流”，因此正文里的站外链接**一律只保留文字、不输出 URL**
（包括 `blog.` / `doc.` / `cfg.` 等自有域名子域，按注册主域名匹配）；文末卡片不含任何地址；
代码块与终端块内的 URL 属于内容，保持原样。平台自身的 `xiaoheihe.cn` 链接不受影响。

### 步骤 5 — 真实写操作（可选，需凭据）

```bash
pnpm cli push <slug> --to heybox --force
```

退出码语义：只要有文章推送失败，`push` / `sync` 都会以 **1** 退出，systemd 会标记 unit `failed`。
平台凭据是**逐平台隔离**的：`--to all` 时某个平台没凭据只会跳过它并告警，另一个平台照常运行；只有所有请求的平台都不可用才中止。
相同错误（忽略 `rid` 追踪号）会合并成一条并列出受影响文章，避免同一配置错误刷屏。

写后**必须回读校验**，不能只看返回值：

```bash
# 1) 草稿结构：Block[0] 是否为整篇 HTML、img 块是否与唯一图片数一致
# 2) 浏览器实测：打开 https://www.xiaoheihe.cn/creator/editor/draft/article/<draftId>
#    核对：标题 / h2 数量 / 图片数（= 封面 + 正文图，且无重复）/ 结尾是否完整
```

验收基线（小黑盒）：

- `wrappers == imgs == uniqueIds`，`broken == 0`；
- 首个块是封面图，比例 `1280x720`；
- 文末能看到版权卡片，说明**没有截断**。

> 注意：小黑盒有发帖频率限制（`10006 发帖频率过快`）。批量验证时每次写操作之间留 ≥ 45–60 秒；被限流时先停手，不要连续重试。

---

## 8. 提交与变更规范

- 只 `git add <明确文件>`，禁止 `git add .` / `git add -A`。
- 禁止 `git reset --hard` / `checkout .` / `clean -fd` / `stash` / `--no-verify` / 强推。
- 未经要求不 `git commit`。
- 一次提交只做一件事：重构与功能改动分开，便于回溯。
- 修改用户可见行为时，同步更新 `config.yaml.example` 与该配置项相关文档。

---

## 9. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `Fontconfig warning: invalid attribute 'xsi:nil'` 大量刷屏 | 发行版 fontconfig 新语法不被 `sharp` 内置库识别 | 无害，可忽略；如需静音，移除对应的 `48-guessfamily.conf` / `48-spacing.conf` / `49-sansserif.conf` |
| `Cannot find module '.../dist/index.js'` | 跨包引用了尚未编译的产物 | 先 `pnpm build`（拓扑序），再跑测试 |
| `[Baseline] 本机尚无同步基线…已中止` | 新机器（如 VPS）的 `state.json` 为空，文章会被当成新增 | 运行 `pnpm cli baseline`、复制原机器的 `state.json`，或确属首次推送时加 `--initial-push` |
| 小黑盒 `发帖频率过快:10006` | 短时间多次写操作 | 等待 45–60 秒，不要连续重试 |
| `[Preflight] 目标平台「X」凭据未就绪 … 本次已跳过该平台` | 只有该平台不可用（`--to all` 时会降级为另一平台） | 补该平台凭据即可；单平台目标（`--to wechat`）缺凭据才会中止 |
| `[Preflight] … 已中止本次运行` | 请求的所有平台都不可用 | 同上，至少修好一个平台 |
| `[Config] 已忽略环境变量 WECHAT_APPID` | 环境变量与 config.yaml 同时存在且不同（配置优先，已忽略环境变量） | 想用环境变量就清空 `config.yaml` 的 `wechat.appId`；否则可以删掉该环境变量 |
| 微信 `40013 invalid appid` | `wechat.appId` 与目标公众号不匹配 | 核对 `config.yaml` 的 `wechat.appId`；注意环境变量仅在 config 留空时生效 |
| 微信 `40007 invalid media_id` | 旧草稿/封面素材失效 | 加 `--force` 新建草稿 |
| 小黑盒草稿"少了一半" | 曾把 HTML 切成多个块提交，平台只取 Block[0] | 确保 `Block[0]` 是整篇 HTML（已在实现中固定） |
| 同一张图出现两次 | `<img>` 带了 `src` 属性 | 只输出 `data-original`（已固定，见 `toXiaoHeiHeImgTag`） |
| 正文顶部没有封面 | 该文既无 `image:` 也未配置 `sync.defaultCover` | 补 frontmatter `image:`，或配置 `sync.defaultCover` |

---

## 10. 部署（systemd）

```bash
bash systemd/install-systemd.sh      # 安装并启用 timer
systemctl status md2posts-sync.timer # 查看下次触发时间
systemctl start md2posts-sync.service# 立即跑一次
journalctl -u md2posts-sync.service -n 50 -f
bash systemd/uninstall-systemd.sh [--purge]
```

服务单元关键点：`WorkingDirectory` 为仓库根、`flock -n /tmp/md2posts.lock` 防并发、通过 `-c config.yaml` 读取配置。

**凭据与优先级**：

- 凭据只写在 `config.yaml`（已被 `.gitignore` 忽略，不入库），安装脚本**不会**创建任何 env 文件。
- `config.yaml` 优先级最高；`WECHAT_APPID` / `WECHAT_SECRET` / `MD2POSTS_WEBHOOK_URL` 仅在对应字段留空时作为兜底。
- 旧版本创建的 `/etc/md2posts/md2posts.env` 已不再被读取，可安全删除。
