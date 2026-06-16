#!/bin/bash
# Hook: UserPromptSubmit — inject pipeline context before every user prompt.
# Outputs a ## Pipeline Context block so the LLM always knows where it is.

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

ACTIVE_SPEC="none"
SPEC_DIR=""
if [ -f "$DATA_DIR/active-spec.txt" ]; then
  ACTIVE_SPEC="$(cat "$DATA_DIR/active-spec.txt" | tr -d '[:space:]')"
  [ -z "$ACTIVE_SPEC" ] && ACTIVE_SPEC="none"
  if [ "$ACTIVE_SPEC" != "none" ]; then
    SPEC_DIR="$SPECS_ROOT/$ACTIVE_SPEC"
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
# Output context block
# ---------------------------------------------------------------------------

cat <<EOF
## Pipeline Context
- **Phase:** $PHASE
- **State:** $STATE
- **Active Spec:** $ACTIVE_SPEC
- **Blockers:** $BLOCKER_COUNT
- **Revisions:** $REVISION_COUNT
EOF

# ---------------------------------------------------------------------------
# DETERMINISTIC GATE CHECK — blocks all other actions until gate is run
# ---------------------------------------------------------------------------

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-.}"
GATE_PENDING="$DATA_DIR/gate-pending.json"
if [ -f "$GATE_PENDING" ]; then
  GATE_MODE=$(jq -r '.mode // empty' "$GATE_PENDING" 2>/dev/null || echo "")
  GATE_ARTIFACT=$(jq -r '.artifactType // empty' "$GATE_PENDING" 2>/dev/null || echo "")
  GATE_SPEC=$(jq -r '.specDir // empty' "$GATE_PENDING" 2>/dev/null || echo "")
  PROJECT_ROOT="$(dirname "$SPECS_ROOT")"

  if [ -n "$GATE_MODE" ]; then
    echo ""
    echo "**BLOCKING: GATE PENDING** — You MUST run this gate before doing anything else."
    echo "Run as background Bash: \`set -a && source $PLUGIN_ROOT/.env && set +a && cd $PROJECT_ROOT && OPERANT_PI_DATA_DIR=$DATA_DIR node $PLUGIN_ROOT/lib/cli/trigger-gate.js $GATE_MODE $GATE_ARTIFACT \"$GATE_SPEC\"\`"
    echo "trigger-gate sends via Twilio WhatsApp. Then simulate user reply on WhatsApp Web (\`my-browser\` MCP)."
    echo "The gate-pending file will be cleared when the gate resolves."
    # Exit early — no other actions until gate is done
    exit 0
  fi
fi

# ---------------------------------------------------------------------------
# Auto-process pending triggers (Gap 1)
# ---------------------------------------------------------------------------

PENDING_COUNT=$(find "$DATA_DIR/pending" -name '*.json' 2>/dev/null | wc -l | tr -d '[:space:]')
if [ "$STATE" = "idle" ] && [ "$PENDING_COUNT" -gt 0 ]; then
  TRIGGER_FILE=$(ls -t "$DATA_DIR/pending/"*.json 2>/dev/null | head -1)
  if [ -n "$TRIGGER_FILE" ]; then
    PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-.}"
    echo ""
    echo "**ACTION:** New trigger file detected: \`$TRIGGER_FILE\`"
    echo "Run: \`node $PLUGIN_ROOT/lib/cli/process-trigger.js \"$TRIGGER_FILE\"\` then invoke the \`operant:sdlc-writer\` agent."
  fi
fi

# ---------------------------------------------------------------------------
# State-specific warnings and actions
# ---------------------------------------------------------------------------

if [ "$STATE" = "sdlc_review" ]; then
  echo ""
  echo "**WAITING** for review approval. Do not write new artifacts."
  if [ -n "$SPEC_DIR" ]; then
    PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-.}"
    REVIEWED_ARTIFACT=""
    if [ -f "$DATA_DIR/reviewed-artifact.txt" ]; then
      REVIEWED_ARTIFACT=$(cat "$DATA_DIR/reviewed-artifact.txt" 2>/dev/null | tr -d '[:space:]')
    fi
    if [ -n "$REVIEWED_ARTIFACT" ]; then
      PROJECT_ROOT="$(dirname "$SPECS_ROOT")"
      echo "**RUN GATE:** Use Bash (run_in_background): \`set -a && source $PLUGIN_ROOT/.env && set +a && cd $PROJECT_ROOT && OPERANT_PI_DATA_DIR=$DATA_DIR node $PLUGIN_ROOT/lib/cli/trigger-gate.js review $REVIEWED_ARTIFACT \"$SPEC_DIR\"\`"
      echo "trigger-gate sends via Twilio WhatsApp automatically. Then simulate user reply on WhatsApp Web (\`my-browser\` MCP)."
    fi
  fi
