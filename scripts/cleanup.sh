#!/bin/bash
# SessionEnd hook — kill managed processes and clean up PID files.
set -euo pipefail

source "${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}/scripts/_resolve-data-dir.sh"

# ── Helper: kill process from PID file ──────────────────────────────
kill_from_pidfile() {
  local pidfile="$1"
  local label="$2"

  if [ ! -f "$pidfile" ]; then
    return
  fi

  local pid
  pid=$(cat "$pidfile" 2>/dev/null || echo "")
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    echo "[PIPELINE] Stopped $label (PID $pid)."
  fi
  rm -f "$pidfile"
}

# ── Kill managed processes ──────────────────────────────────────────
kill_from_pidfile "$DATA_DIR/tunnel.pid" "tunnel"
kill_from_pidfile "$DATA_DIR/server.pid" "server"
kill_from_pidfile "$DATA_DIR/poller.pid" "trigger poller"

# ── Clean any other stale PID files ─────────────────────────────────
for pidfile in "$DATA_DIR"/*.pid; do
  [ -f "$pidfile" ] || continue
  pid=$(cat "$pidfile" 2>/dev/null || echo "")
  if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$pidfile"
  fi
done

echo "[PIPELINE] Pipeline shutdown complete."
