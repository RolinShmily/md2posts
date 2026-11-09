# 项目架构（ARCHITECTURE）

本文描述 md2posts 的分层结构、各包职责、关键数据流与设计约束。构建/测试/验证流程见 [BUILD.md](./BUILD.md)。

---

## 1. 设计目标与边界

md2posts 把「Markdown + YAML frontmatter 的静态博客文章」转成「平台可稳定渲染的富文本」，并推入草稿箱。

三条硬约束决定了整体架构：

1. **平台渲染引擎差异极大**
   - 微信公众号：只吃内联 CSS，代码块必须逐行上色，图片 >1MB 会被拒。
   - 小黑盒：ProseMirror 结构化解构，**不支持 `<table>`**、不支持原生代码块、HTML 里只要出现 `src` 属性就会把一张图渲染成两个节点。
   - 因此「渲染」必须是平台专属的，而不能共用一套 HTML。
2. **网络写操作不可重入**
   - 微信有 token 配额与草稿数限制；小黑盒有发帖频率限制（`10006`）。
   - 所以必须「先离线生成 → 演练校验 → 再写」。
3. **CLI 要能无人值守**
   - systemd 定时跑，任何交互式提示都不能出现在 `sync` 路径上；错误必须是可判定的错误码而非弹窗。

不做什么：不托管博客、不改写源仓库内容、不替代平台编辑器（只负责把内容推进草稿箱）。

---

## 2. 分层与依赖

```text
                    ┌─────────────────────────────┐
                    │            cli              │  参数解析 / 终端呈现 / 交互选择
                    └──────────────┬──────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │         sync-core           │  编排、状态、缓存、通知
                    │  pipeline / state-store     │
                    └───┬────────┬────────┬───────┘
                        │        │        │
        ┌───────────────▼──┐ ┌───▼─────┐ ┌▼──────────────┐
        │   wechat-sdk     │ │renderer │ │  heybox-sdk   │
        │ API/token/draft  │ │主题排版 │ │ API/转换/封面  │
        └──────────────────┘ └─────────┘ └───────┬───────┘
                                                 │
                                        ┌────────▼────────┐
                                        │     sources     │  文章扫描 + 资产解析
                                        └─────────────────┘
```

依赖方向严格单向（`A → B` 表示 A 依赖 B）：

| 包 | 依赖 |
|---|---|
| `cli` | `sync-core`, `wechat-sdk`, `heybox-sdk`, `renderer`, `sources` |
| `sync-core` | `sources`, `renderer`, `wechat-sdk`, `heybox-sdk` |
| `heybox-sdk` | `sources`（资产解析、Git 根定位） |
| `renderer` | 无内部依赖 |
| `wechat-sdk` | **零依赖**（仅 Node 内置模块） |
| `sources` | 无内部依赖 |

无循环依赖。跨包只允许通过各包 `src/index.ts` 暴露的公共 API 交互。

---

## 3. 各包职责

### `packages/sources` — 内容与资产来源

- `FsSource`：扫描本地目录或 Git 仓库（`bundle` / `flat` 两种布局），解析 frontmatter，产出 `SourcePost`。
- `contentHash`：把 `title/summary/cover/body` **以及所有兄弟图片的字节哈希**合成 SHA-256，用于「内容是否变化」判定——图片被替换也算变化。
- `resolveLocalAsset`：**唯一的资产路径解析实现**，支持 `{postDir}` / `{repoRoot}` 占位符、URL 解码、绝对路径，被微信与小黑盒两条链路共用。
- `findGitRoot`：向上查找 `.git`，用于展开 `{repoRoot}`。

### `packages/renderer` — 微信公众号排版

- `preprocess.ts`：基于 markdown-it AST 定位代码块行区间，**保证代码块永不被后续正则改写**；再处理标题顺移、任务列表、数学公式、iframe、脚注、图注清洗。
- `vendor/`：适配自 md-wechat 的内联样式渲染器，内置 28 套主题；`hljs-extra.ts` 扩展高亮语言别名。
- 输出是「微信可安全粘贴的 HTML」，不发任何网络请求。

### `packages/wechat-sdk` — 微信 API 客户端

- `token.ts`：token 获取/缓存/并发去重，遇 `42001/40001` 自动刷新并重试一次，遇 `45009` 配额错误**不重试**。
- `endpoints/draft.ts`：草稿、素材、发布状态接口。
- `errors.ts`：把微信返回码转成可判定的 `WeChatError`（含 IP 白名单错误的出口 IP 解析）。

### `packages/heybox-sdk` — 小黑盒 SDK 与文章转换

四个关注点分离清晰：

| 文件 | 职责 |
|---|---|
| `api-client.ts` | 签名请求、COS 图片上传、`/bbs/app/api/link/post` 提交草稿 |
| `signing.ts` | `hkey` 路径签名与 Workshop `_rnd` 签名 |
| `transformer.ts` | Markdown → 小黑盒富文本；代码块/表格/封面策略都在这里 |
| `card-renderer.ts` | SVG → PNG 卡片（代码卡片、表格卡片、16:9 封面） |
| `browser-publisher.ts` | 无头浏览器兜底通道（API 不可用时直接操作编辑器） |
| `client.ts` | 编排：导出发布包 → API → CLI → 浏览器 → 本地包，逐级降级 |

### `packages/sync-core` — 编排层

