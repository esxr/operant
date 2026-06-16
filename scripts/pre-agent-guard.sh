#!/bin/bash
# PreToolUse hook for Agent — block agent launches while a gate is pending.
# Forces Claude to run the gate command (via Bash) first.
set -euo pipefail

source "${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}/scripts/_resolve-data-dir.sh"

GATE_PENDING="$DATA_DIR/gate-pending.json"
if [ -f "$GATE_PENDING" ]; then
  GATE_MODE=$(jq -r '.mode // "review"' "$GATE_PENDING" 2>/dev/null || echo "review")
  GATE_ARTIFACT=$(jq -r '.artifactType // ""' "$GATE_PENDING" 2>/dev/null || echo "")
  GATE_SPEC=$(jq -r '.specDir // ""' "$GATE_PENDING" 2>/dev/null || echo "")
  PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-.}"
  echo "{\"decision\": \"block\", \"reason\": \"GATE PENDING: Run the $GATE_MODE gate via Bash before launching agents. Command: SECONDAXIS_MOCK=\${SECONDAXIS_MOCK:-0} node $PLUGIN_ROOT/lib/cli/trigger-gate.js $GATE_MODE $GATE_ARTIFACT \\\"$GATE_SPEC\\\"\"}"
  exit 0
fi

# Read stdin (required by hook protocol)
cat > /dev/null
echo '{"decision": "approve"}'
