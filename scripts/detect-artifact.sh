#!/bin/bash
# PostToolUse hook for Write|Edit — detect spec artifact production and
# trigger FSM transitions.
set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-.}"
source "${CLAUDE_PLUGIN_ROOT:-.}/scripts/_resolve-data-dir.sh"

# ── Read tool input from stdin ──────────────────────────────────────
INPUT=$(cat)

# ── Extract file path from JSON ─────────────────────────────────────
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || echo "")

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# ── Only match files inside /spec/ or /docs/specs/ but NOT in /.operant/ ──
case "$FILE_PATH" in
  */spec/*|*/docs/specs/*)
    case "$FILE_PATH" in
      */.operant/*)
        # Internal data file — skip
        exit 0
        ;;
    esac
    ;;
  *)
    # Not a spec file — skip
    exit 0
    ;;
esac

# ── Check for revision file (*/revisions/*.md) ────────────────────
case "$FILE_PATH" in
  */revisions/*.md)
    SPEC_DIR=$(dirname "$(dirname "$FILE_PATH")")
    REVISION_NAME=$(basename "$FILE_PATH")
    if [ -f "$PLUGIN_ROOT/lib/cli/transition.js" ]; then
      RESULT=$(OPERANT_PI_DATA_DIR="$DATA_DIR" node "$PLUGIN_ROOT/lib/cli/transition.js" AUDIT_FAILED "specDir=$SPEC_DIR" 2>/dev/null || echo "")
      NEW_STATE=$(echo "$RESULT" | jq -r '.to // empty' 2>/dev/null || echo "")
      if [ -n "$NEW_STATE" ]; then
        cat <<EOF
[PIPELINE] Revision detected: $REVISION_NAME
[PIPELINE] State transitioned to: $NEW_STATE
[PIPELINE] Audit failed — revision written. Dev cycle will resume.
EOF
      fi
    fi
    exit 0
    ;;
esac

# ── Match filename to SDLC artifact type ───────────────────────────
FILENAME=$(basename "$FILE_PATH")
ARTIFACT=""

case "$FILENAME" in
  intent-and-constraints.md) ARTIFACT="intent" ;;
  high-level-design.md)      ARTIFACT="hld"    ;;
  adr-lite.md)               ARTIFACT="adr"    ;;
  implementation-spec.md)    ARTIFACT="eis"    ;;
esac

if [ -z "$ARTIFACT" ]; then
  exit 0
fi

# ── Trigger FSM transition ──────────────────────────────────────────
if [ -f "$PLUGIN_ROOT/lib/cli/transition.js" ]; then
  RESULT=$(OPERANT_PI_DATA_DIR="$DATA_DIR" node "$PLUGIN_ROOT/lib/cli/transition.js" ARTIFACT_PRODUCED "artifactType=$ARTIFACT" 2>/dev/null || echo "")
  NEW_STATE=$(echo "$RESULT" | jq -r '.to // empty' 2>/dev/null || echo "")

  if [ -n "$NEW_STATE" ]; then
    cat <<EOF
[PIPELINE] Artifact detected: $ARTIFACT ($FILENAME)
[PIPELINE] State transitioned to: $NEW_STATE
[PIPELINE] STOP — This artifact is now pending review. Do not produce the next artifact until review is approved.
EOF

    # If transitioned to sdlc_review, persist gate state for deterministic execution
    if [ "$NEW_STATE" = "sdlc_review" ]; then
      SPEC_DIR=$(dirname "$FILE_PATH")
      # Save reviewed artifact so inject-context can reconstruct the gate command
      echo "$ARTIFACT" > "$DATA_DIR/reviewed-artifact.txt"
      # Write a gate-pending file — inject-context checks this EVERY prompt
      # and will REFUSE to proceed until the gate is run
      cat > "$DATA_DIR/gate-pending.json" <<GATEFILE
{"mode":"review","artifactType":"$ARTIFACT","specDir":"$SPEC_DIR","created":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
GATEFILE
      cat <<GATE
[PIPELINE] **MANDATORY: RUN GATE** — A review gate is pending. Execute as background Bash:
  SECONDAXIS_MOCK=\${SECONDAXIS_MOCK:-0} node $PLUGIN_ROOT/lib/cli/trigger-gate.js review $ARTIFACT "$SPEC_DIR"
This is NOT optional. The pipeline will block all further work until this gate is executed.
GATE
    fi
  else
    cat <<EOF
[PIPELINE] Artifact detected: $ARTIFACT ($FILENAME)
[PIPELINE] FSM transition returned no new state — check for errors.
EOF
  fi
else
  cat <<EOF
[PIPELINE] Artifact detected: $ARTIFACT ($FILENAME)
[PIPELINE] CLI not built — skipping FSM transition. Run 'npm run build' in the plugin root.
EOF
fi
