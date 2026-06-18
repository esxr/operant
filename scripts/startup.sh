#!/bin/bash
# SessionStart hook — bootstrap pipeline data directories, clean stale
# PID files, infer FSM state, and print status for Claude.
set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-.}"

# ── Resolve data directory ──────────────────────────────────────────
# Use env var first, then existing cache, then $PWD fallback
_CACHE_FILE="$PLUGIN_ROOT/.workspace-data-dir"
if [ -n "${OPERANT_PI_DATA_DIR:-}" ]; then
  DATA_DIR="$OPERANT_PI_DATA_DIR"
elif [ -f "$_CACHE_FILE" ]; then
  _CACHED=$(cat "$_CACHE_FILE" 2>/dev/null | tr -d '[:space:]')
  if [ -n "$_CACHED" ] && [ -d "$_CACHED" ]; then
    DATA_DIR="$_CACHED"
  else
    DATA_DIR="$PWD/spec/.operant"
  fi
else
  DATA_DIR="$PWD/spec/.operant"
fi

# Cache for other hooks (they may run with a different $PWD)
echo "$DATA_DIR" > "$_CACHE_FILE"

# ── Create required directories ─────────────────────────────────────
for dir in "$DATA_DIR" "$DATA_DIR/calls" "$DATA_DIR/pending" "$DATA_DIR/processed"; do
  mkdir -p "$dir"
done

# ── Mode detection (cloud vs local) ───────────────────────────────────
MODE="local"
if [ -n "${OPERANT_API_KEY:-}" ]; then
  API_URL="${OPERANT_API_URL:-https://api.operantlabs.com}"
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $OPERANT_API_KEY" \
    "$API_URL/api/auth/verify" 2>/dev/null || echo "000")

  if [ "$HTTP_CODE" = "200" ]; then
    MODE="cloud"
    echo "[PIPELINE] Cloud mode active ($API_URL)"
  else
    echo "[PIPELINE] API key invalid or server unreachable (HTTP $HTTP_CODE). Falling back to local mode."
  fi
fi

if [ "$MODE" = "cloud" ]; then
  # Start trigger poller instead of local server + tunnel
  if [ -f "$PLUGIN_ROOT/lib/cli/poll-triggers.js" ]; then
    node "$PLUGIN_ROOT/lib/cli/poll-triggers.js" &
    echo $! > "$DATA_DIR/poller.pid"
    echo "[PIPELINE] Trigger poller started (PID $(cat "$DATA_DIR/poller.pid"))"
  fi
fi

# ── Session-start GitHub issue check (FR-3) ────────────────────────
if [ -f "$PLUGIN_ROOT/lib/cli/poll-github.js" ] && [ -n "${GITHUB_TOKEN:-}" ] && [ -n "${GITHUB_REPO:-}" ]; then
  echo "[startup/github] Checking for unprocessed GitHub issues..."
  OPERANT_PI_DATA_DIR="$DATA_DIR" node "$PLUGIN_ROOT/lib/cli/poll-github.js" --once 2>&1 || true
  echo "[startup/github] Session-start check complete"
fi

# ── Clean stale PID files ───────────────────────────────────────────
for pidfile in "$DATA_DIR"/*.pid; do
  [ -f "$pidfile" ] || continue
  pid=$(cat "$pidfile" 2>/dev/null || echo "")
  if [ -n "$pid" ]; then
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$pidfile"
    fi
  else
    rm -f "$pidfile"
  fi
done

# ── Infer FSM state from filesystem ─────────────────────────────────
SPECS_ROOT="$(dirname "$DATA_DIR")"
STATE_FILE="$DATA_DIR/current-state.txt"

if [ -f "$PLUGIN_ROOT/lib/cli/infer-state.js" ]; then
  inferred=$(OPERANT_PI_DATA_DIR="$DATA_DIR" node "$PLUGIN_ROOT/lib/cli/infer-state.js" "$SPECS_ROOT" 2>/dev/null || echo '{"state":"idle","phase":"idle"}')
  state=$(echo "$inferred" | jq -r '.state // "idle"')
  phase=$(echo "$inferred" | jq -r '.phase // "idle"')
  echo "$state" > "$STATE_FILE"
else
  # CLI not yet built — fall back to reading existing state or default
  if [ -f "$STATE_FILE" ]; then
    state=$(cat "$STATE_FILE")
  else
    state="idle"
    echo "$state" > "$STATE_FILE"
  fi
  phase="$state"
fi

# ── Count specs and pending calls ───────────────────────────────────
pending_count=$(find "$DATA_DIR/pending" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
call_count=$(find "$DATA_DIR/calls" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')

# ── Output pipeline status ──────────────────────────────────────────
cat <<EOF
[PIPELINE] Operant-Pi pipeline initialized.
  State: $state ($phase)
  Data dir: $DATA_DIR
  Pending calls: $pending_count
  Total calls: $call_count
EOF
