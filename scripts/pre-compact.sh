#!/bin/bash
# Hook: PreCompact — preserve pipeline state across context window compaction.
# Outputs a summary block that survives the compaction process.

set -euo pipefail

source "${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}/scripts/_resolve-data-dir.sh"
SPECS_ROOT="$(dirname "$DATA_DIR")"

# ---------------------------------------------------------------------------
# Read state files (safe defaults)
# ---------------------------------------------------------------------------

STATE="idle"
if [ -f "$DATA_DIR/current-state.txt" ]; then
  STATE="$(cat "$DATA_DIR/current-state.txt" | tr -d '[:space:]')"
  [ -z "$STATE" ] && STATE="idle"
fi

SPEC="none"
SPEC_DIR=""
if [ -f "$DATA_DIR/active-spec.txt" ]; then
  SPEC="$(cat "$DATA_DIR/active-spec.txt" | tr -d '[:space:]')"
  [ -z "$SPEC" ] && SPEC="none"
  if [ "$SPEC" != "none" ]; then
    SPEC_DIR="$SPECS_ROOT/$SPEC"
  fi
fi

# ---------------------------------------------------------------------------
# Count blockers and revisions
# ---------------------------------------------------------------------------

BLOCKER_COUNT=0
if [ -n "$SPEC_DIR" ] && [ -d "$SPEC_DIR/blockers" ]; then
  BLOCKER_COUNT=$(ls "$SPEC_DIR/blockers/"*.md 2>/dev/null | wc -l | tr -d '[:space:]')
fi

REVISION_COUNT=0
if [ -n "$SPEC_DIR" ] && [ -d "$SPEC_DIR/revisions" ]; then
  REVISION_COUNT=$(ls "$SPEC_DIR/revisions/"*.md 2>/dev/null | wc -l | tr -d '[:space:]')
fi

# ---------------------------------------------------------------------------
# Map state to phase
# ---------------------------------------------------------------------------

case "$STATE" in
  idle|call_active|complete) PHASE="idle" ;;
  triage)                    PHASE="triage" ;;
  sdlc_intent|sdlc_hld|sdlc_adr|sdlc_eis|sdlc_review)
                             PHASE="sdlc" ;;
  dev|dev_blocked)           PHASE="dev" ;;
  audit|audit_failed)        PHASE="audit" ;;
  demo_setup|demo_calling|demo_active|demo_feedback)
                             PHASE="demo" ;;
  confirmation)              PHASE="confirmation" ;;
  *)                         PHASE="idle" ;;
esac

# ---------------------------------------------------------------------------
# Output compaction-safe summary
# ---------------------------------------------------------------------------

cat <<EOF
IMPORTANT - Pipeline state to preserve after compaction:
- FSM State: $STATE
- Active Spec: $SPEC
- Phase: $PHASE
- Blockers: $BLOCKER_COUNT
- Revisions: $REVISION_COUNT
- Use /status to re-check pipeline state if uncertain
EOF
