#!/bin/bash
# Hook: Stop — validate FSM state after Claude finishes responding.
# Detects state drift and triggers auto-transitions when conditions are met.

set -euo pipefail

source "${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}/scripts/_resolve-data-dir.sh"
SPECS_ROOT="$(dirname "$DATA_DIR")"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

# ---------------------------------------------------------------------------
# Read current state and active spec
# ---------------------------------------------------------------------------

STATE="idle"
if [ -f "$DATA_DIR/current-state.txt" ]; then
  STATE="$(cat "$DATA_DIR/current-state.txt" | tr -d '[:space:]')"
  [ -z "$STATE" ] && STATE="idle"
fi

ACTIVE_SPEC=""
SPEC_DIR=""
if [ -f "$DATA_DIR/active-spec.txt" ]; then
  ACTIVE_SPEC="$(cat "$DATA_DIR/active-spec.txt" | tr -d '[:space:]')"
  if [ -n "$ACTIVE_SPEC" ]; then
    SPEC_DIR="$SPECS_ROOT/$ACTIVE_SPEC"
  fi
fi

# ---------------------------------------------------------------------------
# Infer state from filesystem
# ---------------------------------------------------------------------------

INFERRED_JSON=""
INFERRED_STATE=""

if command -v node &>/dev/null; then
  INFERRED_JSON=$(OPERANT_PI_DATA_DIR="$DATA_DIR" node "${PLUGIN_ROOT}/lib/cli/infer-state.js" "$SPECS_ROOT" 2>/dev/null || echo "")
  if [ -n "$INFERRED_JSON" ]; then
    INFERRED_STATE=$(echo "$INFERRED_JSON" | node -e "
      let d=''; process.stdin.on('data',c=>d+=c);
      process.stdin.on('end',()=>{try{process.stdout.write(JSON.parse(d).state||'')}catch{}})
    " 2>/dev/null || echo "")
  fi
fi

# ---------------------------------------------------------------------------
# Detect state drift
# ---------------------------------------------------------------------------

if [ -n "$INFERRED_STATE" ] && [ "$INFERRED_STATE" != "$STATE" ]; then
  echo "[validate-state] State drift detected: stored=$STATE inferred=$INFERRED_STATE"
fi

# ---------------------------------------------------------------------------
# Auto-transitions based on current state + filesystem conditions
# ---------------------------------------------------------------------------

TRANSITION_OUTPUT=""

# Dev phase: if no blockers remain, trigger DEV_COMPLETE
if [ "$STATE" = "dev" ] && [ -n "$SPEC_DIR" ] && [ -d "$SPEC_DIR" ]; then
  BLOCKER_COUNT=$(ls "$SPEC_DIR/blockers/"*.md 2>/dev/null | wc -l | tr -d '[:space:]')
  if [ "$BLOCKER_COUNT" -eq 0 ]; then
    # Check for dev-complete marker
    if [ -f "$SPEC_DIR/.dev-complete" ]; then
      TRANSITION_OUTPUT=$(OPERANT_PI_DATA_DIR="$DATA_DIR" node "${PLUGIN_ROOT}/lib/cli/transition.js" DEV_COMPLETE "specDir=$SPEC_DIR" 2>/dev/null || echo "")
      if [ -n "$TRANSITION_OUTPUT" ]; then
        echo "[validate-state] Auto-transition: DEV_COMPLETE"
      fi
    fi
  fi
fi

# Audit phase: if no revisions remain, trigger AUDIT_PASSED
if [ "$STATE" = "audit" ] && [ -n "$SPEC_DIR" ] && [ -d "$SPEC_DIR" ]; then
  REVISION_COUNT=$(ls "$SPEC_DIR/revisions/"*.md 2>/dev/null | wc -l | tr -d '[:space:]')
  if [ "$REVISION_COUNT" -eq 0 ]; then
    TRANSITION_OUTPUT=$(OPERANT_PI_DATA_DIR="$DATA_DIR" node "${PLUGIN_ROOT}/lib/cli/transition.js" AUDIT_PASSED "specDir=$SPEC_DIR" 2>/dev/null || echo "")
    if [ -n "$TRANSITION_OUTPUT" ]; then
      echo "[validate-state] Auto-transition: AUDIT_PASSED"
    fi
  fi
fi
