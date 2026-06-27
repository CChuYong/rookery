#!/usr/bin/env bash
# rookery dev launcher — clean up the existing daemon → build the daemon dist → start the Electron UI (which auto-spawns a new daemon).
# Electron's daemon-manager won't start a new one if it finds a daemon already up on 8787, so kill it first to test the latest code.
set -euo pipefail

# Ensure Node 22 (better-sqlite3 native ABI). Use the current node if it's already >=22;
# otherwise try to activate Node 22 via nvm (no hardcoded paths), then fail clearly.
node_major() { command -v node >/dev/null 2>&1 && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(node_major)" -lt 22 ]; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && nvm use 22 >/dev/null
fi
if [ "$(node_major)" -lt 22 ]; then
  echo "==> Node 22 required (better-sqlite3 ABI), found $(node -v 2>/dev/null || echo none)." >&2
  echo "    Run 'nvm use 22' or put Node 22 on PATH, then re-run." >&2
  exit 1
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

HOST="${ROOKERY_HOST:-127.0.0.1}"
PORT="${ROOKERY_PORT:-8787}"
HOME_DIR="${ROOKERY_HOME:-$HOME/.rookery}"

echo "==> node: $(node -v)  ($(command -v node))"

echo "==> cleaning up the existing daemon"
# 1) pid file
if [ -f "$HOME_DIR/daemon.pid" ]; then
  kill "$(cat "$HOME_DIR/daemon.pid")" 2>/dev/null || true
fi
# 2) daemon process pattern
pkill -f "dist/index.js daemon" 2>/dev/null || true
# 3) process holding the port (in case one lingers)
if lsof -ti "tcp:$PORT" >/dev/null 2>&1; then
  lsof -ti "tcp:$PORT" | xargs kill -9 2>/dev/null || true
fi
sleep 0.5
echo "    port $PORT cleaned up"

echo "==> building the daemon dist (the UI spawns this)"
npm run build

echo "==> starting the Electron UI (ROOKERY_NODE=$(node -p 'process.execPath'))"
echo "    quit: Ctrl-C  (the daemon stays in the background and is cleaned up on the next run)"
export ROOKERY_NODE="$(node -p 'process.execPath')"
exec npm -w apps/desktop run dev