fi

if [ "$STATE" = "dev_blocked" ]; then
  echo ""
  echo "**BLOCKED.** Waiting for blocker resolution."
fi

# ---------------------------------------------------------------------------
# Agent launch directives (LAUNCH_AGENT side effect execution)
# ---------------------------------------------------------------------------

if [ -n "$SPEC_DIR" ] && [ "$ACTIVE_SPEC" != "none" ]; then
  PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-.}"
  case "$STATE" in
    sdlc_intent|sdlc_hld|sdlc_adr|sdlc_eis)
      echo ""
      echo "**ACTION:** Invoke the \`operant:sdlc-writer\` agent to produce the next artifact for spec at \`$SPEC_DIR\`."
      ;;
    dev)
      echo ""
      echo "**ACTION:** Invoke the \`operant:dev-builder\` agent to implement the spec at \`$SPEC_DIR\`. Workspace: \`$SPECS_ROOT/..\`"
      ;;
    audit)
      echo ""
      echo "**ACTION:** Invoke the \`operant:auditor\` agent to verify the implementation against \`$SPEC_DIR\`. Dev server should be at http://localhost:3000."
      ;;
    audit_failed)
      echo ""
      echo "**ACTION:** Revision(s) written. Run: \`node $PLUGIN_ROOT/lib/cli/transition.js REVISION_READY specDir=$SPEC_DIR\` then invoke \`operant:dev-builder\` with revision context."
      ;;
    demo_setup)
      # Read tunnel URL if available
      TUNNEL_URL=""
      if [ -f "$DATA_DIR/tunnel_url.txt" ]; then
        TUNNEL_URL=$(cat "$DATA_DIR/tunnel_url.txt" 2>/dev/null | tr -d '[:space:]')
      fi
      PROJECT_ROOT="$(dirname "$SPECS_ROOT")"
      echo ""
      if [ -n "$TUNNEL_URL" ]; then
        echo "**ACTION: DEMO SETUP**"
        echo "1. Send the tunnel URL to the user via WhatsApp (\`my-browser\` MCP on web.whatsapp): \"Feature is live at $TUNNEL_URL — check it out and reply approve/reject\""
        echo "2. Then transition: \`cd $PROJECT_ROOT && node $PLUGIN_ROOT/lib/cli/transition.js DEMO_READY specDir=$SPEC_DIR meetUrl=$TUNNEL_URL\`"
        echo "3. Skip to confirmation: \`cd $PROJECT_ROOT && node $PLUGIN_ROOT/lib/cli/transition.js DEMO_SKIPPED specDir=$SPEC_DIR\`"
        echo "4. Run confirmation gate via background Bash with --poll-only (waiting for user's WhatsApp reply)"
      else
        echo "**ACTION:** No tunnel URL found. Skip demo: \`cd $PROJECT_ROOT && node $PLUGIN_ROOT/lib/cli/transition.js DEMO_FAILED specDir=$SPEC_DIR reason=no-tunnel\`"
      fi
      ;;
    confirmation)
      PROJECT_ROOT="$(dirname "$SPECS_ROOT")"
      echo ""
      echo "**ACTION:** Run confirmation gate: Bash (run_in_background) \`set -a && source $PLUGIN_ROOT/.env && set +a && cd $PROJECT_ROOT && OPERANT_PI_DATA_DIR=$DATA_DIR node $PLUGIN_ROOT/lib/cli/trigger-gate.js confirmation \"$SPEC_DIR\"\`"
      echo "trigger-gate sends via Twilio WhatsApp. Then simulate user reply on WhatsApp Web (\`my-browser\` MCP)."
      ;;
  esac
fi
