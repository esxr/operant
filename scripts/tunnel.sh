#!/usr/bin/env bash
# Manage a cloudflared quick-tunnel for the operant webhook server.
# Usage: tunnel.sh start <port>  |  tunnel.sh stop  |  tunnel.sh status

set -euo pipefail

DATA_DIR="${OPERANT_PI_DATA_DIR:-$PWD/spec/.operant}"
PID_FILE="$DATA_DIR/tunnel.pid"
URL_FILE="$DATA_DIR/tunnel_url.txt"

mkdir -p "$DATA_DIR"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

is_running() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

cmd_start() {
  local port="${1:-3456}"

  if is_running; then
    local url
    url=$(cat "$URL_FILE" 2>/dev/null || echo "(unknown)")
    log "Tunnel already running: $url (PID $(cat "$PID_FILE"))"
    exit 0
  fi

  if ! command -v cloudflared &>/dev/null; then
    log "ERROR: cloudflared not found in PATH."
    exit 1
  fi

  log "Starting cloudflared tunnel on port $port ..."

  # Temp file to capture stderr for URL extraction
  local stderr_log
  stderr_log=$(mktemp)

  # Launch cloudflared in the background, redirecting stderr to a temp file
  # and also tee-ing it so we can parse the URL.
  cloudflared tunnel --url "http://localhost:${port}" 2>"$stderr_log" &
  local cf_pid=$!

  # Wait up to 30 seconds for the trycloudflare.com URL to appear
  local elapsed=0
  local url=""
  while [ $elapsed -lt 30 ]; do
    if ! kill -0 "$cf_pid" 2>/dev/null; then
      log "ERROR: cloudflared exited before producing a URL."
      log "stderr output:"
      cat "$stderr_log"
      rm -f "$stderr_log"
      exit 1
    fi

    url=$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$stderr_log" 2>/dev/null | head -1 || true)
    if [ -n "$url" ]; then
      break
    fi

    sleep 1
    elapsed=$((elapsed + 1))
  done

  if [ -z "$url" ]; then
    log "ERROR: Timed out waiting for tunnel URL (30s)."
    log "stderr output:"
    cat "$stderr_log"
    rm -f "$stderr_log"
    kill "$cf_pid" 2>/dev/null || true
    exit 1
  fi

  rm -f "$stderr_log"

  # Persist state
  echo "$cf_pid" > "$PID_FILE"
  echo "$url" > "$URL_FILE"

  log "Tunnel running: $url (PID $cf_pid)"
}

cmd_stop() {
  if [ ! -f "$PID_FILE" ]; then
    log "No tunnel PID file found. Nothing to stop."
    return
  fi

  local pid
  pid=$(cat "$PID_FILE")

  # Try process-group kill first (cloudflared spawns children), then single PID
  if kill -- "-${pid}" 2>/dev/null; then
    log "Sent SIGTERM to process group $pid."
  elif kill "$pid" 2>/dev/null; then
    log "Sent SIGTERM to PID $pid."
  else
    log "Process $pid not found (already exited)."
  fi

  rm -f "$PID_FILE" "$URL_FILE"
  log "Tunnel stopped."
}

cmd_status() {
  if is_running; then
    local pid url
    pid=$(cat "$PID_FILE")
    url=$(cat "$URL_FILE" 2>/dev/null || echo "(unknown)")
    log "Tunnel running: $url (PID $pid)"
  else
    log "Tunnel not running."
    # Clean up stale files
    rm -f "$PID_FILE" "$URL_FILE" 2>/dev/null || true
  fi
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

case "${1:-}" in
  start)  shift; cmd_start "$@" ;;
  stop)   cmd_stop ;;
  status) cmd_status ;;
  *)
    echo "Usage: tunnel.sh {start <port>|stop|status}" >&2
    exit 1
    ;;
esac
