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
| **小黑盒社区** (`heybox`) | **代码块/表格自动转深色卡片图**、16:9 封面智能裁切、ProseMirror H2/H3 规范对齐、支持直推草稿箱 | 彻底解决小黑盒 App 移动端代码折行拍扁的顽疾 |

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

> **小黑盒账号绑定**（支持本地扫码或同步到 VPS）：
> ```bash
> # 本机打开浏览器扫码一次即可持久化登录态
> xiaoheihe login --browser chrome
> ```

---

## 常用 CLI 命令

所有命令均支持 `pnpm cli <command>`：

```bash
# 1. 扫描博客状态（零网络请求，区分【新增待推】与【历史已修改】）
pnpm cli check

# 2. 本地离线排版预览（无需网络凭据，双击 preview.html 即可在浏览器一键复制富文本）
pnpm cli preview my-post --to wechat      # 微信公众号手机框预览
pnpm cli preview my-post --to heybox      # 小黑盒发布包预览（含代码卡片图）

# 3. 按需单篇或批量推送
pnpm cli push my-post --to wechat         # 推送单篇至微信公众号草稿箱
pnpm cli push my-post --to heybox         # 推送单篇至小黑盒草稿箱
pnpm cli push my-post --to all            # 单命令一键双端推送
pnpm cli push -i --dry-run                # 进入终端交互式勾选列表模拟演练

# 4. 每日定时增量同步（默认只推送新发表文章，不刷屏历史修改）
pnpm cli sync --to all                    # 增量推送新文章到全部平台
```

---

## 无桌面 Linux VPS 部署指南

### 1. 解决小黑盒无桌面扫码问题

Linux VPS 通常没有图形桌面，最推荐的做法是**将本地登录凭据同步至服务器**：

```bash
# 步骤 1：在有屏幕的本地电脑（Windows / Mac）上完成扫码登录
xiaoheihe login --browser chrome

# 步骤 2：直接将生成的 session.json 传到 VPS 的配置目录即可（免去 VPS 打开浏览器的烦恼）
# Windows PowerShell:
scp $env:LOCALAPPDATA\xiaoheihe-cli\session.json user@your-vps-ip:~/.config/xiaoheihe-cli/session.json

# Linux / macOS:
# scp ~/.config/xiaoheihe-cli/session.json user@your-vps-ip:~/.config/xiaoheihe-cli/session.json
```
在 VPS 上执行 `xiaoheihe auth status` 确认显示 `authenticated: true` 即可！

### 2. 安装 systemd 定时任务（每日自动检查并推流）

```bash
# 一键安装后台定时服务（自动检测用户环境 PATH、Node、flock 与 config.yaml）
bash systemd/install-systemd.sh

# 查看定时器状态与运行日志
systemctl status md2posts-sync.timer
journalctl -u md2posts-sync.service -n 50 -f

# 卸载服务（按需）
bash systemd/uninstall-systemd.sh [--purge]
```

---

## 项目架构与子包

```text
md2posts/
├── packages/
│   ├── wechat-sdk/     # 微信公众平台 API Client（Token 管理、素材上传、草稿箱，零依赖）
│   ├── heybox-sdk/     # 小黑盒专属 SDK（代码卡片图渲染、16:9 封面裁剪、推流发布）
│   ├── renderer/       # Markdown 渲染与 AST 预处理（28 套精美主题）
│   ├── sources/        # 静态博客文件系统适配器（Hugo/Hexo 等、复合 SHA-256 计算）
│   ├── sync-core/      # 核心多平台同步编排引擎与状态管理
│   └── cli/            # 终端命令行交互入口
├── systemd/            # Linux 定时后台服务套件
└── config.yaml.example # 配置文件模板
```

---

## 致谢与许可

- 微信排版渲染核心（`renderer/vendor/`）移植自 [laogou717/md-wechat](https://github.com/laogou717/md-wechat)（MIT 许可证）。
- 小黑盒社区交互与发帖设计参考自 [AaronZ345/xiaoheihe-cli](https://github.com/AaronZ345/xiaoheihe-cli)（MIT 许可证，特别感谢原作者及维护者的开源贡献）。
- 本项目基于 MIT 许可证开源。
