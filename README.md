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
| **XiaoHeiHe** (`heybox`) | **Hybrid code rendering** (short commands become copy-friendly native terminal blocks, long source files become dark PNG cards), tables as cards, cover at body top, **external links reduced to plain text**, direct draft publishing | Solves mobile code truncation, unreadable screenshots, duplicated images, and "off-site traffic" policy violations |

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

**Where credentials live**: credentials belong in `config.yaml` (already `.gitignore`d, never committed).
Environment variables `WECHAT_APPID` / `WECHAT_SECRET` are only a fallback when the corresponding
field is empty — **the config file always wins**, and the installer never generates an env file.

```bash
# XiaoHeiHe: scan once on a machine with a display; the session is stored at
# heybox.sessionFile (default: .cache/heybox-session.json)
pnpm cli login --to heybox
```

---

## Common CLI Commands

There is no global command: the single entry point is `pnpm cli <command>` run from the repository
root (after `pnpm install && pnpm build`). The systemd timer invokes the same CLI code via an absolute
node path, so it never depends on PATH.

```bash
# 1. Offline status check (reports new posts vs modified posts with zero external API calls)
pnpm cli check

# 2. Local offline preview (double click preview.html to copy rich text with one click)
pnpm cli preview my-post --to wechat      # WeChat mobile viewport preview
pnpm cli preview my-post --to heybox      # XiaoHeiHe bundle preview (code / tables / cover)

# 3. Targeted or batch push (exits with code 1 when any post fails)
pnpm cli push my-post --to wechat         # Push a single post to WeChat Draft Box
pnpm cli push my-post --to heybox         # Push a single post to XiaoHeiHe Draft Box
pnpm cli push my-post --to all            # Single command push to both platforms
pnpm cli push -i --dry-run                # Interactive terminal picker simulation

# 4. Routine incremental auto-sync (syncs brand-new posts only by default)
pnpm cli sync --to all                    # Push new posts to all platforms
pnpm cli sync --dry-run                   # Rehearse the whole flow without writes

# 5. Sync baseline ("which posts have already been pushed?")
pnpm cli baseline                         # Mark every published post as already pushed
pnpm cli baseline --status                # Show baseline file, count and creation time (read-only)
pnpm cli baseline --import state.json     # Adopt another machine's baseline (merge, never overwrite)
```

### What is the sync baseline, and where does it live

The baseline is `sync.stateFile` (default `./state.json`, resolved relative to `config.yaml`). It stores
each post's `contentHash`, platform draft IDs and image cache — that is how md2posts knows
**which posts have already been pushed**.

- It is **machine-local** and never travels with the Git repo. On a freshly cloned VPS it is empty, so
  every post looks "new".
- To prevent accidental mass pushes, **`sync` aborts when the baseline is empty but pending posts exist**:

  ```
  [Baseline] No baseline on this machine, yet 61 posts look pending — aborted to avoid duplicate pushes.
  1) Already published elsewhere: build the baseline first (`pnpm cli baseline`) or copy state.json over;
  2) Genuinely a first push: add `--initial-push` to confirm;
  3) Just want to see what would happen: `pnpm cli check`.
  ```
- Multi-machine setups: `baseline --import` merges another machine's `state.json` so both share the
  same notion of "already pushed". Import never overwrites local records.

---

## Headless Linux VPS Deployment

### 1. Handling XiaoHeiHe Login on a Headless VPS

Servers usually have no graphical desktop. The easiest path is to **bring both the session and the baseline along**:

```bash
# Step 1: scan once on a machine with a display (session lands at heybox.sessionFile,
#         default .cache/heybox-session.json)
pnpm cli login --to heybox

# Step 2: copy the session and the baseline into the same repo layout on the VPS
scp ~/Projects/md2posts/.cache/heybox-session.json user@vps:~/md2posts/.cache/heybox-session.json
scp ~/Projects/md2posts/state.json                user@vps:~/md2posts/state.json

# Step 3: verify on the VPS
cd ~/md2posts
pnpm cli baseline --status        # should report the imported post count
```

> No baseline to copy? Run `pnpm cli baseline` on the VPS itself — it marks every published post as
> already pushed without touching any platform API, so `sync` will not re-push history.

### 1.5 Where credentials live

- WeChat AppID/AppSecret and the XiaoHeiHe `sessionFile` live in `config.yaml`, and **the config file
  takes precedence**; environment variables only apply when that field is empty.
- The installer does **not** create `/etc/md2posts/md2posts.env`. A leftover file from older versions is
  no longer read and can be deleted.

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

The timer logs the resolved baseline and credential preflight results. **The service exits with code 1
whenever any post fails**, so `systemctl status` reports `failed` instead of a silent successful no-op.

---

## Monorepo Layout

```text
md2posts/
├── src/
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
