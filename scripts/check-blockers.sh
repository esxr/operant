#!/bin/bash
# PostToolUse hook for Bash — scan command output for blocker patterns
# and warn Claude when problems are detected.
set -euo pipefail

# ── Read tool result from stdin ─────────────────────────────────────
INPUT=$(cat)

# ── Extract text content from the tool result ───────────────────────
# PostToolUse receives JSON with tool_result; extract the text output
TEXT=$(echo "$INPUT" | jq -r '
  .tool_result.stdout // empty,
  .tool_result.stderr // empty,
  .tool_result.content // empty
' 2>/dev/null || echo "")

# Fall back: if jq extraction produced nothing, try the raw input
if [ -z "$TEXT" ]; then
  TEXT="$INPUT"
fi

# ── Check for blocker patterns ──────────────────────────────────────
BLOCKER=""

if echo "$TEXT" | grep -qi 'permission denied'; then
  BLOCKER="permission denied"
elif echo "$TEXT" | grep -qi 'EACCES'; then
  BLOCKER="EACCES (access error)"
elif echo "$TEXT" | grep -qi 'build failed'; then
  BLOCKER="build failed"
elif echo "$TEXT" | grep -qi 'FATAL'; then
  BLOCKER="FATAL error"
elif echo "$TEXT" | grep -qi 'cannot connect'; then
  BLOCKER="cannot connect"
elif echo "$TEXT" | grep -qiE 'env.*not found'; then
  BLOCKER="environment variable not found"
fi

if [ -n "$BLOCKER" ]; then
  cat <<EOF
[PIPELINE] WARNING — Blocker detected: $BLOCKER
[PIPELINE] The last command output suggests a blocking issue. Investigate before proceeding.
EOF
fi
