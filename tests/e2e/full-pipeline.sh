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
#        E2E_TARGET_REPO=pegg-app/pegg-app bash tests/e2e/full-pipeline.sh
# Exit:  0 on PASS, 1 on FAIL
#
# Environment variables (all optional, have sane defaults):
#   E2E_TARGET_REPO          - GitHub repo to clone and test against
#   E2E_ISSUE_REPO           - GitHub repo for issue tracking (defaults to target)
#   TWILIO_WHATSAPP_RECIPIENT - WhatsApp number for gate approvals
#   E2E_FIXTURE_FILE         - Custom trigger fixture JSON path
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
FIXTURE_FILE="${E2E_FIXTURE_FILE:-$PLUGIN_DIR/tests/fixtures/health-endpoint-trigger.json}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
WORKDIR="/tmp/operant-e2e-$TIMESTAMP"
REPO="${E2E_TARGET_REPO:-esxr/operant-sample-app}"
ISSUE_REPO="${E2E_ISSUE_REPO:-$REPO}"
ISSUE_NUM=""
SPEC_DIR=""  # set after triage
DATA_DIR=""  # set after clone
PROMPTS_DIR="$SCRIPT_DIR/../prompts"
CHROME_PID=""
WHATSAPP_NUMBER="${TWILIO_WHATSAPP_RECIPIENT:-+61416052430}"

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

CHROME_PROFILE="/tmp/operant-chrome-profile"

start_chrome() {
  # Chrome blocks --remote-debugging-port on the default profile.
  # Solution: copy the real profile to a persistent non-default location.
  # This preserves WhatsApp Web login, cookies, extensions across runs.
  # See: .claude/skills/browser-harness/SKILL.md § "Launching Chrome with CDP"

  # 1. Quit any running Chrome — flag is silently ignored if Chrome is already running
  if pgrep -f "Google Chrome" &>/dev/null; then
    log "Killing existing Chrome instances (CDP flag requires exclusive launch)"
    pkill -f "Google Chrome" 2>/dev/null || true
    sleep 3
  fi

  # 2. Seed profile from real Chrome on first run; reuse on subsequent runs
  if [ ! -d "$CHROME_PROFILE" ]; then
    local real_profile="$HOME/Library/Application Support/Google/Chrome"
    if [ -d "$real_profile" ]; then
      log "Copying real Chrome profile to $CHROME_PROFILE (first-time setup, preserves WhatsApp login)"
      cp -R "$real_profile" "$CHROME_PROFILE"
    else
      log "No existing Chrome profile found — starting fresh"
      mkdir -p "$CHROME_PROFILE"
    fi
  else
    log "Reusing existing operant Chrome profile at $CHROME_PROFILE"
  fi

  # 3. Launch with the non-default profile copy
  log "Launching Chrome with remote debugging on port 9223"
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --remote-debugging-port=9223 \
    --no-first-run \
    --no-default-browser-check \
    --user-data-dir="$CHROME_PROFILE" \
    "https://web.whatsapp.com" \
    "about:blank" \
    &>/dev/null &
  CHROME_PID=$!
  log "Chrome PID: $CHROME_PID"

  # 4. Wait for CDP to be ready
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
  # Post a comment to the tracking GitHub issue.
  # Use --body-file via temp file to handle large markdown with special chars.
  local tmpfile="/tmp/e2e-gh-comment-$$.md"
  echo "$1" > "$tmpfile"
  gh issue comment "$ISSUE_NUM" --repo "$ISSUE_REPO" --body-file "$tmpfile" 2>/dev/null || true
  rm -f "$tmpfile"
}

