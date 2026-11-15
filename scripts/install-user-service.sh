#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v systemctl >/dev/null 2>&1; then
  echo "当前系统没有 systemctl；请使用图形界面的登录自启开关。" >&2
  exit 1
fi

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_FILE="$UNIT_DIR/provider-router.service"
mkdir -p "$UNIT_DIR"

systemd_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

RUNNER_QUOTED="$(systemd_quote "$APP_DIR/scripts/run-gateway.sh")"
CONFIG_PATH="${PROVIDER_ROUTER_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/provider-router/config.json}"
CONFIG_QUOTED="$(systemd_quote "$CONFIG_PATH")"

# systemd 不解析 WorkingDirectory 的引号，路径含空格会装出一个无法启动的单元。
if [[ "$APP_DIR" =~ [[:space:]] ]]; then
  echo "项目路径包含空格，systemd 的 WorkingDirectory 无法引用：$APP_DIR" >&2
  echo "请把项目移动到不含空格的路径后重试。" >&2
  exit 1
fi

cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Provider Router local model gateway
Documentation=file://$APP_DIR/README.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=$RUNNER_QUOTED --config $CONFIG_QUOTED
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable provider-router.service
systemctl --user restart provider-router.service

cat <<EOF

已安装并启动用户服务：
  $UNIT_FILE

查看状态： systemctl --user status provider-router.service --no-pager
查看日志： journalctl --user -u provider-router.service -f

如果希望无需登录桌面、开机即启动，请再执行：
  sudo loginctl enable-linger "$USER"

注意：autostart 开关（XDG 桌面自启动）与这个 systemd 用户服务二选一即可。
EOF
