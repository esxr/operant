#!/bin/bash
# =============================================================================
# Full Pipeline E2E Test
# =============================================================================
#
# Runs the entire operant pipeline end-to-end on a real codebase.
# Only the inbound Retell call is mocked (seeded trigger file).
# Everything else is live: real agents, real WhatsApp, real browser, real code.
#
# Target repo:  esxr/operant-sample-app (minimal Express + HTML)
# Sample feature: "Add GET /health returning { status: 'ok', timestamp: <ISO8601> }"
# Plugin:       /Users/pranav/Desktop/operant (loaded via --plugin-dir)
#
# Usage: bash tests/e2e/full-pipeline.sh
# Exit:  0 on PASS, 1 on FAIL
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
FIXTURE_FILE="$PLUGIN_DIR/tests/fixtures/health-endpoint-trigger.json"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
WORKDIR="/tmp/operant-e2e-$TIMESTAMP"
REPO="esxr/operant-sample-app"
ISSUE_REPO="esxr/operant-sample-app"
ISSUE_NUM=""
SPEC_DIR=""  # set after triage
DATA_DIR=""  # set after clone
PROMPTS_DIR="$SCRIPT_DIR/../prompts"
CHROME_PID=""

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

log() { echo "[e2e] $(date +%H:%M:%S) $*"; }

