<h1 align="center">md2posts</h1>

<h4 align="center">Automated Markdown static blog multi-platform formatter & sync tool (WeChat Draft Box + XiaoHeiHe / HeyBox)</h4>

<div align="center">

[![stars](https://img.shields.io/github/stars/RolinShmily/md2posts.svg?style=flat&color=green)](https://github.com/RolinShmily/md2posts)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=flat&logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![pnpm](https://img.shields.io/badge/pnpm-workspace-F69220?style=flat&logo=pnpm&logoColor=white)](https://pnpm.io/)

<br>

[English](README.md) | [简体中文](README_zh.md)

</div>

---

## Overview

**md2posts** converts static blog posts written in Markdown + YAML frontmatter (compatible with Hugo, Hexo, Astro, Next.js, and other static site generators) into platform-optimized rich formats and synchronizes them to:
1. **WeChat Official Account Draft Box** (`cgi-bin/draft/*` with 28 inline styles, WeChat-safe section lists, and line-by-line code blocks)
2. **XiaoHeiHe (HeyBox / 小黑盒)** (with automatic code-block/table-to-image conversion, 16:9 header banners, and game community metadata inference)

- **Multi-Platform Publishing (WeChat + XiaoHeiHe)**:
  - `--to wechat` (default): Synchronizes clean inline HTML to WeChat Official Account Draft Box.
  - `--to heybox`: Automatically converts code blocks and tables into crisp dark-mode PNG image cards (preventing layout breaking on mobile devices), crops 16:9 header banners, infers gaming communities/hashtags (CS2, Switch, Minecraft, Steam, PS5), and exports/pushes drafts to XiaoHeiHe!
  - `--to all`: Synchronizes both platforms in a single run.
- **Non-Intrusive by Design**: Never modifies or pollutes the source blog repository. All sync states, SHA-256 asset caches, and configurations live outside the blog repository.
- **Remote Git Pull with 24-Hour Cooldown**: Automatically pulls and syncs directly from your remote Git blog repository (e.g. `https://github.com/your-username/your-blog.git` in `config.yaml`). On first run it clones into `.cache/blog-repo`, and subsequently performs a daily check with 24-hour pull cooldown to prevent unnecessary Git traffic.
- **28 Built-in WeChat Themes**: Powered by the vendored [laogou717/md-wechat](https://github.com/laogou717/md-wechat) rendering engine, outputting WeChat-safe `<section>` list structures and line-by-line `<code style="display:block">` blocks that survive WeChat's editor sanitizer.
- **Smart Sync Policy**:
  - **Daily Routine Auto-Sync (`sync`)**: Pushes **brand-new articles only** by default—routine edits or typo fixes on historical blog posts are detected by `check` but will not clutter your WeChat Draft Box automatically.
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
  - Downloads and re-uploads external HTTP(S) images so they are not stripped by WeChat's sanitizer.
  - Pre-checks raw file SHA-256 against `state.json` before invoking `sharp` or network requests—cached images and covers require zero CPU or network overhead.
  - **3-Tier Cover Fallback**: Uses frontmatter cover (`image`) → falls back to the first local image in the post bundle → falls back to the configured `sync.defaultCover` or `{repoRoot}/public/og/og.png`.
- **WeChat Payload Normalization & Self-Healing**:
  - Automatically trims long titles (`> 32` characters) by stripping trailing `| tag` segments from right to left before falling back to ellipsis truncation (`45003` prevention).
  - Truncates summaries exceeding `120` characters (`45004` prevention).
  - **Draft Upsert Self-Healing**: Automatically falls back from `draft/update` to `draft/add` if a previously synced draft was deleted or published in the WeChat backend (`40007`), while halting immediately on non-recoverable errors (`40164` IP whitelist, `48001` unauthorized, `45009` daily quota).
- **Standalone Offline Preview**:
  - `md2posts preview <slug>`: Generates a self-contained HTML file with base64-inlined local images, mobile viewport framing, and a **One-Click Copy Rich Text** button for manual pasting into the WeChat backend.
  - `md2posts preview <slug> --to heybox`: Automatically turns code blocks into high-res dark card images (Base64-inlined), crops 16:9 covers, normalizes headings to H2/H3 for XiaoHeiHe ProseMirror, and provides a **One-Click Copy HeyBox Rich Text** button to paste directly (`Ctrl+V`) into the "发布文章" editor.

---

## Directory Layout

```text
md2posts/
├── packages/
│   ├── wechat-sdk/                # @md2posts/wechat-sdk: WeChat Official Account API SDK (diagnose, material, drafts)
│   ├── heybox-sdk/                # @md2posts/heybox-sdk: XiaoHeiHe (HeyBox) SDK, code card generator, 16:9 banner & publisher
│   ├── renderer/                  # @md2posts/renderer: Vendored md-wechat engine + AST-aware preprocessor
│   ├── sources/                   # @md2posts/sources: Filesystem adapter (bundle & flat layouts) + composite SHA-256
│   ├── sync-core/                 # @md2posts/sync-core: Multi-platform sync pipeline, lockfile state store & notifier
│   └── cli/                       # @md2posts/cli: CLI entry point & terminal presentations
├── systemd/                       # systemd daily service, timer & one-step environment installer script
└── config.yaml.example            # Full configuration template
```

---

## Quick Start

### 1. Install, Build & Test

Requires **Node.js >= 20** and **pnpm >= 10**.

```bash
pnpm install
pnpm build
pnpm test
```

### 2. Configure

Copy `config.yaml.example` to `config.yaml` and set your blog repository URL (`repoUrl`) and site URL (`url`). Pass WeChat credentials via environment variables (never commit secrets):

```bash
cp config.yaml.example config.yaml
nano config.yaml

export WECHAT_APPID="wx_your_appid"
export WECHAT_SECRET="your_appsecret"
```

### 3. Run Account & IP Whitelist Diagnostics

Verify credentials, server egress IP whitelist status, and Draft Box API permissions (`draft/count`):

```bash
pnpm cli diagnose
# Or: node packages/cli/dist/index.js diagnose
```

> If your server IP is not yet whitelisted, `diagnose` extracts and prints the exact egress IP reported by WeChat (`40164`) so you can add it in the WeChat Official Account console under **Development -> Basic Configuration -> IP Whitelist**.

---

## CLI Commands

```bash
# 1. List all 28 built-in WeChat typography themes
pnpm cli themes

# 2. Offline status check (zero WeChat API calls)
# Reports brand-new posts (queued for auto-sync) and modified historical posts (manual push)
pnpm cli check

# 3. Generate standalone local preview
pnpm cli preview my-post-slug                               # WeChat HTML preview with one-click copy
pnpm cli preview my-post-slug --to heybox                  # XiaoHeiHe bundle preview (code-to-image + 16:9 cover)

# 4. Mark existing published posts as baselined (skip historical posts on routine auto-sync)
pnpm cli baseline                              # Baseline all existing published posts
pnpm cli baseline post-1 post-2                # Baseline specific posts only
pnpm cli baseline --except new-post-slug       # Baseline all except specified post(s)
pnpm cli baseline --remote                     # Baseline & pull existing WeChat Draft Box media_ids into state.json

# 5. Interactive or targeted push to Draft Box
pnpm cli push                                 # Interactive numbered picker
pnpm cli push --filter tutorial               # Interactive picker filtered by keyword
pnpm cli push my-post-slug                    # Push a single post to WeChat
pnpm cli push my-post-slug --to heybox        # Push a single post to XiaoHeiHe
pnpm cli push my-post-slug --to all           # Push to both WeChat & XiaoHeiHe
pnpm cli push post-1 post-2                   # Push multiple posts in batch
pnpm cli push my-post-slug --dry-run          # Dry-run without calling write APIs

# 6. Automated incremental sync (pushes brand-new posts only by default, up to maxPerRun)
pnpm cli sync                                 # Automatically syncs to target platform(s) configured in config.yaml
pnpm cli sync --to all                        # Force sync to both WeChat & XiaoHeiHe
pnpm cli sync --include-updated               # Also sync modified historical posts
pnpm cli sync --pull                          # Force pull remote repository now (bypass 24h cooldown)
```

### Interactive Selection Syntax (`md2posts push`)

When running `push` without arguments (or with `-i` / `--select`), you can select articles using:
- **Numbers / Lists**: `1` or `1,3,5`
- **Ranges**: `1-4`
- **Shortcuts**: `new` (all new articles) or `updated` (all modified historical articles)
- **Slugs**: `my-post-slug`
- **Quit**: `q`

---

## VPS Automated Daily Deployment (`systemd`)

To run `md2posts` unattended on a Linux VPS with a static whitelisted IP (daily check every 24 hours with zero inbound ports):

```bash
# 1. Build and baseline historical posts
pnpm install && pnpm build
node cli/dist/index.js baseline

# 2. Install and enable the systemd service & 24h daily timer
bash systemd/install-systemd.sh

# 3. Add your credentials and configuration (permissions: 0600)
sudo nano /etc/md2posts/md2posts.env

# 4. Trigger a test run and inspect logs
sudo systemctl start md2posts-sync.service
journalctl -u md2posts-sync.service -n 50 -f

# 5. Uninstall service & timer (optional)
bash systemd/uninstall-systemd.sh          # Stops and removes systemd service/timer (keeps credentials)
bash systemd/uninstall-systemd.sh --purge  # Also removes /etc/md2posts credentials directory
```

Concurrency is guarded at two levels: Linux `flock` in the systemd unit and a PID-checked `.lock` file inside `StateStore.withLock()`.

---

## Credits & License

- WeChat inline styling & rendering core (`renderer/vendor/`) adapted from [laogou717/md-wechat](https://github.com/laogou717/md-wechat) under the MIT License.
- XiaoHeiHe community interaction & posting design inspired by [AaronZ345/xiaoheihe-cli](https://github.com/AaronZ345/xiaoheihe-cli) under the MIT License (special thanks to original authors and maintainers).
- Licensed under the MIT License.
