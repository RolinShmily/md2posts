<h1 align="center">md2wechat</h1>

<h4 align="center">Automated Markdown static blog to WeChat Official Account Draft Box synchronization tool</h4>

<div align="center">

[![stars](https://img.shields.io/github/stars/RolinShmily/md2wechat.svg?style=flat&color=green)](https://github.com/RolinShmily/md2wechat)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-339933?style=flat&logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![pnpm](https://img.shields.io/badge/pnpm-workspace-F69220?style=flat&logo=pnpm&logoColor=white)](https://pnpm.io/)

<br>

[English](README.md) | [简体中文](README_zh.md)

</div>

---

## Overview

**md2wechat** converts static blog posts written in Markdown + YAML frontmatter (built initially for [SrP-BloG](https://github.com/RolinShmily/SrP-BloG), and configurable for Hugo, Hexo, Astro, etc.) into WeChat-compatible rich HTML with inline styles and synchronizes them to the **WeChat Official Account Draft Box** (`cgi-bin/draft/*`) for final human review and publication.

- **Non-Intrusive by Design**: Never modifies or pollutes the source blog repository. All sync states, SHA-256 asset caches, and configurations live outside the blog repository.
- **Default Remote Pull (Zero-Setup on VPS)**: Automatically pulls and syncs directly from the remote Git blog repository (`https://github.com/RolinShmily/SrP-BloG.git` by default, customizable in `config.yaml`). On first run it clones automatically into `.cache/blog-repo`, and on subsequent runs it fetches latest commits via `git pull --ff-only`. You do not need to manually clone or manage the blog repository on your VPS!
- **28 Built-in WeChat Themes**: Powered by the vendored [laogou717/md-wechat](https://github.com/laogou717/md-wechat) rendering engine, outputting WeChat-safe `<section>` list structures and line-by-line `<code style="display:block">` blocks that survive WeChat's editor sanitizer.
- **Smart Sync Policy**:
  - **Routine Auto-Sync (`sync`)**: Pushes **brand-new articles only** by default—routine edits or typo fixes on historical blog posts are detected by `check` but will not clutter your WeChat Draft Box automatically.
  - **Selective & Interactive Push (`push`)**: Push any single article, multiple articles in batch, or launch an interactive terminal selector to pick specific new/updated/historical posts to push on demand.

---

## Key Features

- **AST-Aware Markdown Preprocessing**:
  - Protects fenced code blocks (`fence` / `code_block`) and inline code spans (`` `...` ``) from unintended transformations using `markdown-it` token line maps.
  - Automatically shifts body headings (`h1–h5` → `h2–h6`) so section headings do not collide with main article title styles.
  - Native syntax highlighting aliases for DevOps & technical blogs (`zsh`, `sh`, `shell`, `pwsh`, `ps1`, `cfg`, `conf`, `cmd`, `nginx`, `toml`, `jsonc`, `plist`) while preserving original language labels in Mac code window headers.
  - Converts GFM task lists (`- [ ]` / `- [x]` → `☐` / `☑`) and GFM footnotes (`[^id]`).
  - Converts multi-line Bilibili / YouTube `<iframe>` embeds into themed video placeholder cards.
  - Cleans generic or auto-generated image `alt` captions (`1`, `alt text`, `屏幕截图...`, `Snipaste...`, filenames) while keeping descriptive captions.
  - Protects inline (`$...$`) and block (`$$...$$`) LaTeX math expressions from Markdown emphasis (`_`/`*`) corruption and emits line-level warnings.
  - Converts external links into numbered end-of-article reference footnotes while keeping `mp.weixin.qq.com` internal links clickable.
- **Automated Image & Cover Pipeline**:
  - Converts `.webp` images to `.png` / `.jpg` via `sharp`, fills white backgrounds when flattening alpha channels to JPEG, and adaptively compresses large screenshots (>1 MB, up to 5+ MB) to `< 900 KB` to comply with WeChat's `media/uploadimg` limit.
  - Downloads and re-uploads external HTTP(S) images (`cdn.jsdelivr.net`, etc.) so they are not stripped by WeChat's sanitizer.
  - Pre-checks raw file SHA-256 against `state.json` before invoking `sharp` or network requests—cached images and covers require zero CPU or network overhead.
  - **3-Tier Cover Fallback**: Uses frontmatter cover (`image`) → falls back to the first local image in the post bundle → falls back to the configured `sync.defaultCover` in `config.yaml`.
- **WeChat Payload Normalization & Self-Healing**:
  - Automatically trims long titles (`> 32` characters) by stripping trailing `| tag` segments from right to left before falling back to ellipsis truncation (`45003` prevention).
  - Truncates summaries exceeding `120` characters (`45004` prevention).
  - **Draft Upsert Self-Healing**: Automatically falls back from `draft/update` to `draft/add` if a previously synced draft was deleted or published in the WeChat backend (`40007`), while halting immediately on non-recoverable errors (`40164` IP whitelist, `48001` unauthorized, `45009` daily quota).
- **Standalone Offline Preview**:
  - `md2wechat preview <slug>` generates a self-contained HTML file with base64-inlined local images, mobile viewport framing, and a **One-Click Copy Rich Text** button for manual pasting into the WeChat backend.

---

## Architecture & Monorepo Layout

```text
md2wechat/
├── wechat-sdk/                    # @md2wechat/wechat-sdk: Zero-dependency WeChat Official Account API SDK
├── renderer/                      # @md2wechat/renderer: Vendored md-wechat engine + AST-aware preprocessor
├── sources/                       # @md2wechat/sources: Filesystem adapter (bundle & flat layouts) + composite SHA-256
├── sync-core/                     # @md2wechat/sync-core: Image processor (sharp), lockfile state store, pipeline & webhook notifier
├── cli/                           # @md2wechat/cli: CLI entry point
├── systemd/                       # systemd service, timer & one-step installer script
└── config.example.yaml            # Full configuration template
```

---

## Quick Start

### 1. Install, Build & Test

Requires **Node.js >= 22** and **pnpm >= 10**.

```bash
pnpm install --ignore-scripts
pnpm build
pnpm test
```

### 2. Configure

Copy `config.example.yaml` to `config.yaml` and adjust paths if needed. Pass WeChat credentials via environment variables (never commit secrets):

```bash
export WECHAT_APPID="wx_your_appid"
export WECHAT_SECRET="your_appsecret"
```

### 3. Run Account & IP Whitelist Diagnostics

Verify credentials, server egress IP whitelist status, and Draft Box API permissions (`draft/count`):

```bash
node cli/dist/index.js diagnose
```

> If your server IP is not yet whitelisted, `diagnose` extracts and prints the exact egress IP reported by WeChat (`40164`) so you can add it in the WeChat Official Account console under **Development -> Basic Configuration -> IP Whitelist**.

---

## CLI Commands

```bash
# 1. List all 28 built-in WeChat typography themes
node cli/dist/index.js themes

# 2. Offline status check (zero WeChat API calls)
# Reports brand-new posts (queued for auto-sync) and modified historical posts (manual push)
node cli/dist/index.js check

# 3. Generate standalone local HTML preview with "One-Click Copy Rich Text" button
node cli/dist/index.js preview 45-immortalwrt-1
node cli/dist/index.js preview 45-immortalwrt-1 -t fullstack-blue -o ./preview.html

# 4. Mark existing published posts as baselined (skip historical posts on routine auto-sync)
node cli/dist/index.js baseline                              # Baseline all existing published posts
node cli/dist/index.js baseline 45-immortalwrt-1 53-qt6-1    # Baseline specific posts only
node cli/dist/index.js baseline --except 61-cf-tunnel-vps    # Baseline all except specified post(s)
node cli/dist/index.js baseline --remote                     # Baseline & pull existing WeChat Draft Box media_ids into state.json

# 5. Interactive or targeted push to WeChat Draft Box
node cli/dist/index.js push                         # Interactive numbered picker
node cli/dist/index.js push --filter openwrt        # Interactive picker filtered by keyword
node cli/dist/index.js push 61-cf-tunnel-vps        # Push a single post
node cli/dist/index.js push 60-aria2-1 61-cf-tunnel-vps  # Push multiple posts in batch
node cli/dist/index.js push 45-immortalwrt-1 --dry-run   # Dry-run without calling WeChat write APIs

# 6. Automated incremental sync (pushes brand-new posts only by default, up to maxPerRun)
node cli/dist/index.js sync
node cli/dist/index.js sync --include-updated       # Also sync modified historical posts
```

### Interactive Selection Syntax (`md2wechat push`)

When running `push` without arguments (or with `-i` / `--select`), you can select articles using:
- **Numbers / Lists**: `1` or `1,3,5`
- **Ranges**: `1-4`
- **Shortcuts**: `new` (all new articles) or `updated` (all modified historical articles)
- **Slugs**: `45-immortalwrt-1`
- **Quit**: `q`

---

## VPS Automated Deployment (`systemd`)

To run `md2wechat` unattended on a Linux VPS with a static whitelisted IP (polling every 10 minutes with zero inbound ports):

```bash
# 1. Build and baseline historical posts
pnpm install --ignore-scripts && pnpm build
# Set source.gitPull: true in config.yaml so each run pulls the latest blog commits
node cli/dist/index.js baseline

# 2. Install and enable the systemd service & timer
bash systemd/install-systemd.sh

# 3. Add your WeChat credentials (permissions: 0600)
sudo nano /etc/md2wechat/wechat.env

# 4. Trigger a test run and inspect logs
sudo systemctl start md2wechat-sync.service
journalctl -u md2wechat-sync.service -n 50 -f
```

Concurrency is guarded at two levels: Linux `flock` in the systemd unit and a PID-checked `.lock` file inside `StateStore.withLock()`.

---

## Credits & License

- Rendering engine (`renderer/vendor/`) adapted from [laogou717/md-wechat](https://github.com/laogou717/md-wechat) under the MIT License.
- Licensed under the MIT License.
