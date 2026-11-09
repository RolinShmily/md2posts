<h1 align="center">md2posts</h1>

<h4 align="center">Automated Markdown static blog multi-platform formatter & sync tool (WeChat Draft Box + XiaoHeiHe / HeyBox)</h4>

<div align="center">

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=flat&logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![pnpm](https://img.shields.io/badge/pnpm-workspace-F69220?style=flat&logo=pnpm&logoColor=white)](https://pnpm.io/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](README.md) | [简体中文](README_zh.md)

</div>

---

## Overview

**md2posts** converts static blog posts written in Markdown + YAML frontmatter (compatible with Hugo, Hexo, Astro, Next.js, and other static site generators) into platform-optimized rich formats and synchronizes them to:

| Platform | Core Highlights | Pain Points Solved |
|---|---|---|
| **WeChat MP** (`wechat`) | 28 built-in themes, WeChat-safe section lists, line-by-line highlighted code blocks, external links to footnotes, adaptive WebP compression | Eliminates WeChat editor layout breakage, line-break losses, and >1MB image limit errors |
| **XiaoHeiHe** (`heybox`) | **Hybrid code rendering** (short commands become copy-friendly native terminal blocks, long source files become dark PNG cards), tables rendered as cards, cover inserted at body top, ProseMirror H2/H3 alignment, direct draft publishing | Solves mobile code truncation, unreadable squeezed screenshots, and duplicated images |

---

## Documentation

| Doc | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Package responsibilities, dependency graph, data flows, and the design decisions behind platform quirks |
| [docs/BUILD.md](docs/BUILD.md) | Environment, build/test commands, coding & dependency rules, and the 5-step verification workflow |

---

## Quick Start

### 1. Install & Build

Requires **Node.js >= 20** and **pnpm >= 10**.

```bash
pnpm install
pnpm build
```

### 2. Configure

Copy the template and configure your blog path and platform credentials:

```bash
cp config.yaml.example config.yaml
nano config.yaml
```

> **XiaoHeiHe Authentication** (local scan or copy to VPS):
> ```bash
> # Log in once via browser QR scan to store your persistent session
> xiaoheihe login --browser chrome
> ```

---

## Common CLI Commands

All commands can be invoked via `pnpm cli <command>`:

```bash
# 1. Offline status check (reports new posts vs modified posts with zero external API calls)
pnpm cli check

# 2. Local offline preview (double click preview.html to copy rich text with one click)
pnpm cli preview my-post --to wechat      # WeChat mobile viewport preview
pnpm cli preview my-post --to heybox      # XiaoHeiHe bundle preview (with code card images)

# 3. Targeted or batch push
pnpm cli push my-post --to wechat         # Push a single post to WeChat Draft Box
pnpm cli push my-post --to heybox         # Push a single post to XiaoHeiHe Draft Box
pnpm cli push my-post --to all            # Single command push to both platforms
pnpm cli push -i --dry-run                # Interactive terminal picker simulation

# 4. Routine incremental auto-sync (syncs brand-new posts only by default)
pnpm cli sync --to all                    # Push new posts to all platforms
```

---

## Headless Linux VPS Deployment

### 1. Handling XiaoHeiHe Login on a Headless VPS

Linux servers typically do not have a graphical desktop. The recommended approach is **copying the local session from your desktop**:

```bash
# Step 1: Scan and log in on your desktop with a display (Windows / Mac)
xiaoheihe login --browser chrome

# Step 2: SCP the generated session.json directly to your VPS config directory
# Windows PowerShell:
scp $env:LOCALAPPDATA\xiaoheihe-cli\session.json user@your-vps-ip:~/.config/xiaoheihe-cli/session.json

# Linux / macOS:
# scp ~/.config/xiaoheihe-cli/session.json user@your-vps-ip:~/.config/xiaoheihe-cli/session.json
```
Verify on the VPS with `xiaoheihe auth status`—it will display `authenticated: true` immediately!

### 2. Install Daily systemd Service

```bash
# Register and start the background daily service (auto-detects PATH, Node, flock & config.yaml)
bash systemd/install-systemd.sh

# View timer status and live logs
systemctl status md2posts-sync.timer
journalctl -u md2posts-sync.service -n 50 -f

# Uninstall (when needed)
bash systemd/uninstall-systemd.sh [--purge]
```

---

## Monorepo Layout

```text
md2posts/
├── packages/
│   ├── wechat-sdk/     # WeChat Official Account API client (zero runtime dependencies)
│   ├── heybox-sdk/     # XiaoHeiHe SDK: transformer, code/table cards, cover, publisher
│   ├── renderer/       # Markdown renderer & AST preprocessor (28 themes)
│   ├── sources/        # Blog scanning, composite SHA-256, shared asset resolver
│   ├── sync-core/      # Sync orchestration, state store, image cache, notifier
│   └── cli/            # CLI entry point & terminal presentation
├── docs/               # Architecture and build/development docs
├── systemd/            # Linux systemd service suite
└── config.yaml.example # Configuration template
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the dependency graph and per-package boundaries.

---

## Credits & License

- WeChat inline styling & rendering core (`renderer/vendor/`) adapted from [laogou717/md-wechat](https://github.com/laogou717/md-wechat) under the MIT License.
- XiaoHeiHe community interaction & posting design inspired by [AaronZ345/xiaoheihe-cli](https://github.com/AaronZ345/xiaoheihe-cli) under the MIT License.
- Licensed under the MIT License.
