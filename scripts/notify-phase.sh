#!/bin/bash
# Hook: Notification — silently log user notifications.
# Reads notification from stdin, appends to notifications.log with timestamp.

set -euo pipefail

source "${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}/scripts/_resolve-data-dir.sh"
mkdir -p "$DATA_DIR"

LOG_FILE="$DATA_DIR/notifications.log"

# Read notification from stdin
INPUT=""
if [ ! -t 0 ]; then
  INPUT=$(cat)
fi

if [ -n "$INPUT" ]; then
  TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  printf '[%s] %s\n' "$TIMESTAMP" "$INPUT" >> "$LOG_FILE"
fi
