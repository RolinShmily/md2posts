<h1 align="center">md2wechat</h1>

<h4 align="center">将 Markdown 静态博客文章自动排版并同步至微信公众号草稿箱的工具</h4>

<div align="center">

[![stars](https://img.shields.io/github/stars/RolinShmily/md2wechat.svg?style=flat&color=green)](https://github.com/RolinShmily/md2wechat)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-339933?style=flat&logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![pnpm](https://img.shields.io/badge/pnpm-workspace-F69220?style=flat&logo=pnpm&logoColor=white)](https://pnpm.io/)

<br>

[English](README.md) | [简体中文](README_zh.md)

</div>

---

## 项目简介

**md2wechat** 用于将采用「Markdown + YAML frontmatter」编写的静态博客文章（首个落地对象为 [SrP-BloG](https://github.com/RolinShmily/SrP-BloG)，通过字段映射配置即可适配 Hugo、Hexo、Astro 等任意静态博客）自动渲染为微信公众号兼容的内联样式 HTML，并同步推送至**微信公众号草稿箱**（`cgi-bin/draft/*`），最后由人工在公众号后台确认发表。

- **零侵入设计**：不修改、不污染博客源仓库的任何文件或 frontmatter 字段。所有同步状态、图片 SHA-256 缓存与配置均独立保存在外部。
- **默认远程拉取（VPS 零门槛开箱即用）**：默认直接从远程 Git 博客仓库（默认 `https://github.com/RolinShmily/SrP-BloG.git`，可在 `config.yaml` 自由修改）拉取同步。首次运行自动 clone 到 `.cache/blog-repo`，后续每次自动执行 `git pull --ff-only` 同步最新提交，你在 VPS 上**完全无需手动事先克隆或维护博客仓库**！
- **内置 28 套公众号主题**：复用 [laogou717/md-wechat](https://github.com/laogou717/md-wechat) 渲染核心，列表采用微信安全的 `<section>` 结构（防嵌套列表被微信拍扁），代码块采用逐行块级 `<code>` + 内联高亮（防吞换行）。
- **符合真实运营习惯的同步策略**：
  - **定时自动同步 (`sync`)**：默认**只自动推送新发表的文章**。老文章在博客上的修修补补会被 `check` 检测到，但不会自动重推刷屏你的公众号草稿箱。
  - **按需自选推送 (`push`)**：支持指定单篇、批量指定多篇，或直接进入**终端交互式勾选列表**，随时按序号、区间或关键词挑选文章推入草稿箱。

---

## 核心特性

- **AST 感知的 Markdown 预处理管线**：
  - 基于 `markdown-it` 解析器的 `token.map` 精确识别代码块区间，配合行内反引号掩码，确保代码块（```` ``` ````）与行内代码（`` `...` ``）内部的 HTML/符号 **100% 不被误改**。
  - **正文标题自动降级**：默认将正文 `h1~h5` 顺移为 `h2~h6`，解决博客习惯用 `#` 写章节标题、而公众号主题将 `h1` 当作居中大标题的冲突。
  - **扩展语言高亮别名**：原生支持 `zsh`、`sh`、`shell`、`pwsh`、`ps1`、`cfg`、`conf`、`cmd`、`nginx`、`toml`、`jsonc`、`plist` 等技术博客常见语言高亮，同时在 Mac 代码窗顶部保留原始语言标签名。
  - **丰富方言转换**：支持 GFM 任务列表（`- [ ]` / `- [x]` → `☐` / `☑`）、GFM 脚注（`[^id]`）、跨行 Bilibili/YouTube `<iframe>` 自动转主题同款**视频占位卡**、HTML `<img>` 转 Markdown 图片。
  - **智能清洗无意义图注**：自动剔除 `1`、`alt text`、`屏幕截图...`、`Snipaste...`、文件名等占位 `alt`，仅将有实际中文语义的 `alt` 渲染为图注。
  - **数学公式防破版与告警**：自动保护行内 `$...$` 与块级 `$$...$$` 中的 `_` 和 `*` 不被误解析为斜体，并输出公式所在行号提示。
  - **外链转文末脚注**：非微信域名外链自动转为正文中带编号的角标并在文末生成【参考资料】，微信内链（`mp.weixin.qq.com`）保留直接点击。
- **全自动图片与封面管线**：
  - 使用 `sharp` 将 `.webp` 转为 `.png`/`.jpg`（透明通道转 JPG 自动填白底防黑底），并对超过 900KB 的大图（如 5MB+ 截图）按四级阶梯自适应压缩至 900KB 以内，彻底规避微信 `media/uploadimg` 的 1MB 上限（`45001`）。
  - 自动下载 jsDelivr 等外链图片并上传至微信图床，防止外链图被微信后台过滤。
  - **SHA-256 前置缓存**：在处理或下载前先比对 `state.json` 缓存，已上传过的图片与封面直接复用微信 `mmbiz.qpic.cn` 地址与 `media_id`（零 `sharp` 开销、零重复上传）。
  - **三级封面兜底**：优先取 frontmatter `image` → 若为空自动取文章目录下第一张配图 → 若仍无配图则使用 `config.yaml` 中配置的 `sync.defaultCover`。
- **微信字段合规裁剪与草稿自愈**：
  - **标题（≤ 32 字）**：超长时优先按 `|` 从右向左逐段剥离副标签，仍超长则安全截断加 `…`（防 `45003`）。
  - **摘要（≤ 120 字）**：超长自动截断加 `…`（防 `45004`）。
  - **草稿更新自愈**：更新已有草稿（`draft/update`）时，若该草稿已在微信后台被发表或手动删除（返回 `40007`），自动降级调用 `draft/add` 重建草稿；遇到配额耗尽（`45009`）、IP 白名单（`40164`）或权限错误（`48001`）则立即熔断报错。
- **本地离线预览与一键复制**：
  - `md2wechat preview <slug>` 可在零微信 API 请求下生成带手机边框模拟与**「一键复制富文本」按钮**的独立 HTML 文件（本地图片已内联为 Base64），双击即可在浏览器预览并一键复制到公众号后台粘贴。

---

## 目录结构

```text
md2wechat/
├── wechat-sdk/                    # @md2wechat/wechat-sdk：零外部依赖的纯微信 API SDK
├── renderer/                      # @md2wechat/renderer：Vendor md-wechat 渲染引擎 + AST 预处理器
├── sources/                       # @md2wechat/sources：文件系统文章源适配器 + 复合 SHA-256 计算
├── sync-core/                     # @md2wechat/sync-core：sharp 图片处理、进程锁状态存储、同步流水线与 Webhook 通知
├── cli/                           # @md2wechat/cli：命令行入口
├── systemd/                       # systemd 定时服务单元与一键安装脚本
└── config.example.yaml            # 完整配置文件模板
```

---

## 快速开始

### 1. 安装、构建与测试

环境要求：**Node.js >= 22**，**pnpm >= 10**。

```bash
pnpm install --ignore-scripts
pnpm build
pnpm test
```

### 2. 配置凭据

复制 `config.example.yaml` 为 `config.yaml`，并通过环境变量传入公众号密钥（切勿将密钥提交进代码库）：

```bash
export WECHAT_APPID="wx_你的AppID"
export WECHAT_SECRET="你的AppSecret"
```

### 3. 运行微信权限与 IP 白名单诊断

```bash
node cli/dist/index.js diagnose
```

诊断命令将依次验证：
1. **凭据格式**（AppID / AppSecret）；
2. **Access Token 与出口 IP 白名单**（若未加白名单，会从 `40164` 报错中自动提取并打印当前服务器出口 IP）；
3. **草稿箱接口权限**（调用 `draft/count` 验证当前账号是否可正常使用草稿箱 API）。

---

## CLI 命令指南

```bash
# 1. 查看内置的 28 套公众号排版主题
node cli/dist/index.js themes

# 2. 离线扫描与状态检查（零微信网络请求）
# 区分展示【新增待自动同步】与【历史文章已修改（可手动选推）】
node cli/dist/index.js check

# 3. 本地离线排版预览（生成带「一键复制富文本」按钮的独立 HTML）
node cli/dist/index.js preview 45-immortalwrt-1
node cli/dist/index.js preview 45-immortalwrt-1 -t fullstack-blue -o ./preview.html

# 4. 建立历史文章基线（首次启用前运行，跳过存量老文章）
node cli/dist/index.js baseline                              # 将全部现有已发布文章设为基线
node cli/dist/index.js baseline 45-immortalwrt-1 53-qt6-1    # 仅将指定的某几篇设为基线
node cli/dist/index.js baseline --except 61-cf-tunnel-vps    # 除指定文章外全部设为基线
node cli/dist/index.js baseline --remote                     # 设为基线并从微信草稿箱拉取现有草稿自动绑定 draftMediaId

# 5. 手动或交互式选择文章推送到草稿箱
node cli/dist/index.js push                         # 进入交互式列表勾选
node cli/dist/index.js push --filter openwrt        # 按关键词筛选后勾选
node cli/dist/index.js push 61-cf-tunnel-vps        # 指定推送单篇
node cli/dist/index.js push 60-aria2-1 61-cf-tunnel-vps  # 一次指定多篇批量推送
node cli/dist/index.js push 45-immortalwrt-1 --dry-run   # 模拟演练模式（不发真实写请求）

# 6. 自动增量同步（默认仅推送【新发表文章】，忽略老文章修改）
node cli/dist/index.js sync
node cli/dist/index.js sync --include-updated       # 破例将修改过的老文章也一并同步
```

### 交互式勾选输入语法（`md2wechat push`）

不带参数运行 `push`（或加 `-i` / `--select`）时，终端会优先置顶展示 `🆕 新增` 与 `✏️ 已修改` 文章，支持输入：
- **单个或多个序号**：`1` 或 `1,3,5`
- **序号区间**：`1-4`
- **快捷指令**：`new`（全选新增文章）、`updated`（全选已修改文章）
- **直接输入 Slug**：`45-immortalwrt-1`
- **取消退出**：`q`

---

## VPS 定时后台服务部署 (`systemd`)

在固定公网 IP（已加入公众号白名单）的 Linux VPS 上，可通过 `systemd timer` 每 10 分钟静默轮询一次，无需开放任何入站端口：

```bash
# 1. 构建并归档存量历史文章
pnpm install --ignore-scripts && pnpm build
# 在 config.yaml 中将 source.gitPull 设为 true（每次运行前自动 git pull --ff-only）
node cli/dist/index.js baseline

# 2. 一键注册并启动 systemd 定时服务（自动检测当前仓库与 node 路径）
bash systemd/install-systemd.sh

# 3. 写入公众号密钥（权限已设为 600）
sudo nano /etc/md2wechat/wechat.env

# 4. 手动触发一次并查看实时日志
sudo systemctl start md2wechat-sync.service
journalctl -u md2wechat-sync.service -n 50 -f
```

并发安全由外层 Linux `flock` 与内层 `StateStore.withLock()`（带 PID 存活检测的 `.lock` 文件）双重保障。

---

## 致谢与许可

- 排版渲染核心（`renderer/vendor/`）移植自 [laogou717/md-wechat](https://github.com/laogou717/md-wechat)（MIT 许可证）。
- 本项目基于 MIT 许可证开源。
