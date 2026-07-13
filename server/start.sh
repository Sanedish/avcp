#!/usr/bin/env sh
# =============================================================================
# AVCP relay - quick launcher for Linux / macOS (foreground, current user).
#
#   sh start.sh         relay reachable from THIS machine only (127.0.0.1)
#   sh start.sh lan     also reachable from other devices on your network
#                       (phone on the same Wi-Fi - plain http, no cloud)
#
# Overridable via env: PORT (8977). For a public, TLS-terminated production
# relay use run.sh + Cloudflare Tunnel instead - see README.md.
# =============================================================================
set -eu
cd "$(dirname "$0")"

command -v node >/dev/null 2>&1 || {
  echo "Node.js >= 18 is required - install it from https://nodejs.org or your package manager"; exit 1; }
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 18 ] || { echo "Node $(node -v) is too old - need >= 18"; exit 1; }

[ -d node_modules ] || { echo "installing dependencies..."; npm install --omit=dev --no-audit --no-fund; }

PORT="${PORT:-8977}"
if [ "${1:-}" = "lan" ]; then BIND="0.0.0.0"; else BIND="127.0.0.1"; fi

echo
echo "AVCP relay starting on $BIND:$PORT  (Ctrl+C stops it)"
echo "  panel host side : Settings -> Remote Access -> Relay server = ws://127.0.0.1:$PORT"
if [ "$BIND" = "0.0.0.0" ]; then
  ip=$(hostname -I 2>/dev/null | awk '{print $1}') || ip=""
  [ -n "${ip:-}" ] || ip="<this-machine's-IP>"
  echo "  phone / client  : http://$ip:$PORT/?remote=1"
  echo "  (?remote=1 marks the device as the remote one - needed on plain http)"
else
  echo "  local client    : http://127.0.0.1:$PORT/?remote=1"
  echo "  (loopback only - re-run as 'sh start.sh lan' to allow other devices)"
fi
echo

PORT="$PORT" BIND="$BIND" exec node relay.js