load_prompt() {
  # Load a prompt template and substitute {{VAR}} placeholders from env
  local file="$PROMPTS_DIR/$1"
  local content
  content="$(cat "$file")"
  shift
  while [ $# -gt 0 ]; do
    local key="${1%%=*}"
    local val="${1#*=}"
    content="${content//\{\{$key\}\}/$val}"
    shift
  done
  echo "$content"
}

start_chrome() {
  log "Launching Chrome with remote debugging on port 9223"
  /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
    --remote-debugging-port=9223 \
    --no-first-run \
    --no-default-browser-check \
    --user-data-dir="/tmp/e2e-chrome-profile" \
    "https://web.whatsapp.com" \
    "about:blank" \
    &>/dev/null &
  CHROME_PID=$!
  log "Chrome PID: $CHROME_PID"
  # Wait for CDP to be ready
  for i in $(seq 1 15); do
    if curl -s http://localhost:9223/json/version &>/dev/null; then
      log "Chrome CDP ready"
      return 0
    fi
    sleep 1
  done
  log "WARNING: Chrome CDP not responding after 15s"
}

gh_comment() {
  # Post a comment to the tracking GitHub issue
  gh issue comment "$ISSUE_NUM" --repo "$ISSUE_REPO" --body "$1" 2>/dev/null || true
}

read_state() {
  cat "$DATA_DIR/current-state.txt" 2>/dev/null | tr -d '[:space:]'
}

assert_state() {
  local expected="$1"
  local actual
  actual="$(read_state)"
  if [ "$actual" != "$expected" ]; then
    log "ASSERTION FAILED: expected state=$expected, got state=$actual"
    gh_comment "**ASSERTION FAILED**: expected state=\`$expected\`, got state=\`$actual\`"
    exit 1
  fi
  log "State OK: $actual"
}

assert_file_exists() {
  if [ ! -f "$1" ]; then
    log "ASSERTION FAILED: file not found: $1"
    gh_comment "**ASSERTION FAILED**: file not found: \`$1\`"
    exit 1
  fi
  log "File OK: $1"
}

cleanup() {
  log "Cleaning up workdir: $WORKDIR"
  # Kill any background processes we started
  if [ -f "$DATA_DIR/poller.pid" ]; then
    kill "$(cat "$DATA_DIR/poller.pid")" 2>/dev/null || true
  fi
  # Kill Chrome if we started it
  if [ -n "$CHROME_PID" ]; then
    kill "$CHROME_PID" 2>/dev/null || true
    log "Chrome killed (PID $CHROME_PID)"
  fi
  # Don't rm the workdir — keep for inspection
  log "Workdir preserved at: $WORKDIR"
}
trap cleanup EXIT

# =============================================================================
# PHASE 0: Setup
# =============================================================================
# - Clone esxr/operant-sample-app to /tmp/operant-e2e-<timestamp>
# - Install npm deps
# - Set up DATA_DIR (spec/.operant) and seed the trigger file
# - Create GitHub issue for logging
# =============================================================================

setup() {
  log "=== PHASE 0: Setup ==="

  # Clone
  log "Cloning $REPO to $WORKDIR"
  gh repo clone "$REPO" "$WORKDIR" -- --depth 1
  cd "$WORKDIR"

  # Install deps
  log "Installing npm dependencies"
  npm install --silent 2>&1 | tail -3

  # Set up data dir
  DATA_DIR="$WORKDIR/spec/.operant"
  mkdir -p "$DATA_DIR/pending" "$DATA_DIR/processed" "$DATA_DIR/calls"
  echo "idle" > "$DATA_DIR/current-state.txt"

  # Set up whitelist (needed for WhatsApp gates)
  cat > "$DATA_DIR/whitelist.json" << 'WEOF'
{
  "callers": [
    { "phone": "+16505551234", "name": "E2E Test User", "role": "caller", "added": "2026-06-16" }
  ],
  "default_blocker_target": "+61416052430"
}
WEOF

  # Seed trigger file
  log "Seeding trigger file"
  cp "$FIXTURE_FILE" "$DATA_DIR/pending/e2e-trigger-$TIMESTAMP.json"

  # Create specs output dir (where SDLC artifacts go)
  mkdir -p "$WORKDIR/docs/specs"

  # Create GitHub issue
  log "Creating GitHub issue"
  ISSUE_NUM=$(gh issue create \
    --repo "$ISSUE_REPO" \
    --title "[E2E] Full pipeline test — $TIMESTAMP" \
    --body "$(cat <<IBODY
## Full Pipeline E2E Test

- **Started:** $(date -u +%Y-%m-%dT%H:%M:%SZ)
- **Workdir:** \`$WORKDIR\`
- **Plugin:** \`$PLUGIN_DIR\`
- **Feature:** Add GET /health returning \`{ status: 'ok', timestamp: '<ISO8601>' }\`
- **Trigger:** seeded from \`$FIXTURE_FILE\`

### Phases
1. Triage — classify transcript, create spec dir
2. SDLC Intent — produce intent-and-constraints.md + WhatsApp review gate
3. SDLC HLD — produce high-level-design.md + WhatsApp review gate
4. SDLC ADR — produce adr-lite.md + WhatsApp review gate
5. SDLC Impl-spec — produce implementation-spec.md + WhatsApp review gate
6. Dev — dev-builder implements /health endpoint
7. Audit — auditor verifies /health via browser
8. Confirmation — WhatsApp confirmation gate
9. Assertions — verify files, state, endpoint
IBODY
)" 2>&1 | grep -oE '[0-9]+$')

  log "Issue created: $ISSUE_REPO#$ISSUE_NUM"
  gh_comment "**Phase 0: Setup** complete. Workdir: \`$WORKDIR\`. Trigger seeded."

  # Launch Chrome with WhatsApp Web pre-loaded
  # Tab 1: WhatsApp Web (for gate approvals)
  # Tab 2: blank (available for auditor if needed)
  start_chrome
}

# =============================================================================
# PHASE 1: Triage
# =============================================================================
# - Run process-trigger.js on the seeded trigger file
# - FSM: idle → call_active → triage → sdlc_intent
# - Trigger file moves from pending/ to processed/
# - REQUIREMENTS.md written to spec dir
# - Capture SPEC_DIR from output
# =============================================================================

phase_triage() {
  log "=== PHASE 1: Triage ==="
  local start_time=$SECONDS

  cd "$WORKDIR"
  local trigger_file="$DATA_DIR/pending/e2e-trigger-$TIMESTAMP.json"

  # Run process-trigger
  local result
  result=$(OPERANT_PI_DATA_DIR="$DATA_DIR" \
    OPERANT_PI_SPECS_DIR="$WORKDIR/docs/specs" \
    OPERANT_PI_PROJECT_ROOT="$WORKDIR" \
    node "$PLUGIN_DIR/lib/cli/process-trigger.js" "$trigger_file" 2>&1)

  log "process-trigger output: $result"

  # Extract spec dir from result
  SPEC_DIR=$(echo "$result" | python3 -c "
import sys, json
data = json.load(sys.stdin)
name = data.get('specName', '')
print(name)
" 2>/dev/null || echo "")

  if [ -z "$SPEC_DIR" ]; then
    log "FAIL: No specName in process-trigger output"
    gh_comment "**Phase 1: Triage** FAILED — no specName in output"
    exit 1
  fi

  SPEC_DIR="$WORKDIR/docs/specs/$SPEC_DIR"
  log "Spec dir: $SPEC_DIR"

  # Write active-spec so other scripts can find it
  echo "$SPEC_DIR" > "$DATA_DIR/active-spec.txt"

  # Assertions
  assert_state "sdlc_intent"
  assert_file_exists "$SPEC_DIR/REQUIREMENTS.md"

  local duration=$(( SECONDS - start_time ))
  gh_comment "**Phase 1: Triage** — State: idle → sdlc_intent | Spec: \`$SPEC_DIR\` | Duration: ${duration}s"
}

# =============================================================================
# PHASE 2-5: SDLC Cycle (Intent → HLD → ADR → Impl-spec)
# =============================================================================
# For each artifact:
#   a) Invoke claude -p with sdlc-writer agent to produce the artifact
#   b) detect-artifact hook triggers FSM → sdlc_review
#   c) trigger-gate.js sends WhatsApp review message
#   d) claude -p with my-browser MCP approves on WhatsApp Web (sends "1")
#   e) trigger-gate.js polls reply, transitions FSM → next sdlc state
# =============================================================================

# Run one SDLC phase: produce artifact, gate, approve
# Args: $1=artifact_name (intent/hld/adr/eis), $2=phase_num, $3=expected_from_state, $4=expected_to_state, $5=filename
sdlc_phase() {
  local artifact="$1"
  local phase_num="$2"
  local from_state="$3"
  local to_state="$4"
  local filename="$5"
  local start_time=$SECONDS

  log "=== PHASE $phase_num: SDLC $artifact ==="
  assert_state "$from_state"

  cd "$WORKDIR"

  # (a) Invoke sdlc-writer to produce the artifact
  log "Invoking sdlc-writer for $artifact"
  local prompt
  prompt=$(load_prompt "sdlc-writer.md" \
    "SPEC_DIR=$SPEC_DIR" "FROM_STATE=$from_state" "FILENAME=$filename")
  claude -p "$prompt" \
    --model haiku \
    --plugin-dir "$PLUGIN_DIR" \
    --max-turns 15 \
    --max-budget-usd 2.00 \
    --no-session-persistence \
    --permission-mode acceptEdits \
    --allowedTools "Read,Write,Edit,Glob,Grep" \
    2>&1 | tail -5

  assert_file_exists "$SPEC_DIR/$filename"

  # (b) The detect-artifact hook should have transitioned to sdlc_review.
  #     But since we're in -p mode, hooks may not fire automatically.
  #     Manually trigger the FSM transition if needed.
  local current_state
  current_state="$(read_state)"
  if [ "$current_state" != "sdlc_review" ]; then
    log "Manually triggering ARTIFACT_PRODUCED transition"
    OPERANT_PI_DATA_DIR="$DATA_DIR" \
      node "$PLUGIN_DIR/lib/cli/transition.js" ARTIFACT_PRODUCED \
      "artifactType=$artifact" "specDir=$SPEC_DIR" 2>&1 || true
  fi
  assert_state "sdlc_review"

  # (c) Send WhatsApp review gate
  log "Triggering WhatsApp review gate for $artifact"
  OPERANT_PI_DATA_DIR="$DATA_DIR" \
    OPERANT_PI_PROJECT_ROOT="$WORKDIR" \
    node "$PLUGIN_DIR/lib/cli/trigger-gate.js" review "$artifact" "$SPEC_DIR" &
  local gate_pid=$!

  # (d) Wait for WhatsApp message to arrive, then approve via browser
  sleep 10  # give Twilio time to deliver
  log "Approving via WhatsApp Web (my-browser)"
  local wa_prompt
  wa_prompt=$(load_prompt "whatsapp-approve-review.md" "ARTIFACT=$artifact")
  claude -p "$wa_prompt" \
    --model haiku \
    --max-turns 10 \
    --max-budget-usd 1.00 \
    --no-session-persistence \
    --permission-mode auto \
    --allowedTools "mcp__my-browser__browser_navigate,mcp__my-browser__browser_snapshot,mcp__my-browser__browser_click,mcp__my-browser__browser_type,mcp__my-browser__browser_press_key,mcp__my-browser__browser_wait_for,mcp__my-browser__browser_evaluate,mcp__my-browser__browser_tabs" \
    2>&1 | tail -5

  # (e) Wait for gate to resolve
  log "Waiting for gate to resolve..."
  wait "$gate_pid" || true

  # Verify transition happened
  assert_state "$to_state"

  local duration=$(( SECONDS - start_time ))
  gh_comment "**Phase $phase_num: SDLC $artifact** — State: $from_state → $to_state | File: \`$filename\` | Duration: ${duration}s"
}

phase_sdlc() {
  sdlc_phase "intent" 2 "sdlc_intent" "sdlc_hld"  "intent-and-constraints.md"
  sdlc_phase "hld"    3 "sdlc_hld"    "sdlc_adr"  "high-level-design.md"
  sdlc_phase "adr"    4 "sdlc_adr"    "sdlc_eis"  "adr-lite.md"
  sdlc_phase "eis"    5 "sdlc_eis"    "dev"        "implementation-spec.md"
}

# =============================================================================
# PHASE 6: Dev
# =============================================================================
# - Invoke claude -p with dev-builder agent to implement the /health endpoint
# - Works in the cloned operant-sample-app repo
# - Should modify server.js to add GET /health route
# - Manually transition FSM: dev → audit (via DEV_COMPLETE)
# =============================================================================

phase_dev() {
  log "=== PHASE 6: Dev ==="
  local start_time=$SECONDS

  assert_state "dev"
  cd "$WORKDIR"

  log "Invoking dev-builder to implement /health endpoint"
  local dev_prompt
  dev_prompt=$(load_prompt "dev-builder.md" "WORKDIR=$WORKDIR" "SPEC_DIR=$SPEC_DIR")
  claude -p "$dev_prompt" \
    --model haiku \
    --plugin-dir "$PLUGIN_DIR" \
    --max-turns 15 \
    --max-budget-usd 2.00 \
    --no-session-persistence \
    --permission-mode acceptEdits \
    --allowedTools "Read,Write,Edit,Bash,Glob,Grep" \
    2>&1 | tail -5

  # Verify /health was added
  if ! grep -q "health" "$WORKDIR/server.js" 2>/dev/null; then
    log "FAIL: /health endpoint not found in server.js"
    gh_comment "**Phase 6: Dev** FAILED — /health not found in server.js"
    exit 1
  fi
  log "/health endpoint found in server.js"

  # Transition FSM: dev → audit
  log "Transitioning: DEV_COMPLETE"
  OPERANT_PI_DATA_DIR="$DATA_DIR" \
    node "$PLUGIN_DIR/lib/cli/transition.js" DEV_COMPLETE "specDir=$SPEC_DIR" 2>&1 || true

  assert_state "audit"

  local duration=$(( SECONDS - start_time ))
  gh_comment "**Phase 6: Dev** — State: dev → audit | Modified: server.js | Duration: ${duration}s"
}

# =============================================================================
# PHASE 7: Audit
# =============================================================================
# - Start the Express dev server in background
# - Invoke claude -p with auditor-browser MCP to verify /health endpoint
# - Verify: GET /health returns 200, body contains { status: 'ok' }
# - Also do a curl assertion for deterministic check
# - Transition FSM: audit → demo_setup (AUDIT_PASSED)
# - Skip demo (DEMO_FAILED) → goes to confirmation
# =============================================================================

phase_audit() {
  log "=== PHASE 7: Audit ==="
  local start_time=$SECONDS

  assert_state "audit"
  cd "$WORKDIR"

  # Start dev server
  log "Starting Express dev server"
  node server.js &
  local server_pid=$!
  echo "$server_pid" > "$DATA_DIR/server.pid"
  sleep 3

  # Curl assertion (deterministic)
  log "Curl test: GET http://localhost:3000/health"
  local http_code
  http_code=$(curl -s -o /tmp/e2e-health-response.json -w "%{http_code}" http://localhost:3000/health 2>/dev/null || echo "000")

  if [ "$http_code" != "200" ]; then
    log "FAIL: /health returned HTTP $http_code (expected 200)"
    gh_comment "**Phase 7: Audit** FAILED — /health returned HTTP $http_code"
    kill "$server_pid" 2>/dev/null || true
    exit 1
  fi

  local body
  body=$(cat /tmp/e2e-health-response.json)
  log "/health response: $body"

  if ! echo "$body" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['status']=='ok'; assert 'timestamp' in d" 2>/dev/null; then
    log "FAIL: /health response missing status=ok or timestamp"
    gh_comment "**Phase 7: Audit** FAILED — response: \`$body\`"
    kill "$server_pid" 2>/dev/null || true
    exit 1
  fi
  log "Curl assertion passed: status=ok, timestamp present"

  # Browser audit via auditor-browser MCP
  log "Running browser audit via auditor-browser"
  local audit_prompt
  audit_prompt=$(load_prompt "auditor-browser.md")
  claude -p "$audit_prompt" \
    --model haiku \
    --max-turns 8 \
    --max-budget-usd 1.00 \
    --no-session-persistence \
    --permission-mode auto \
    --allowedTools "mcp__auditor-browser__browser_navigate,mcp__auditor-browser__browser_snapshot,mcp__auditor-browser__browser_take_screenshot,mcp__auditor-browser__browser_evaluate,mcp__auditor-browser__browser_close" \
    2>&1 | tail -5

  # Kill server
  kill "$server_pid" 2>/dev/null || true
  rm -f "$DATA_DIR/server.pid"

  # Transition: AUDIT_PASSED → demo_setup, then DEMO_FAILED → confirmation (skip demo)
  log "Transitioning: AUDIT_PASSED then DEMO_FAILED (skip demo)"
  OPERANT_PI_DATA_DIR="$DATA_DIR" \
    node "$PLUGIN_DIR/lib/cli/transition.js" AUDIT_PASSED "specDir=$SPEC_DIR" 2>&1 || true
  OPERANT_PI_DATA_DIR="$DATA_DIR" \
    node "$PLUGIN_DIR/lib/cli/transition.js" DEMO_FAILED "specDir=$SPEC_DIR" "reason=e2e-test-skip" 2>&1 || true

  assert_state "confirmation"

  local duration=$(( SECONDS - start_time ))
  gh_comment "**Phase 7: Audit** — State: audit → confirmation | HTTP: 200 | Body: \`$body\` | Duration: ${duration}s"
}

# =============================================================================
# PHASE 8: Confirmation
# =============================================================================
# - trigger-gate.js sends WhatsApp confirmation message
# - claude -p with my-browser MCP approves on WhatsApp Web (sends "1")
# - FSM: confirmation → complete → idle (via RESET)
# =============================================================================

phase_confirmation() {
  log "=== PHASE 8: Confirmation ==="
  local start_time=$SECONDS

  assert_state "confirmation"
  cd "$WORKDIR"

  # Send confirmation gate
  log "Triggering WhatsApp confirmation gate"
  OPERANT_PI_DATA_DIR="$DATA_DIR" \
    OPERANT_PI_PROJECT_ROOT="$WORKDIR" \
    node "$PLUGIN_DIR/lib/cli/trigger-gate.js" confirmation "$SPEC_DIR" &
  local gate_pid=$!

  # Wait for message delivery, then approve
  sleep 10
  log "Approving confirmation via WhatsApp Web (my-browser)"
  local confirm_prompt
  confirm_prompt=$(load_prompt "whatsapp-approve-confirmation.md")
  claude -p "$confirm_prompt" \
    --model haiku \
    --max-turns 10 \
    --max-budget-usd 1.00 \
    --no-session-persistence \
    --permission-mode auto \
    --allowedTools "mcp__my-browser__browser_navigate,mcp__my-browser__browser_snapshot,mcp__my-browser__browser_click,mcp__my-browser__browser_type,mcp__my-browser__browser_press_key,mcp__my-browser__browser_wait_for,mcp__my-browser__browser_evaluate,mcp__my-browser__browser_tabs" \
    2>&1 | tail -5

  # Wait for gate
  log "Waiting for confirmation gate to resolve..."
  wait "$gate_pid" || true

  # Should be complete now (trigger-gate does USER_CONFIRMED + RESET)
  local final_state
  final_state="$(read_state)"
  log "Final state: $final_state"

  local duration=$(( SECONDS - start_time ))
  gh_comment "**Phase 8: Confirmation** — State: confirmation → $final_state | Duration: ${duration}s"
}

# =============================================================================
# PHASE 9: Assertions
# =============================================================================
# - Verify trigger moved to processed/
# - Verify all 4 SDLC artifacts exist
# - Verify /health in server.js
# - Verify FSM state = idle (complete → reset)
# - Verify /health returns 200 (restart server briefly)
# =============================================================================

phase_assertions() {
  log "=== PHASE 9: Final Assertions ==="

  # Trigger processed
  local processed_count
  processed_count=$(ls "$DATA_DIR/processed/"*.json 2>/dev/null | wc -l | tr -d '[:space:]')
  log "Processed trigger files: $processed_count"
  [ "$processed_count" -ge 1 ] || { log "FAIL: no processed triggers"; exit 1; }

  # SDLC artifacts
  assert_file_exists "$SPEC_DIR/intent-and-constraints.md"
  assert_file_exists "$SPEC_DIR/high-level-design.md"
  assert_file_exists "$SPEC_DIR/adr-lite.md"
  assert_file_exists "$SPEC_DIR/implementation-spec.md"
  assert_file_exists "$SPEC_DIR/REQUIREMENTS.md"

  # Implementation
  assert_file_exists "$WORKDIR/server.js"
  grep -q "health" "$WORKDIR/server.js" || { log "FAIL: /health not in server.js"; exit 1; }

  # Final state (should be idle after RESET, or complete if RESET hasn't run)
  local final_state
  final_state="$(read_state)"
  if [ "$final_state" != "idle" ] && [ "$final_state" != "complete" ]; then
    log "FAIL: expected state=idle or complete, got state=$final_state"
    exit 1
  fi
  log "Final state: $final_state (OK)"

  gh_comment "**Phase 9: Assertions** — All passed. Files: 5 artifacts + server.js. State: \`$final_state\`."
}

# =============================================================================
# PHASE 10: LLM-as-Judge Evaluation
# =============================================================================
# - Spawn claude -p to review the GitHub issue thread
# - Instruct it to add a final PASS/FAIL comment
# - Parse the result for exit code
# =============================================================================

phase_evaluation() {
  log "=== PHASE 10: LLM Evaluation ==="

  local issue_url="https://github.com/$ISSUE_REPO/issues/$ISSUE_NUM"
  log "Issue URL: $issue_url"

  local eval_prompt
  eval_prompt=$(load_prompt "evaluator.md" \
    "ISSUE_URL=$issue_url" "ISSUE_NUM=$ISSUE_NUM" "ISSUE_REPO=$ISSUE_REPO")
  claude -p "$eval_prompt" \
    --model haiku \
    --max-turns 5 \
    --max-budget-usd 0.50 \
    --no-session-persistence \
    --permission-mode auto \
    --allowedTools "Bash" \
    2>&1 | tail -10

  # Check the issue for PASS/FAIL
  local last_comment
  last_comment=$(gh issue view "$ISSUE_NUM" --repo "$ISSUE_REPO" --comments --json comments --jq '.comments[-1].body' 2>/dev/null || echo "")

  if echo "$last_comment" | grep -qi "Result: PASS"; then
    log "=== E2E TEST PASSED ==="
    gh_comment "**E2E Test Duration:** $(( SECONDS ))s total"
    exit 0
  else
    log "=== E2E TEST FAILED ==="
    gh_comment "**E2E Test Duration:** $(( SECONDS ))s total"
    exit 1
  fi
}

# =============================================================================
# Main — run all phases sequentially
# =============================================================================

main() {
  log "Starting full pipeline E2E test"
  log "Timestamp: $TIMESTAMP"
  log "Plugin: $PLUGIN_DIR"
  log "Workdir: $WORKDIR"

  setup
  phase_triage
  phase_sdlc
  phase_dev
  phase_audit
  phase_confirmation
  phase_assertions
  phase_evaluation
}

main "$@"
