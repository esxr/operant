#!/bin/bash
# Shared helper: resolve the operant data directory.
# Sources this in hooks via: source "${CLAUDE_PLUGIN_ROOT}/scripts/_resolve-data-dir.sh"
#
# Resolution order:
# 1. OPERANT_PI_DATA_DIR env var (explicit override)
# 2. Cached value from .workspace-data-dir (set by startup.sh)
# 3. $PWD/spec/.operant (fallback)

_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-.}"
_CACHE_FILE="$_PLUGIN_ROOT/.workspace-data-dir"

# Source .env if it exists (provides TWILIO_*, RETELL_*, SECONDAXIS_MOCK, etc.)
if [ -f "$_PLUGIN_ROOT/.env" ]; then
  set -a
  source "$_PLUGIN_ROOT/.env"
  set +a
fi

if [ -n "${OPERANT_PI_DATA_DIR:-}" ]; then
  DATA_DIR="$OPERANT_PI_DATA_DIR"
elif [ -f "$_CACHE_FILE" ]; then
  DATA_DIR="$(cat "$_CACHE_FILE" 2>/dev/null | tr -d '[:space:]')"
  if [ -z "$DATA_DIR" ]; then DATA_DIR="$PWD/spec/.operant"; fi
else
  DATA_DIR="$PWD/spec/.operant"
fi
