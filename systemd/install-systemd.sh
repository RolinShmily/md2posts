#!/usr/bin/env bash
set -euo pipefail

# 自动检测当前项目根目录、执行环境与系统依赖，安装并启用 systemd 定时任务
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
NODE_BIN="$(command -v node || true)"
PNPM_BIN="$(command -v pnpm || true)"
FLOCK_BIN="$(command -v flock || echo /usr/bin/flock)"
RUN_USER="${SUDO_USER:-$(whoami)}"
USER_HOME="$(eval echo "~${RUN_USER}")"
USER_GROUP="$(id -gn "${RUN_USER}")"

if [[ -z "${NODE_BIN}" ]]; then
  echo "错误: 未找到 node 可执行文件，请先安装 Node.js >= 20" >&2
  exit 1
fi

# Node.js 版本下限（本项目要求 >= 20）
NODE_MAJOR="$("${NODE_BIN}" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [[ "${NODE_MAJOR}" -lt 20 ]]; then
  echo "错误: Node.js 版本过低 (当前 $( "${NODE_BIN}" -v 2>/dev/null || echo unknown ))，本项目要求 >= 20" >&2
  exit 1
fi

# pnpm 是唯一用户入口（pnpm cli），构建与依赖安装都依赖它
if [[ -z "${PNPM_BIN}" ]]; then
  echo "错误: 未找到 pnpm。本项目的唯一入口是 'pnpm cli <command>'，构建也依赖 pnpm。" >&2
  echo "      安装方式任选其一:" >&2
  echo "        corepack enable && corepack prepare pnpm@latest --activate" >&2
  echo "        npm install -g pnpm" >&2
  exit 1
fi

PNPM_DIR="$(dirname "${PNPM_BIN}")"
NODE_DIR="$(dirname "${NODE_BIN}")"

echo "==> 项目根目录:   ${REPO_DIR}"
echo "==> Node.js 路径: ${NODE_BIN} ($( "${NODE_BIN}" -v 2>/dev/null || echo unknown ))"
echo "==> pnpm 路径:    ${PNPM_BIN}"
echo "==> 运行用户:     ${RUN_USER} (Home: ${USER_HOME})"

# 1. 检查并确保配置文件就绪
if [[ ! -f "${REPO_DIR}/config.yaml" ]]; then
  if [[ -f "${REPO_DIR}/config.yaml.example" ]]; then
    echo "==> 未检测到 config.yaml，自动从 config.yaml.example 创建..."
    cp "${REPO_DIR}/config.yaml.example" "${REPO_DIR}/config.yaml"
    echo "    👉 请记得编辑 ${REPO_DIR}/config.yaml 填入您的博客仓库与平台设置"
  elif [[ -f "${REPO_DIR}/config.example.yaml" ]]; then
    echo "==> 未检测到 config.yaml，自动从 config.example.yaml 创建..."
    cp "${REPO_DIR}/config.example.yaml" "${REPO_DIR}/config.yaml"
    echo "    👉 请记得编辑 ${REPO_DIR}/config.yaml 填入您的博客仓库与平台设置"
  else
    echo "错误: 未找到 config.yaml 或 config.yaml.example" >&2
    exit 1
  fi
fi

# 2. 依赖与编译产物
if [[ ! -d "${REPO_DIR}/node_modules" ]]; then
  echo "==> 未检测到 node_modules，正在执行 pnpm install ..."
  (cd "${REPO_DIR}" && "${PNPM_BIN}" install)
fi

if [[ ! -f "${REPO_DIR}/src/cli/dist/index.js" ]]; then
  echo "==> 检测到项目尚未编译，正在执行 pnpm build ..."
  (cd "${REPO_DIR}" && "${PNPM_BIN}" build)
fi

# 3. 提示：旧版本曾生成 /etc/md2posts/md2posts.env 并在其中写入占位凭据，
#    当前版本完全不再读取该文件（凭据只认 config.yaml）。
if [[ -f /etc/md2posts/md2posts.env ]] && grep -qE '^[[:space:]]*WECHAT_(APPID|SECRET)=' /etc/md2posts/md2posts.env 2>/dev/null; then
  echo "⚠️  检测到旧版 /etc/md2posts/md2posts.env 内含微信凭据配置。"
  echo "    当前版本已不再读取它（config.yaml 优先），可以直接删除："
  echo "      sudo rm -f /etc/md2posts/md2posts.env"
fi

# 4. 生成 systemd service 单元
#    凭据只来自 config.yaml（可选仓库内 .env 由程序自行读取），不再创建系统级 env 文件：
#    安装脚本生成的占位值曾静默覆盖真实配置，导致难以排查的 40013。
sudo tee /etc/systemd/system/md2posts-sync.service >/dev/null <<EOF
[Unit]
Description=md2posts sync service (Markdown to Multi-Platform Posts)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=${RUN_USER}
Group=${USER_GROUP}
WorkingDirectory=${REPO_DIR}
Environment="HOME=${USER_HOME}"
Environment="NODE_ENV=production"
Environment="LANG=C.UTF-8"
Environment="LC_ALL=C.UTF-8"
Environment="PATH=${USER_HOME}/.local/bin:${USER_HOME}/.cargo/bin:${NODE_DIR}:${PNPM_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ExecStart=${FLOCK_BIN} -n /tmp/md2posts.lock ${NODE_BIN} ${REPO_DIR}/src/cli/dist/index.js sync -c ${REPO_DIR}/config.yaml
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# 5. 安装 timer 单元并启动
sudo cp "${SCRIPT_DIR}/md2posts-sync.timer" /etc/systemd/system/md2posts-sync.timer

sudo systemctl daemon-reload
sudo systemctl enable --now md2posts-sync.timer

echo ""
echo "============================================================"
echo "✓ md2posts systemd 定时同步服务已安装并启动！"
echo "  - 读取配置:     ${REPO_DIR}/config.yaml（凭据也在此文件内）"
echo "  - 查看定时器状态: systemctl status md2posts-sync.timer"
echo "  - 手动触发一次:   sudo systemctl start md2posts-sync.service"
echo "  - 手动执行命令:   cd ${REPO_DIR} && pnpm cli <command>"
echo "  - 查看运行日志:   journalctl -u md2posts-sync.service -f"
echo "============================================================"
