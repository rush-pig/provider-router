#!/usr/bin/env bash
# 启动入口：每次启动时解析当前可用的 node，避免 systemd 单元写死 nvm 版本路径。
set -euo pipefail

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

resolve_node() {
  if [[ -n "${PROVIDER_ROUTER_NODE:-}" ]]; then
    printf '%s\n' "$PROVIDER_ROUTER_NODE"
    return 0
  fi

  if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    # nvm.sh 内部会引用未定义变量，临时关掉 nounset。
    set +u
    # shellcheck disable=SC1090,SC1091
    . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
    nvm use --silent default >/dev/null 2>&1 || true
    set -u
  fi

  command -v node 2>/dev/null || true
}

NODE_BIN="$(resolve_node)"
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "未找到可用的 node；请确认 nvm 的 default 别名有效，或设置 PROVIDER_ROUTER_NODE。" >&2
  exit 1
fi

exec "$NODE_BIN" "$APP_DIR/src/server.mjs" --no-open "$@"
