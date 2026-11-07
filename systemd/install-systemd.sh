#!/usr/bin/env bash
set -euo pipefail

# 自动检测当前项目根目录与 node/flock 路径，安装并启用 systemd 定时任务
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
NODE_BIN="$(command -v node || true)"
FLOCK_BIN="$(command -v flock || echo /usr/bin/flock)"
RUN_USER="${SUDO_USER:-$(whoami)}"
USER_HOME="$(eval echo "~${RUN_USER}")"

if [[ -z "${NODE_BIN}" ]]; then
  echo "错误: 未找到 node 可执行文件，请先安装 Node.js >= 20" >&2
  exit 1
fi

NODE_DIR="$(dirname "${NODE_BIN}")"

echo "==> 项目目录: ${REPO_DIR}"
echo "==> Node 路径: ${NODE_BIN}"
echo "==> 运行用户: ${RUN_USER}"

sudo mkdir -p /etc/md2posts
if [[ ! -f /etc/md2posts/md2posts.env ]]; then
  sudo cp "${SCRIPT_DIR}/md2posts.env.example" /etc/md2posts/md2posts.env
  sudo chmod 600 /etc/md2posts/md2posts.env
  echo "==> 已创建 /etc/md2posts/md2posts.env (权限 600)，请填入公众号或相关平台的凭据"
fi

sudo tee /etc/systemd/system/md2posts-sync.service >/dev/null <<EOF
[Unit]
Description=md2posts sync service (Markdown to Multi-Platform Posts)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=${RUN_USER}
WorkingDirectory=${REPO_DIR}
Environment="PATH=${USER_HOME}/.local/bin:${USER_HOME}/.cargo/bin:${NODE_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
EnvironmentFile=-/etc/md2posts/md2posts.env
ExecStart=${FLOCK_BIN} -n /tmp/md2posts.lock ${NODE_BIN} ${REPO_DIR}/cli/dist/index.js sync -c ${REPO_DIR}/config.yaml
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

sudo cp "${SCRIPT_DIR}/md2posts-sync.timer" /etc/systemd/system/md2posts-sync.timer

sudo systemctl daemon-reload
sudo systemctl enable --now md2posts-sync.timer

echo ""
echo "✓ systemd 定时服务已安装并启动！"
echo "  - 查看定时器状态: systemctl status md2posts-sync.timer"
echo "  - 手动触发一次:   sudo systemctl start md2posts-sync.service"
echo "  - 查看运行日志:   journalctl -u md2posts-sync.service -f"
