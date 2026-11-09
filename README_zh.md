<h1 align="center">md2posts</h1>

<h4 align="center">将 Markdown 静态博客文章自动排版并同步至多平台草稿箱（微信公众号 + 小黑盒 HeyBox）</h4>

<div align="center">

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=flat&logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![pnpm](https://img.shields.io/badge/pnpm-workspace-F69220?style=flat&logo=pnpm&logoColor=white)](https://pnpm.io/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](README.md) | [简体中文](README_zh.md)

</div>

---

## 项目简介

**md2posts** 是一款专为技术博主打造的多平台内容同步工具。无需修改博客源仓库的任何文件，将本地或远程 Git 博客（Hugo、Hexo、Astro 等）的 Markdown 文章自动转码并推入草稿箱：

| 发布平台 | 核心特性 | 解决痛点 |
|---|---|---|
| **微信公众号** (`wechat`) | 28 套内置排版主题、安全 Section 列表、代码块逐行高亮、外链转文末角标脚注、WebP 自适应压缩上传 | 彻底解决微信后台格式错乱、吞代码换行、图片超限问题 |
| **小黑盒社区** (`heybox`) | **代码块分级渲染**（短命令转原生可复制终端块，长源码转深色卡片图）、表格转卡片图、封面插入正文顶部、**站外链接自动降级为纯文字**、支持直推草稿箱 | 解决移动端代码被拍扁、截图缩放不可读、图片重复，以及“外站引流”违规风险 |

---

## 文档

| 文档 | 内容 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 项目架构：分层与依赖、各包职责、关键数据流、平台约束背后的设计决策 |
| [docs/BUILD.md](docs/BUILD.md) | 构建与开发规范：环境、命令、编码/依赖约定、测试策略与五步验证流程 |

---

## 快速开始

### 1. 安装与构建

环境要求：**Node.js >= 20**，**pnpm >= 10**。

```bash
pnpm install
pnpm build
```

### 2. 初始化配置文件

复制模板并编辑你的博客路径与发布凭据：

```bash
cp config.yaml.example config.yaml
nano config.yaml
```

**凭据怎么放**：凭据只写在 `config.yaml` 里（该文件已被 `.gitignore` 忽略，不会入库）。
环境变量 `WECHAT_APPID` / `WECHAT_SECRET` 仅在对应字段留空时作为兜底——**配置文件优先**，
安装脚本也不会创建任何 env 文件。

```bash
# 小黑盒：有图形界面时扫码一次，登录态保存到 heybox.sessionFile（默认 .cache/heybox-session.json）
pnpm cli login --to heybox
```

---

## 常用 CLI 命令

项目不提供全局命令，唯一入口是仓库根目录下的 `pnpm cli <command>`（首次使用需先 `pnpm install && pnpm build`）。
systemd 定时任务内部也调用同一份 CLI 代码，只是用 node 绝对路径，避免依赖 PATH。

```bash
# 1. 扫描博客状态（零网络请求，区分【新增待推】与【历史已修改】）
pnpm cli check

# 2. 本地离线排版预览（无需网络凭据，双击 preview.html 即可在浏览器一键复制富文本）
pnpm cli preview my-post --to wechat      # 微信公众号手机框预览
pnpm cli preview my-post --to heybox      # 小黑盒发布包预览（代码块/表格/封面）

# 3. 按需单篇或批量推送（失败会以退出码 1 结束）
pnpm cli push my-post --to wechat         # 推送单篇至微信公众号草稿箱
pnpm cli push my-post --to heybox         # 推送单篇至小黑盒草稿箱
pnpm cli push my-post --to all            # 单命令一键双端推送
pnpm cli push -i --dry-run                # 进入终端交互式勾选列表模拟演练

# 4. 每日定时增量同步（默认只推送新发表文章，不刷屏历史修改）
pnpm cli sync --to all                    # 增量推送新文章到全部平台
pnpm cli sync --dry-run                   # 演练：只走流程，不发写请求

# 5. 同步基线（回答“哪些文章已经推过”）
pnpm cli baseline                         # 把当前全部已发布文章标记为“已推过”
pnpm cli baseline --status                # 查看基线文件位置/篇数/建立时间（只读，不联网）
pnpm cli baseline --import state.json     # 从其他机器搬运基线（合并，不覆盖本机记录）
```

### 同步基线（baseline）是什么、在哪

基线就是 `sync.stateFile`（默认 `./state.json`，相对 `config.yaml` 所在目录）。它记录每篇文章的
`contentHash`、平台草稿 ID 与图片缓存，用来判断**哪些文章已经推送过**。

- 它是**机器本地**的，不随 Git 仓库同步。新克隆的 VPS 上它是空的，此时所有文章都会被当成“新增”。
- 为防止误推，**空基线 + 存在待推文章时 `sync` 会直接中止**并给出指引：

  ```
  [Baseline] 本机尚无同步基线，但检测到 61 篇待推送文章，已中止以避免误推。
  1) 若这些文章此前已在别处推送过：先建立基线 —— `pnpm cli baseline`，或把原机器的 state.json 复制过来；
  2) 若这是一批确实需要推送的新文章：加 `--initial-push` 明确同意；
  3) 只想先看看会推什么：`pnpm cli check`。
  ```
- 多机场景：`baseline --import` 把一台机器的 `state.json` 合并到另一台即可共享“已推过”认知。

---

## 无桌面 Linux VPS 部署指南

### 1. 解决小黑盒无桌面扫码问题

VPS 通常没有图形桌面，最省事的做法是**把本地登录态和基线一起搬过去**：

```bash
# 步骤 1：在有屏幕的本地电脑上扫码一次（登录态写入 heybox.sessionFile，默认 .cache/heybox-session.json）
pnpm cli login --to heybox

# 步骤 2：把登录态与同步基线一并传到 VPS 的同一仓库目录
scp ~/Projects/md2posts/.cache/heybox-session.json user@vps:~/md2posts/.cache/heybox-session.json
scp ~/Projects/md2posts/state.json                user@vps:~/md2posts/state.json

# 步骤 3：在 VPS 上确认
cd ~/md2posts
pnpm cli baseline --status        # 应显示已记录 61 篇等信息
```

> 若没有本地基线可搬，也可以直接在 VPS 上 `pnpm cli baseline` 就地建立（不联网、不调平台接口），
> 这样 `sync` 就不会把历史文章当成新文章重推。

### 1.5 凭据放在哪

- 微信 AppID/AppSecret 与小黑盒 `sessionFile` 都写在 `config.yaml`，**配置文件优先**；
  环境变量仅在对应字段留空时兜底。
- 安装脚本**不会**创建 `/etc/md2posts/md2posts.env`；旧版本遗留的该文件已不再被读取，可安全删除。

### 2. 安装 systemd 定时任务（每日自动检查并推流）

```bash
# 一键安装后台定时服务（自动检测用户环境 PATH、Node、flock 与 config.yaml）
bash systemd/install-systemd.sh

# 查看定时器状态与运行日志
systemctl status md2posts-sync.timer
journalctl -u md2posts-sync.service -n 50 -f

# 卸载服务（按需）
# 卸载（按需）
bash systemd/uninstall-systemd.sh [--purge]
```

定时任务会打印同步基线与凭据预检结果；**只要有文章推送失败，服务就以退出码 1 结束**，
`systemctl status` 会显示 `failed`，便于发现“看起来跑完其实全失败”的情况。

---

## 项目架构与子包

```text
md2posts/
├── packages/
│   ├── wechat-sdk/     # 微信公众平台 API Client（Token 管理、素材上传、草稿箱，零运行时依赖）
│   ├── heybox-sdk/     # 小黑盒 SDK（文章转换、代码/表格卡片、封面、推流发布）
│   ├── renderer/       # Markdown 渲染与 AST 预处理（28 套精美主题）
│   ├── sources/        # 博客扫描、复合 SHA-256、共享资产解析器
│   ├── sync-core/      # 同步编排、状态存储、图片缓存与通知
│   └── cli/            # 终端命令行交互入口
├── docs/               # 架构与构建开发文档
├── systemd/            # Linux 定时后台服务套件
└── config.yaml.example # 配置文件模板
```

依赖关系与各包边界见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

---

## 致谢与许可

- 微信排版渲染核心（`renderer/vendor/`）移植自 [laogou717/md-wechat](https://github.com/laogou717/md-wechat)（MIT 许可证）。
- 小黑盒社区交互与发帖设计参考自 [AaronZ345/xiaoheihe-cli](https://github.com/AaronZ345/xiaoheihe-cli)（MIT 许可证，特别感谢原作者及维护者的开源贡献）。
- 本项目基于 MIT 许可证开源。
