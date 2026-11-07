#!/usr/bin/env bash
set -euo pipefail

# 停止并卸载 md2wechat systemd 定时任务与服务
PURGE=false
for arg in "$@"; do
  if [[ "$arg" == "--purge" ]]; then
    PURGE=true
  fi
done

echo "==> 正在停止并禁用 systemd 定时器与服务..."
sudo systemctl stop md2wechat-sync.timer md2wechat-sync.service 2>/dev/null || true
sudo systemctl disable md2wechat-sync.timer md2wechat-sync.service 2>/dev/null || true

echo "==> 正在清理 systemd 单元文件..."
sudo rm -f /etc/systemd/system/md2wechat-sync.service
sudo rm -f /etc/systemd/system/md2wechat-sync.timer

sudo systemctl daemon-reload
sudo systemctl reset-failed 2>/dev/null || true

sudo rm -f /tmp/md2wechat.lock

if [[ "$PURGE" == "true" ]]; then
  echo "==> 正在彻底清除凭据目录 /etc/md2wechat (--purge) ..."
  sudo rm -rf /etc/md2wechat
  echo "✓ 凭据目录 /etc/md2wechat 已被删除。"
else
  if [[ -d /etc/md2wechat ]]; then
    echo "ℹ️  已保留凭据文件 /etc/md2wechat/wechat.env（如需彻底删除，请运行: bash systemd/uninstall-systemd.sh --purge）"
  fi
fi

echo ""
echo "✓ md2wechat systemd 定时后台服务已成功卸载！"
