#!/usr/bin/env bash
set -euo pipefail

# 自动检测当前项目根目录、执行环境与系统依赖，安装并启用 systemd 定时任务
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
NODE_BIN="$(command -v node || true)"
FLOCK_BIN="$(command -v flock || echo /usr/bin/flock)"
RUN_USER="${SUDO_USER:-$(whoami)}"
USER_HOME="$(eval echo "~${RUN_USER}")"
USER_GROUP="$(id -gn "${RUN_USER}")"

if [[ -z "${NODE_BIN}" ]]; then
  echo "错误: 未找到 node 可执行文件，请先安装 Node.js >= 20" >&2
  exit 1
fi

NODE_DIR="$(dirname "${NODE_BIN}")"

echo "==> 项目根目录:   ${REPO_DIR}"
echo "==> Node.js 路径: ${NODE_BIN}"
echo "==> 运行用户:     ${RUN_USER} (Home: ${USER_HOME})"

# 1. 检查并确保配置文件就绪
if [[ ! -f "${REPO_DIR}/config.yaml" ]]; then
  if [[ -f "${REPO_DIR}/config.example.yaml" ]]; then
    echo "==> 未检测到 config.yaml，自动从 config.example.yaml 创建..."
    cp "${REPO_DIR}/config.example.yaml" "${REPO_DIR}/config.yaml"
    echo "    👉 请记得编辑 ${REPO_DIR}/config.yaml 填入您的博客仓库与平台设置"
  else
    echo "错误: 未找到 config.yaml 或 config.example.yaml" >&2
    exit 1
  fi
fi

# 2. 检查编译产物
if [[ ! -f "${REPO_DIR}/packages/cli/dist/index.js" ]]; then
  echo "==> 检测到项目尚未编译，正在执行 pnpm build ..."
  (cd "${REPO_DIR}" && pnpm build)
fi

# 3. 准备系统级可选凭据目录
sudo mkdir -p /etc/md2posts
if [[ ! -f /etc/md2posts/md2posts.env ]]; then
  sudo cp "${SCRIPT_DIR}/md2posts.env.example" /etc/md2posts/md2posts.env
  sudo chmod 600 /etc/md2posts/md2posts.env
  echo "==> 已创建 /etc/md2posts/md2posts.env (权限 600，可选环境变量覆盖)"
fi

# 4. 生成 systemd service 单元
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
Environment="PATH=${USER_HOME}/.local/bin:${USER_HOME}/.cargo/bin:${NODE_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
EnvironmentFile=-/etc/md2posts/md2posts.env
EnvironmentFile=-${REPO_DIR}/.env
ExecStart=${FLOCK_BIN} -n /tmp/md2posts.lock ${NODE_BIN} ${REPO_DIR}/packages/cli/dist/index.js sync -c ${REPO_DIR}/config.yaml
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
echo "  - 读取配置:     ${REPO_DIR}/config.yaml"
echo "  - 查看定时器状态: systemctl status md2posts-sync.timer"
echo "  - 手动触发一次:   sudo systemctl start md2posts-sync.service"
echo "  - 查看运行日志:   journalctl -u md2posts-sync.service -f"
echo "============================================================"
