#!/usr/bin/env bash
set -euo pipefail

# 自动检测当前项目根目录与 node/flock 路径，安装并启用 systemd 定时任务
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
NODE_BIN="$(command -v node || true)"
FLOCK_BIN="$(command -v flock || echo /usr/bin/flock)"
RUN_USER="${SUDO_USER:-$(whoami)}"

if [[ -z "${NODE_BIN}" ]]; then
  echo "错误: 未找到 node 可执行文件，请先安装 Node.js >= 20" >&2
  exit 1
fi

NODE_DIR="$(dirname "${NODE_BIN}")"

echo "==> 项目目录: ${REPO_DIR}"
echo "==> Node 路径: ${NODE_BIN}"
echo "==> 运行用户: ${RUN_USER}"

sudo mkdir -p /etc/md2wechat
if [[ ! -f /etc/md2wechat/wechat.env ]]; then
  sudo cp "${SCRIPT_DIR}/wechat.env.example" /etc/md2wechat/wechat.env
  sudo chmod 600 /etc/md2wechat/wechat.env
  echo "==> 已创建 /etc/md2wechat/wechat.env (权限 600)，请填入真实的 WECHAT_APPID 与 WECHAT_SECRET"
fi

sudo tee /etc/systemd/system/md2wechat-sync.service >/dev/null <<EOF
[Unit]
Description=md2wechat sync service (Markdown to WeChat Draft Box)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=${RUN_USER}
WorkingDirectory=${REPO_DIR}
Environment="PATH=${NODE_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
EnvironmentFile=-/etc/md2wechat/wechat.env
ExecStart=${FLOCK_BIN} -n /tmp/md2wechat.lock ${NODE_BIN} ${REPO_DIR}/cli/dist/index.js sync -c ${REPO_DIR}/config.yaml
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

sudo cp "${SCRIPT_DIR}/md2wechat-sync.timer" /etc/systemd/system/md2wechat-sync.timer

sudo systemctl daemon-reload
sudo systemctl enable --now md2wechat-sync.timer

echo ""
echo "✓ systemd 定时服务已安装并启动！"
echo "  - 查看定时器状态: systemctl status md2wechat-sync.timer"
echo "  - 手动触发一次:   sudo systemctl start md2wechat-sync.service"
echo "  - 查看运行日志:   journalctl -u md2wechat-sync.service -f"
