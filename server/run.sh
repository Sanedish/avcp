#!/usr/bin/env bash
# =============================================================================
# AVCP relay - one-shot setup / repair script
#
# Creates the service user, installs the panel to $DEST, runs `npm install`,
# renders the systemd unit with the correct node path, and (re)starts the
# relay. Safe to re-run: every step is idempotent. This is exactly what fixes
# the `status=217/USER` crash loop (that means the `User=` in the unit doesn't
# exist yet - this script creates it).
#
# Usage (as root):
#   sudo bash server/run.sh                 # installs from the repo this lives in
#   sudo AVCP_REPO=<git-url> bash run.sh    # or clone fresh if run outside a repo
#
# Overridable via env: APP_USER (avcp), DEST (/opt/avcp).
#
# It does NOT set up cloudflared (that needs an interactive browser login) -
# the final message prints those steps. See server/README.md.
# =============================================================================
set -euo pipefail

APP_USER="${APP_USER:-avcp}"
DEST="${DEST:-/opt/avcp}"
PORT="${PORT:-8977}"
SERVICE_NAME="avcp-relay"
UNIT="/etc/systemd/system/${SERVICE_NAME}.service"

say() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root:  sudo bash $0"

# --- locate the source tree (repo root = parent of this script's dir) --------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$(cd "$SCRIPT_DIR/.." && pwd)"
CLONED_TMP=""
if [ ! -f "$SRC/index.html" ] || [ ! -f "$SRC/server/relay.js" ]; then
  if [ -n "${AVCP_REPO:-}" ]; then
    command -v git >/dev/null 2>&1 || die "git not installed (needed to clone AVCP_REPO)"
    CLONED_TMP="$(mktemp -d)"
    say "cloning $AVCP_REPO"
    git clone --depth 1 "$AVCP_REPO" "$CLONED_TMP/repo"
    SRC="$CLONED_TMP/repo"
  else
    die "can't find the panel next to run.sh, and AVCP_REPO is not set.
    Either run this from inside the cloned repo (server/run.sh), or set
    AVCP_REPO=<git-url> so it can clone."
  fi
fi
[ -f "$SRC/index.html" ] || die "source at $SRC has no index.html - not a panel checkout"

# --- Node.js >= 18 -----------------------------------------------------------
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  say "Node.js not found - installing nodejs + npm via apt"
  apt-get update -y && apt-get install -y nodejs npm
  NODE_BIN="$(command -v node || true)"
fi
[ -n "$NODE_BIN" ] || die "Node.js not found. Install Node >= 18 (https://nodejs.org or nodesource) and re-run."
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node $("$NODE_BIN" -v) is too old - need >= 18. Install a newer Node and re-run."
NPM_BIN="$(command -v npm || true)"
[ -n "$NPM_BIN" ] || die "npm not found (install it alongside Node) and re-run."
say "using node $("$NODE_BIN" -v) at $NODE_BIN"

# --- stop any crash-looping instance before we touch its files ---------------
systemctl stop "$SERVICE_NAME" 2>/dev/null || true
systemctl reset-failed "$SERVICE_NAME" 2>/dev/null || true

# --- service user ------------------------------------------------------------
if id -u "$APP_USER" >/dev/null 2>&1; then
  say "user '$APP_USER' already exists"
else
  say "creating service user '$APP_USER' (home $DEST)"
  useradd --system --home-dir "$DEST" --shell /usr/sbin/nologin "$APP_USER"
fi

# --- install the panel to $DEST ----------------------------------------------
mkdir -p "$DEST"
if [ "$(readlink -f "$SRC")" = "$(readlink -f "$DEST")" ]; then
  say "source is already $DEST - skipping copy"
else
  say "installing panel files to $DEST"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --exclude '.git' --exclude 'node_modules' "$SRC"/ "$DEST"/
  else
    cp -a "$SRC"/. "$DEST"/
    rm -rf "$DEST/.git"
  fi
fi

# --- dependencies ------------------------------------------------------------
say "installing relay dependencies (npm)"
( cd "$DEST/server" && "$NPM_BIN" install --omit=dev --no-audit --no-fund )

chown -R "$APP_USER":"$APP_USER" "$DEST"

# --- render + install the systemd unit ---------------------------------------
# The shipped example hardcodes /usr/bin/node and /opt/avcp; substitute the
# real node path and this run's user/paths so it works anywhere.
say "writing $UNIT"
sed \
  -e "s#^User=.*#User=${APP_USER}#" \
  -e "s#^WorkingDirectory=.*#WorkingDirectory=${DEST}/server#" \
  -e "s#^ExecStart=.*#ExecStart=${NODE_BIN} relay.js#" \
  -e "s#^Environment=PORT=.*#Environment=PORT=${PORT}#" \
  -e "s#^Environment=PANEL_DIR=.*#Environment=PANEL_DIR=${DEST}#" \
  -e "s#^ReadOnlyPaths=.*#ReadOnlyPaths=${DEST}#" \
  "$DEST/server/avcp-relay.service.example" > "$UNIT"

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"

# --- verify ------------------------------------------------------------------
sleep 1
if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
  say "relay is up and healthy on 127.0.0.1:${PORT}  ✓"
else
  printf '\n\033[1;33m!\033[0m relay did not answer /healthz yet. Check:  journalctl -u %s -e\n' "$SERVICE_NAME"
fi

[ -n "$CLONED_TMP" ] && rm -rf "$CLONED_TMP"

cat <<EOF

Relay service is installed and running. Manage it with:
  systemctl status ${SERVICE_NAME}
  journalctl -u ${SERVICE_NAME} -f

NEXT: expose it publicly via Cloudflare Tunnel (interactive - can't be scripted):
  sudo cloudflared tunnel login
  sudo cloudflared tunnel create avcp-relay
  sudo cloudflared tunnel route dns avcp-relay avcp.malo-interactive.net
  sudo mkdir -p /etc/cloudflared
  sudo cp ${DEST}/server/cloudflared-config.yml.example /etc/cloudflared/config.yml
  sudo nano /etc/cloudflared/config.yml         # fill in <TUNNEL_ID>
  sudo cloudflared service install
  sudo systemctl enable --now cloudflared

Full details: ${DEST}/server/README.md
EOF