- `pipeline.ts`：`prepare / check / baseline / preview / push / sync` 六个动作；微信与小黑盒分别推送，失败互不影响。
- `state-store.ts`：`state.json` 持久化 + 跨进程文件锁。记录每篇的 `contentHash`、`draftMediaId` / `heyboxDraftId`、图片与封面的上传缓存。
- `image-processor.ts`：图片压缩（WebP→PNG/JPEG）、远程图下载、按 SHA-256 复用已上传的微信 URL。
- `normalize.ts`：标题/摘要裁剪、交互式选择表达式解析。
- `notifier.ts`：Webhook 通知（飞书/企业微信/钉钉/通用 JSON）。

### `packages/cli` — 入口

仅做三件事：解析参数 → 组装配置与客户端 → 打印结果。业务逻辑一律下沉到 `sync-core`。

---

## 4. 关键数据流

### 4.1 增量同步（`sync`）

```text
prepare()  ──> git pull（受 pullInterval 冷却控制）
   │
check()    ──> scanPosts() ──> 逐篇比对 contentHash ──> new / updated / unchanged / baselined / draft
   │
sync()     ──> 仅取 new（可选 updated，受 maxPerRun 限流）
   │
push()     ──┬─> 微信：preprocess → render → 图片上传/复用 → draft/add|update
             └─> 小黑盒：prepare(封面/代码/表格) → COS 上传 → link/post
   │
stateStore ──> 写回 hash 与平台草稿 ID
```

### 4.2 小黑盒文章转换管线（`prepareHeyBoxArticle`）

顺序不可调换，理由写在同一行注释里：

1. **封面**：`frontmatter image:` → `sync.defaultCover`（可含 `{repoRoot}`）。**不猜**正文首图。
2. **iframe → 提示文本**：小黑盒不吃 iframe。
3. **代码块**（三档 `heybox.codeBlockMode`，默认 `auto`）：
   - `auto`：≤6 行或 `bash/pwsh/sh/config/...` → 原生可复制终端块；更长源码 → 2x Retina 卡片图。
   - `terminal`：全部原生块；`image`：全部卡片图。
4. **表格 → 卡片图**（ProseMirror 无 table 节点），失败降级为引用列表。
5. **掩码保护**：把已处理块的占位符替换掉，再做外链/行内码/删除线/任务列表/公式等文本级改写，最后还原——避免 `$HOME` 之类被公式规则吃掉。
6. **图片资产**：本地图片转 Base64 内联，并登记多种键名（原名 / URI 编码名 / `assets/` 前缀）以兼容不同引用写法。
7. **富文本渲染 + 清洗**：标题只保留 h2/h3；产出保守 HTML 子集。

### 4.3 提交（`createArticleDraft`）

- 图片按 **SHA-256 去重**上传；同一内容只传一次，但保留全部文件名别名供 HTML 替换。
- 只上传**正文实际引用**的素材（封面除外），未引用兄弟图不再白传。
- `text` 载荷契约：`Block[0]` 必须是**整篇 HTML**，其后才是 `img` 元数据块。早前把 HTML 切成多段交错块会导致平台只取第 0 段，正文被截断。
- `<img>` 只写 `data-original/data-width/data-height`，**绝不写 `src`**（写了会一图两渲染）。

---

## 5. 关键设计决策与约束

| 决策 | 原因（都是实测结论） |
|---|---|
| 小黑盒短命令用原生终端块，长源码用图片 | 图片不可复制、缩放不可控、占上传配额；纯文本可长按复制且响应式 |
| 封面只认 `image:` / `defaultCover` | 用正文首图当封面会得到随机截图，且与正文重复 |
| 封面插到正文顶部 | 小黑盒文章无独立封面字段，不入正文就等于没有封面 |
| 表格转图 | ProseMirror 无 `table` 节点，原生 `<table>` 会被丢弃 |
| `<img>` 不带 `src` | 带 `src` 时编辑器生成「缩略图 + 裁切大图」两个节点 |
| 代码块行区间用 AST 定位 | 正则改 Markdown 极易误伤围栏内容 |
| 资产解析单一实现 | 两条链路对 `./img.png`、`%E5%9B%BE.png`、`{repoRoot}` 的理解必须一致 |
| 状态文件在仓库外 | 不污染博客仓库，且可跨机保留 |

---

## 6. 扩展点

| 需求 | 落点 |
|---|---|
| 新增平台 | 新建 `packages/<platform>-sdk`，实现 `publishDraft()`；在 `sync-core/pipeline.ts` 增加分支；CLI 增加 `--to` 取值 |
| 新增内容来源（如 RSS/Notion） | 实现 `SourceAdapter` 接口，替换 `sources` 的注入 |
| 新增公众号主题 | `renderer/vendor/themes.js` |
| 调整小黑盒排版 | `transformer.ts` 的转换阶段 / `card-renderer.ts` 的卡片样式 |
| 调整同步策略 | `config.yaml` 的 `sync.*`，或 `pipeline.sync()` |

---

## 7. 已知边界

- 小黑盒 Web 编辑器会**丢弃 `<code>` 标记**，终端块因此退化为普通字体（缩进用 `&nbsp;` 保留）。
- 小黑盒存在发帖频率限制；批量推送需自行节流。
- 微信 `thumb_media_id` 失效（`40007`）时会降级为新建草稿，历史草稿需人工清理。
- Playwright 依赖系统字体；部分发行版的 fontconfig 配置会让 `sharp`/SVG 输出无害告警，见 [BUILD.md](./BUILD.md#9-常见问题)。