upload_screenshot() {
  # Upload a screenshot to the sample-app repo as a committed file,
  # return the raw GitHub URL for embedding in issue comments.
  # gh gist doesn't support binary files, so we commit to the repo instead.
  local filepath="$1"
  if [ ! -f "$filepath" ]; then
    echo ""
    return
  fi
  local filename
  filename="e2e-screenshot-$TIMESTAMP.png"
  # Copy screenshot into repo, commit, push, return raw URL
  cp "$filepath" "$WORKDIR/$filename"
  cd "$WORKDIR"
  git add "$filename" >&2 2>/dev/null
  git commit -m "test: add E2E audit screenshot" "$filename" >&2 2>/dev/null
  git push origin main >&2 2>/dev/null
  echo "https://raw.githubusercontent.com/$REPO/main/$filename"
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

bridge_reply() {
  # Bridge a WhatsApp reply into pending/ for trigger-gate.js.
  # In local mode there's no webhook server to receive Twilio callbacks,
  # so we write the file that the webhook would have written.
  local source="${1:-whatsapp}"
  local caller="${2:-E2E Browser}"
  local reply_file="$DATA_DIR/pending/wa-reply-$(date +%s%N).json"
  cat > "$reply_file" <<SEOF
{
  "source": "$source",
  "from_number": "$WHATSAPP_NUMBER",
  "body": "1",
  "caller_name": "$caller",
  "message_sid": "WA_$(date +%s)"
}
SEOF
  log "Bridged reply written to $reply_file"
}

# Approve a gate via WhatsApp Web browser, then bridge the reply into pending/.
# Flow: browser sends "1" on WhatsApp Web (real message) → we write the reply
# file that the webhook server would have written (no webhook in local mode).
# Falls back to bridged-only reply if browser fails.
# Args: $1=prompt_file, $2...=load_prompt substitution args
approve_gate() {
  local prompt_file="$1"
  shift
  local approval_source="simulated"

  # Schedule a safety-net bridge reply at 90s in background.
  # This ensures trigger-gate.js (120s timeout) always gets a reply
  # even if the browser agent takes longer than expected.
  (sleep 90 && bridge_reply "whatsapp" "E2E safety-net" && log "Safety-net bridge fired at 90s") &
  local safety_pid=$!

  # Try real WhatsApp approval via browser
  if curl -s --max-time 3 http://localhost:9223/json/version &>/dev/null; then
    log "Chrome CDP reachable — sending real WhatsApp approval via browser"
    local wa_prompt
    wa_prompt=$(load_prompt "$prompt_file" "$@")
    local wa_exit=0
    claude -p "$wa_prompt" \
      --model sonnet \
      --mcp-config "$SCRIPT_DIR/mcp-my-browser.json" \
      --max-turns 10 \
      --max-budget-usd 1.00 \
      --no-session-persistence \
      --permission-mode auto \
      --allowedTools "mcp__my-browser__browser_navigate,mcp__my-browser__browser_snapshot,mcp__my-browser__browser_click,mcp__my-browser__browser_type,mcp__my-browser__browser_press_key,mcp__my-browser__browser_wait_for,mcp__my-browser__browser_evaluate,mcp__my-browser__browser_tabs" \
      2>&1 | tail -5 || wa_exit=$?

    if [ "$wa_exit" -eq 0 ]; then
      log "Browser sent '1' on WhatsApp Web — bridging reply for trigger-gate"
      approval_source="whatsapp-browser"
      kill "$safety_pid" 2>/dev/null || true  # cancel safety net
      bridge_reply "whatsapp" "E2E $approval_source"
      return 0
    fi
    log "Browser approval failed (exit $wa_exit) — safety-net bridge will fire"
  else
    log "Chrome CDP not reachable — safety-net bridge will fire"
  fi

  # Safety net is already scheduled; wait for it if needed
  wait "$safety_pid" 2>/dev/null || true
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
  cat > "$DATA_DIR/whitelist.json" <<WEOF
{
  "callers": [
    { "phone": "+16505551234", "name": "E2E Test User", "role": "caller", "added": "2026-06-16" }
  ],
  "default_blocker_target": "$WHATSAPP_NUMBER"
}
WEOF

  # Seed trigger file
  log "Seeding trigger file"
  cp "$FIXTURE_FILE" "$DATA_DIR/pending/e2e-trigger-$TIMESTAMP.json"

  # Create specs output dir (where SDLC artifacts go)
  mkdir -p "$WORKDIR/docs/specs"

  # Extract transcript from trigger fixture for the issue body
  local transcript
  transcript=$(python3 -c "import json; print(json.load(open('$FIXTURE_FILE'))['transcript'])" 2>/dev/null)
  local call_summary
  call_summary=$(python3 -c "import json; print(json.load(open('$FIXTURE_FILE'))['call_analysis']['call_summary'])" 2>/dev/null)
  local caller_name
  caller_name=$(python3 -c "import json; print(json.load(open('$FIXTURE_FILE'))['caller_name'])" 2>/dev/null)

  # Create GitHub issue with full context
  log "Creating GitHub issue"
  local issue_body_file="/tmp/e2e-issue-body-$$.md"
  cat > "$issue_body_file" <<IBODY
## Full Pipeline E2E Test

### Feature Request (Voice Call)

> **Caller:** $caller_name
> **Summary:** $call_summary

\`\`\`
$transcript
\`\`\`

### Expected Outcome
- \`GET /health\` endpoint added to \`server.js\`
- Returns HTTP 200 with \`{ "status": "ok", "timestamp": "<ISO8601>" }\`
- All 4 SDLC artifacts produced (intent, HLD, ADR, impl-spec)
- Pipeline returns to idle state after confirmation

### Pipeline Config
| Setting | Value |
|---------|-------|
| Target repo | \`$REPO\` |
| SDLC model | \`sonnet\` (via sdlc-writer) |
| Dev model | \`sonnet\` (via dev-builder) |
| Audit model | \`haiku\` (via auditor-browser) |
| Gate approval | simulated (real WhatsApp best-effort) |
| Gate timeout | 120s |
| Server port | 3999 |
| Started | $(date -u +%Y-%m-%dT%H:%M:%SZ) |

### Phases
Each phase is logged as a comment below with: input, agent, output proof, and artifacts.
IBODY
  ISSUE_NUM=$(gh issue create \
    --repo "$ISSUE_REPO" \
    --title "[E2E] Full pipeline test — $TIMESTAMP" \
    --body-file "$issue_body_file" 2>&1 | grep -oE '[0-9]+$')
  rm -f "$issue_body_file"

  log "Issue created: $ISSUE_REPO#$ISSUE_NUM"

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
  local requirements_content
  requirements_content=$(cat "$SPEC_DIR/REQUIREMENTS.md" 2>/dev/null || echo "(empty)")
  local classification
  classification=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('classification','unknown'))" 2>/dev/null || echo "unknown")

  gh_comment "$(cat <<COMMENT
## Phase 1: Triage (${duration}s)

**Agent:** \`process-trigger.js\` (deterministic — no LLM)
**Input:** Trigger JSON from voice call (call_id: \`e2e-test-call-001\`)
**Result:** Classified as \`$classification\` → created spec \`health-check-endpoint\`

### FSM Transitions
\`\`\`
idle → call_active (CALL_RECEIVED)
call_active → triage (CALL_COMPLETED)
triage → sdlc_intent (NEW_REQUIREMENTS)
\`\`\`

### REQUIREMENTS.md
<details><summary>Click to expand</summary>

$requirements_content

</details>
COMMENT
)"
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
    --model sonnet \
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

  # (c) Send WhatsApp review gate (2 min timeout for E2E)
  log "Triggering WhatsApp review gate for $artifact"
  OPERANT_PI_DATA_DIR="$DATA_DIR" \
    OPERANT_PI_PROJECT_ROOT="$WORKDIR" \
    CHANNEL_TIMEOUT_review=120 \
    node "$PLUGIN_DIR/lib/cli/trigger-gate.js" review "$artifact" "$SPEC_DIR" &
  local gate_pid=$!

  # (d) Wait for WhatsApp message to arrive, then approve (real or simulated)
  sleep 15  # give Twilio time to deliver message to phone
  log "Approving review gate for $artifact"
  approve_gate "whatsapp-approve-review.md" "ARTIFACT=$artifact"

  # (e) Wait for gate to resolve
  log "Waiting for gate to resolve..."
  wait "$gate_pid" || true

  # Verify transition happened
  assert_state "$to_state"

  local duration=$(( SECONDS - start_time ))
  local artifact_content
  artifact_content=$(cat "$SPEC_DIR/$filename" 2>/dev/null || echo "(not found)")

  gh_comment "$(cat <<COMMENT
## Phase $phase_num: SDLC $artifact (${duration}s)

**Agent:** \`sonnet\` via sdlc-writer
**Input prompt:**
\`\`\`
$prompt
\`\`\`
**FSM:** \`$from_state\` → \`sdlc_review\` → \`$to_state\`
**Gate:** simulated WhatsApp reply (approved)

### $filename
<details><summary>Click to expand full artifact</summary>

$artifact_content

</details>
COMMENT
)"
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
    --model sonnet \
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

  # Capture git diff summary and the /health route snippet
  cd "$WORKDIR"
  local diff_stat
  diff_stat=$(git diff --stat 2>/dev/null || echo "(no git diff available)")
  local health_snippet
  health_snippet=$(grep -A5 "health" "$WORKDIR/server.js" 2>/dev/null | head -8 || echo "(not found)")

  gh_comment "$(cat <<COMMENT
## Phase 6: Dev (${duration}s)

**Agent:** \`sonnet\` via dev-builder
**Input prompt:**
\`\`\`
$dev_prompt
\`\`\`
**FSM:** \`dev\` → \`audit\`

### Changes
\`\`\`
$diff_stat
\`\`\`

### /health route (from server.js)
\`\`\`javascript
$health_snippet
\`\`\`
COMMENT
)"
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

  # Start dev server on port 3999 to avoid conflicts with other local servers
  log "Starting Express dev server on port 3999"
  PORT=3999 node server.js &
  local server_pid=$!
  echo "$server_pid" > "$DATA_DIR/server.pid"
  sleep 3

  # Curl assertion (deterministic)
  log "Curl test: GET http://localhost:3999/health"
  local http_code
  http_code=$(curl -s -o /tmp/e2e-health-response.json -w "%{http_code}" http://localhost:3999/health 2>/dev/null || echo "000")

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

  # Browser audit via auditor-browser MCP (with screenshot)
  # The MCP saves screenshots to its --output-dir (proof-of-working/videos by default).
  # We run from $WORKDIR so the screenshot lands in $WORKDIR/.playwright-mcp/
  log "Running browser audit via auditor-browser"
  local audit_prompt
  audit_prompt=$(load_prompt "auditor-browser.md")
  claude -p "$audit_prompt" \
    --model sonnet \
    --mcp-config "$SCRIPT_DIR/mcp-auditor.json" \
    --max-turns 8 \
    --max-budget-usd 1.00 \
    --no-session-persistence \
    --permission-mode auto \
    --allowedTools "mcp__auditor-browser__browser_navigate,mcp__auditor-browser__browser_snapshot,mcp__auditor-browser__browser_take_screenshot,mcp__auditor-browser__browser_evaluate,mcp__auditor-browser__browser_close" \
    2>&1 | tail -5

  # Kill server
  kill "$server_pid" 2>/dev/null || true
  rm -f "$DATA_DIR/server.pid"

  # Find and upload the screenshot (MCP saves to .playwright-mcp/ or proof-of-working/)
  local screenshot_md=""
  local screenshot_file
  screenshot_file=$(find "$WORKDIR" /tmp -maxdepth 3 -name "e2e-health-audit.png" -o -name "page-*.png" 2>/dev/null | head -1)
  if [ -z "$screenshot_file" ]; then
    # Fallback: find any recent png from playwright
    screenshot_file=$(find "$WORKDIR" /tmp -maxdepth 4 -name "*.png" -newer "$DATA_DIR/current-state.txt" 2>/dev/null | head -1)
  fi
  if [ -n "$screenshot_file" ] && [ -f "$screenshot_file" ]; then
    log "Found screenshot: $screenshot_file"
    local screenshot_url
    screenshot_url=$(upload_screenshot "$screenshot_file")
    if [ -n "$screenshot_url" ]; then
      screenshot_md="### Screenshot
![Audit screenshot of /health endpoint]($screenshot_url)"
      log "Screenshot uploaded: $screenshot_url"
    else
      log "Screenshot upload failed"
    fi
  else
    log "No screenshot file found"
  fi

  # Transition: AUDIT_PASSED → demo_setup, then DEMO_FAILED → confirmation (skip demo)
  log "Transitioning: AUDIT_PASSED then DEMO_FAILED (skip demo)"
  OPERANT_PI_DATA_DIR="$DATA_DIR" \
    node "$PLUGIN_DIR/lib/cli/transition.js" AUDIT_PASSED "specDir=$SPEC_DIR" 2>&1 || true
  OPERANT_PI_DATA_DIR="$DATA_DIR" \
    node "$PLUGIN_DIR/lib/cli/transition.js" DEMO_FAILED "specDir=$SPEC_DIR" "reason=e2e-test-skip" 2>&1 || true

  assert_state "confirmation"

  local duration=$(( SECONDS - start_time ))

  gh_comment "$(cat <<COMMENT
## Phase 7: Audit (${duration}s)

**Agent:** \`sonnet\` via auditor-browser (headless)
**FSM:** \`audit\` → \`confirmation\` (demo skipped)

### Curl Verification
\`\`\`bash
$ curl http://localhost:3999/health
# HTTP $http_code
$body
\`\`\`

**Assertions:** \`status == "ok"\` ✓ | \`timestamp\` present ✓

$screenshot_md
COMMENT
)"
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

  # Send confirmation gate (2 min timeout for E2E)
  log "Triggering WhatsApp confirmation gate"
  OPERANT_PI_DATA_DIR="$DATA_DIR" \
    OPERANT_PI_PROJECT_ROOT="$WORKDIR" \
    CHANNEL_TIMEOUT_confirmation=120 \
    node "$PLUGIN_DIR/lib/cli/trigger-gate.js" confirmation "$SPEC_DIR" &
  local gate_pid=$!

  # Wait for message delivery, then approve (real or simulated)
  sleep 15  # give Twilio time to deliver message to phone
  log "Approving confirmation gate"
  approve_gate "whatsapp-approve-confirmation.md"

  # Wait for gate
  log "Waiting for confirmation gate to resolve..."
  wait "$gate_pid" || true

  # Should be complete now (trigger-gate does USER_CONFIRMED + RESET)
  local final_state
  final_state="$(read_state)"
  log "Final state: $final_state"

  local duration=$(( SECONDS - start_time ))

  gh_comment "$(cat <<COMMENT
## Phase 8: Confirmation (${duration}s)

**Gate:** simulated WhatsApp reply (approved with "1")
**FSM:** \`confirmation\` → \`$final_state\`
COMMENT
)"
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

  gh_comment "$(cat <<COMMENT
## Phase 9: Final Assertions

| Check | Result |
|-------|--------|
| Trigger moved to \`processed/\` | ✓ ($processed_count files) |
| \`intent-and-constraints.md\` exists | ✓ |
| \`high-level-design.md\` exists | ✓ |
| \`adr-lite.md\` exists | ✓ |
| \`implementation-spec.md\` exists | ✓ |
| \`REQUIREMENTS.md\` exists | ✓ |
| \`server.js\` contains \`/health\` route | ✓ |
| FSM state = \`idle\` or \`complete\` | ✓ (\`$final_state\`) |
COMMENT
)"
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
    --model sonnet \
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
