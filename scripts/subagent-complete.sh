#!/bin/bash
# Hook: SubagentStop — runs after any Agent tool invocation completes.
# Checks filesystem for new artifacts/blockers/revisions and triggers transitions.

set -euo pipefail

source "${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}/scripts/_resolve-data-dir.sh"
SPECS_ROOT="$(dirname "$DATA_DIR")"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

# ---------------------------------------------------------------------------
# Read current state
# ---------------------------------------------------------------------------

STATE="idle"
if [ -f "$DATA_DIR/current-state.txt" ]; then
  STATE="$(cat "$DATA_DIR/current-state.txt" | tr -d '[:space:]')"
  [ -z "$STATE" ] && STATE="idle"
fi

# ---------------------------------------------------------------------------
# Run post-agent filesystem check
# ---------------------------------------------------------------------------

if ! command -v node &>/dev/null; then
  echo "[subagent-complete] node not found, skipping post-agent check"
  exit 0
fi

CHECK_OUTPUT=$(OPERANT_PI_DATA_DIR="$DATA_DIR" node "${PLUGIN_ROOT}/lib/cli/post-agent-check.js" "$STATE" 2>/dev/null || echo "")

if [ -z "$CHECK_OUTPUT" ]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Report findings
# ---------------------------------------------------------------------------

# Extract findings summary
FINDINGS=$(echo "$CHECK_OUTPUT" | node -e "
  let d=''; process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    try {
      const r = JSON.parse(d);
      for (const f of (r.findings||[])) {
        process.stdout.write('[subagent-complete] ' + f.type + ': ' + f.detail + '\n');
      }
    } catch {}
  })
" 2>/dev/null || echo "")

if [ -n "$FINDINGS" ]; then
  echo "$FINDINGS"
fi

# ---------------------------------------------------------------------------
# Execute suggested transitions
# ---------------------------------------------------------------------------

echo "$CHECK_OUTPUT" | node -e "
  let d=''; process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    try {
      const r = JSON.parse(d);
      const transitions = r.suggestedTransitions || [];
      for (const t of transitions) {
        const ctx = t.context || {};
        const pairs = Object.entries(ctx).map(([k,v]) => k + '=' + v);
        process.stdout.write(JSON.stringify({ event: t.event, args: pairs, reason: t.reason }) + '\n');
      }
    } catch {}
  })
" 2>/dev/null | while IFS= read -r line; do
  EVENT=$(echo "$line" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{process.stdout.write(JSON.parse(d).event)}catch{}})" 2>/dev/null || echo "")
  REASON=$(echo "$line" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{process.stdout.write(JSON.parse(d).reason)}catch{}})" 2>/dev/null || echo "")
  ARGS_JSON=$(echo "$line" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{process.stdout.write(JSON.stringify(JSON.parse(d).args||[]))}catch{}})" 2>/dev/null || echo "[]")

  if [ -n "$EVENT" ]; then
    # Build args array for transition.js
    ARGS=$(echo "$ARGS_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{process.stdout.write(JSON.parse(d).join(' '))}catch{}})" 2>/dev/null || echo "")
    RESULT=$(OPERANT_PI_DATA_DIR="$DATA_DIR" node "${PLUGIN_ROOT}/lib/cli/transition.js" "$EVENT" $ARGS 2>/dev/null || echo "")
    if [ -n "$RESULT" ]; then
      echo "[subagent-complete] Transition executed: $EVENT ($REASON)"
    fi
  fi
done
