#!/bin/bash
# PreToolUse hook for Write|Edit — block spec writes during review state.
set -euo pipefail

source "${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}/scripts/_resolve-data-dir.sh"
STATE_FILE="$DATA_DIR/current-state.txt"

# ── Read tool input from stdin ──────────────────────────────────────
INPUT=$(cat)

# ── Extract file path from JSON ─────────────────────────────────────
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || echo "")

if [ -z "$FILE_PATH" ]; then
  # No file path — can't evaluate, let it through
  echo '{"decision": "approve"}'
  exit 0
fi

# ── Read current FSM state ──────────────────────────────────────────
CURRENT_STATE="idle"
if [ -f "$STATE_FILE" ]; then
  CURRENT_STATE=$(cat "$STATE_FILE" 2>/dev/null | tr -d '[:space:]')
fi

# ── DETERMINISTIC GATE ENFORCEMENT ──────────────────────────────────
# If gate-pending.json exists, block ALL writes except to .operant/ data dir.
# This forces Claude to run the gate command (via Bash) before doing anything else.
GATE_PENDING="$DATA_DIR/gate-pending.json"
if [ -f "$GATE_PENDING" ]; then
  case "$FILE_PATH" in
    */.operant/*|*/proof-of-working/*)
      # Internal data / proof files — always allowed
      echo '{"decision": "approve"}'
      exit 0
      ;;
    *)
      GATE_MODE=$(jq -r '.mode // "review"' "$GATE_PENDING" 2>/dev/null || echo "review")
      GATE_ARTIFACT=$(jq -r '.artifactType // ""' "$GATE_PENDING" 2>/dev/null || echo "")
      GATE_SPEC=$(jq -r '.specDir // ""' "$GATE_PENDING" 2>/dev/null || echo "")
      echo "{\"decision\": \"block\", \"reason\": \"GATE PENDING: A $GATE_MODE gate must be executed before any writes. Run via Bash: SECONDAXIS_MOCK=\${SECONDAXIS_MOCK:-0} node ${CLAUDE_PLUGIN_ROOT:-.}/lib/cli/trigger-gate.js $GATE_MODE $GATE_ARTIFACT \\\"$GATE_SPEC\\\"\"}"
      exit 0
      ;;
  esac
fi

# ── Guard: block spec writes during review ──────────────────────────
case "$FILE_PATH" in
  */spec/*|*/docs/specs/*)
    case "$FILE_PATH" in
      */.operant/*)
        echo '{"decision": "approve"}'
        exit 0
        ;;
    esac

    if [ "$CURRENT_STATE" = "sdlc_review" ]; then
      echo '{"decision": "block", "reason": "Pipeline is in review state. Wait for review approval before modifying spec artifacts."}'
      exit 0
    fi
    ;;
esac

echo '{"decision": "approve"}'
