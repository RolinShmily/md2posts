#!/usr/bin/env bash
set -euo pipefail

# 停止并卸载 md2posts systemd 定时任务与服务
PURGE=false
for arg in "$@"; do
  if [[ "$arg" == "--purge" ]]; then
    PURGE=true
  fi
done

echo "==> 正在停止并禁用 systemd 定时器与服务..."
sudo systemctl stop md2posts-sync.timer md2posts-sync.service md2wechat-sync.timer md2wechat-sync.service 2>/dev/null || true
sudo systemctl disable md2posts-sync.timer md2posts-sync.service md2wechat-sync.timer md2wechat-sync.service 2>/dev/null || true

echo "==> 正在清理 systemd 单元文件..."
sudo rm -f /etc/systemd/system/md2posts-sync.service
sudo rm -f /etc/systemd/system/md2posts-sync.timer
sudo rm -f /etc/systemd/system/md2wechat-sync.service
sudo rm -f /etc/systemd/system/md2wechat-sync.timer

sudo systemctl daemon-reload
sudo systemctl reset-failed 2>/dev/null || true

sudo rm -f /tmp/md2posts.lock /tmp/md2wechat.lock

if [[ "$PURGE" == "true" ]]; then
  echo "==> 正在清理历史遗留的凭据/环境变量目录 (--purge) ..."
  # 旧版本安装脚本会创建这些目录；当前版本凭据只保存在 config.yaml。
  sudo rm -rf /etc/md2posts /etc/md2wechat
  echo "✓ 历史遗留目录已清除。"
else
  if [[ -d /etc/md2posts || -d /etc/md2wechat ]]; then
    echo "ℹ️  检测到旧版本创建的 /etc/md2posts 或 /etc/md2wechat（当前版本已不再使用）。"
    echo "    如需清除，请运行: bash systemd/uninstall-systemd.sh --purge"
  fi
fi

echo ""
echo "✓ md2posts systemd 定时后台服务已成功卸载！"
