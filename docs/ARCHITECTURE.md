# md2wechat 架构设计与仓库勘察报告

> 本文档汇总对 `laogou717/md-wechat`、`RolinShmily/SrP-BloG` 两个仓库及微信公众号开放平台文档的完整勘察结论与最终工程架构。

---

## 1. 仓库与平台勘察结论

### 1.1 `laogou717/md-wechat`（MIT）
- **上游版本**：Commit `8a21962efdc44b83d1673e557a52cf963c72b669`。
- **Node 兼容性**：`src/lib/renderer.js` 与 `src/lib/themes.js` 完全不含 `window` / `document` / `navigator` / `import.meta` 等浏览器 API，在 Node 22+ 环境下可直接运行。
- **微信兼容性**：
  - 列表全部输出为 `<section>` + 纯文本序号/圆点（`•`/`◦`/`▪`），彻底规避微信公众号后台将嵌套 `<ul>/<ol>/<li>` 扁平化的问题。
  - 代码块逐行拆分为 `<code style="display:block;white-space:pre;">`，避免微信编辑器吞换行或打散 `<pre>`。
  - 语法高亮通过 `highlight.js` 转为行内 `style="color:..."`，不依赖外部 `<style>`。
- **Vendor 策略**：将 `renderer.js`、`themes.js` 与 `LICENSE` 原样存放于 `packages/renderer/vendor/`，在外层通过 `hljs.registerLanguage` / `hljs.registerAliases` 扩展语言支持，通过 `preprocess.ts` 和 `index.ts` 提供稳定封装。

### 1.2 `RolinShmily/SrP-BloG`（代码 MIT，文章 CC BY-NC-SA 4.0）
- **标准域名**：全库（`src/config/site.ts`、`wrangler.jsonc`、`public/admin/config.yml`、CI 工作流与文章内链）统一使用 `https://blog.srprolin.com`。
- **全量 62 篇文章特征统计**：
  - **正文标题层级**：60/62 篇文章在正文中使用 `#`（H1）作为一级章节标题（博客前端依靠 `rehypeShiftBodyHeadings` 降级为 `<h2>`）。因此同步至微信时必须默认将正文 `h1~h5` 下移为 `h2~h6`。
  - **微信字段长度**：34 篇文章 `title` 超过微信草稿 32 字上限（多为 `主标题 | 标签1 | 标签2` 格式）；6 篇文章 `description` 超过 120 字上限。
  - **封面分布**：54 篇有 `image` 封面，8 篇（含最新 7 篇已发布文章 `#55 ~ #61`）`image` 为空字符串 `""`。
  - **图片资源（290 个文件，241 处引用）**：
    - 格式包含 `.png` (253)、`.jpg` (19)、`.jpeg` (1)、`.webp` (17)；
    - 9 张图片体积超过微信 `uploadimg` 1MB 上限（最大 5.65MB）；
    - 包含 `./xxx.png`、无 `./` 裸文件名、URL 编码中文与空格（`%E5%9B%BE%E7%89%87.png`）、特殊修饰符冒号 `꞉`（`U+A789`）及 5 处外链图片（`cdn.jsdelivr.net` 等）。
  - **特殊语法**：12 篇含 GFM 表格、15 篇含连续多图、2 篇含任务列表、2 篇含 KaTeX 数学公式（`4-ml-1`, `9-markdown-1`）、3 篇含原生 HTML / Bilibili & YouTube `<iframe>`。

### 1.3 微信公众号接口约束
- **`POST /cgi-bin/draft/add` & `draft/update`**：
  - `title` ≤ 32 字（超限报 `45003`）；`author` ≤ 16 字；`digest` ≤ 120 字（超限报 `45004`）；
  - `content` 纯文本 < 2 万字且 HTML < 1MB（超限报 `45002`）；
  - `thumb_media_id` 必填，且必须为永久图片素材 `media_id`。
- **`POST /cgi-bin/media/uploadimg`**：仅支持 `jpg/png`，大小 ≤ 1MB（超限报 `45001`），返回 `https://mmbiz.qpic.cn/...`，不占永久素材配额。
- **`POST /cgi-bin/material/add_material?type=image`**：上传永久图片素材获取封面 `media_id`。

---

## 2. Markdown 方言与平台差异处理矩阵

| 特性 | 博客写法 | 预处理与渲染对策 |
| --- | --- | --- |
| 正文 `#` 一级标题 | `# 章节标题` | `shiftBodyHeadings: true`：非代码块内 `h1~h5` 自动顺移为 `h2~h6` |
| 连续单图段落 | 连续多张 `![](...)` | 固定 `galleryMode: 'stack'`，单列全宽纵向排列，不裁剪 |
| 图片 `alt` 图注 | CI 强制非空，含 `1`、`alt text`、`屏幕截图...` | `imageCaptionMode: 'smart'`：自动清空纯数字、文件名、截图工具前缀与短标识符，保留真实中文说明 |
| 代码块语言别名 | `zsh`, `pwsh`, `ps1`, `cfg`, `conf`, `cmd`, `moon.json` | 通过 `hljs.registerLanguage` + `hljs.registerAliases` 原生支持，保留原语言标签名 |
| 任务列表 | `- [ ]` / `- [x]` | 转换为 `- ☐` / `- ☑` |
| GFM 脚注 | `[^id]` + `[^id]: 说明` | 行内转为 `[注N]`，文末汇总为引用说明块 |
| 外链、裸域名与锚点 | `decapcms.org/...`、`../slug`、`#anchor` | `#anchor` 降级为纯文本；裸域名补 `https://`；相对路径按 `canonicalUrl` 补全；外链统一转文末【参考资料】 |
| HTML `<img>` 与 `<iframe>` | 跨行 `<iframe src="//player.bilibili.com/...">` | 仅在代码块外将 `<img ...>` 转为 `![]()`，跨行 `<iframe>` 压为单行并补全 `https://` 以触发视频占位卡 |
| 数学公式 | `$x_1$`、`$$\n...\n$$` | 保护公式内 `_` 与 `*` 不被解析为斜体，并输出行号告警（掩码保护行内代码 `` `$PATH` `` 不误报） |

---

## 3. Monorepo 模块架构

```text
md2wechat/
├── assets/default-cover.png   # 内置默认兜底封面
├── config.example.yaml        # 完整配置模板
├── packages/
│   ├── wechat-sdk/            # @md2wechat/wechat-sdk：零外部依赖的微信 API SDK
│   ├── renderer/              # @md2wechat/renderer：Vendor 渲染器 + AST 感知预处理器
│   ├── sources/               # @md2wechat/sources：博客文章扫描与复合 SHA-256 计算
│   ├── sync-core/             # @md2wechat/sync-core：sharp 图片处理、状态锁、通知与流水线
│   └── cli/                   # @md2wechat/cli：命令行工具与 systemd 部署模板
```
