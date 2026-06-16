# Operant Pipeline — Dry Run Primer

Info-dense reference for walking a synthetic call through the full pipeline.
Read this before attempting a dry run so you don't have to re-derive the flow.

## Architecture at a glance

- **FSM**: `lib/state-machine.js` — 14 states, 21 transitions, pure functions (no side-effect execution)
- **Config**: `lib/config.js` — reads `OPERANT_PI_DATA_DIR` (default `$PWD/spec/.operant`), `OPERANT_PI_SPECS_DIR` (default `$PROJECT_ROOT/docs/specs`)
- **CLI drivers**: `lib/cli/process-trigger.js` (entry), `transition.js` (single event), `trigger-gate.js` (human gates w/ polling)
- **Hooks** (hooks.json): `detect-artifact.sh` (PostToolUse Write|Edit), `inject-context.sh` (UserPromptSubmit), `check-blockers.sh` (PostToolUse Bash), `subagent-complete.sh` (SubagentStop)
- **Agents**: `sdlc-writer` (sonnet, cyan), `dev-builder` (sonnet, green), `auditor` (sonnet, red + browser MCP)

## FSM state path (happy path)

```
idle -[CALL_RECEIVED]-> call_active -[CALL_COMPLETED]-> triage
  -[NEW_REQUIREMENTS]-> sdlc_intent -[ARTIFACT_PRODUCED]-> sdlc_review
  -[REVIEW_APPROVED]-> sdlc_hld -> sdlc_review -> sdlc_adr -> sdlc_review -> sdlc_eis -> sdlc_review
  -[REVIEW_APPROVED (eis)]-> dev -[DEV_COMPLETE]-> audit -[AUDIT_PASSED]-> demo_setup
  -> demo_calling -> demo_active -> demo_feedback -[DEMO_APPROVED]-> confirmation
  -[USER_CONFIRMED]-> complete -[RESET]-> idle
```

Unhappy paths: `dev_blocked` (BLOCKER_DETECTED), `audit_failed` (AUDIT_FAILED -> REVISION_READY -> dev), `demo_feedback` rejection -> dev.

## Dry run steps

### 1. Write synthetic trigger to pending/

```bash
cat > $DATA_DIR/pending/dry-run-trigger.json << 'EOF'
{
  "call_id": "dry-run-001",
  "caller_name": "Dry Run User",
  "from_number": "+0000000000",
  "source": "dry-run",
  "raw_transcript": "I need a dark mode toggle on the settings page. Persist preference in localStorage. Also accessible from the top nav bar.",
  "call_analysis": {
    "custom_analysis_data": {
      "feature_name": "dark-mode-toggle",
      "feature_title": "Dark Mode Toggle",
      "priority": "medium",
      "problem_statement": "Users cannot switch between light and dark themes",
      "goals": "[\"Dark mode toggle in settings\", \"localStorage persistence\", \"Nav bar shortcut\"]",
      "functional_requirements": "[\"Toggle in settings\", \"Toggle in nav\", \"localStorage\", \"CSS custom properties\"]",
      "non_functional_constraints": "[\"No FOUC\", \"Works with existing components\"]",
      "boundaries": "[\"No OS preference detection v1\"]",
      "open_questions": "[\"Animate the transition?\"]"
    }
  }
}
EOF
```

### 2. Process trigger (idle -> sdlc_intent, 3 transitions in 1 call)

```bash
cd $PROJECT_ROOT && \
  OPERANT_PI_DATA_DIR=$DATA_DIR \
  node $PLUGIN_ROOT/lib/cli/process-trigger.js $DATA_DIR/pending/dry-run-trigger.json
```

- Outputs JSON with `classification: "requirements"`, `specName` derived from `feature_name`
- Creates `$SPECS_DIR/<spec-name>/REQUIREMENTS.md` from raw transcript
- Moves trigger to `processed/`

### 3. SDLC loop (4 artifacts, 4 review gates)

For each artifact (`intent` -> `hld` -> `adr` -> `eis`):

- **Invoke** `operant:sdlc-writer` agent with spec dir path
- Agent writes artifact -> `detect-artifact.sh` hook fires -> FSM to `sdlc_review`
- **Run gate** (mock mode auto-approves in 3s):
  ```bash
  SECONDAXIS_MOCK=1 OPERANT_PI_DATA_DIR=$DATA_DIR \
    node $PLUGIN_ROOT/lib/cli/trigger-gate.js review <artifact_type> "$SPEC_DIR"
  ```
- Gate polls `pending/`, finds mock reply, transitions `sdlc_review -> next_sdlc_state`
- Repeat for next artifact

**Gotcha**: `detect-artifact.sh` writes `gate-pending.json` which causes `pre-write-guard.sh` to block ALL writes until the gate resolves. You must run the gate before the next agent can write.

### 4. Dev phase

- FSM enters `dev` after EIS review approved
- **Invoke** `operant:dev-builder` agent with spec dir + workspace root
- Agent reads implementation-spec.md, implements feature, writes code
- On completion: `subagent-complete.sh` hook can transition `dev -> audit`
- Or manual: `node $PLUGIN_ROOT/lib/cli/transition.js DEV_COMPLETE specDir=$SPEC_DIR`

### 5. Audit phase

- **Invoke** `operant:auditor` agent with spec dir
- Auditor reads spec, greps codebase, uses browser MCP for visual checks
- **Pass**: `AUDIT_PASSED` -> `demo_setup`
- **Fail**: writes `revisions/*.md` -> `detect-artifact.sh` catches it -> `audit_failed` -> `REVISION_READY` -> back to `dev`

### 6. Demo phase (optional)

- `demo_setup`: send tunnel URL to user, transition `DEMO_READY`
- `demo_calling` -> `demo_active` -> `demo_feedback`
- Or skip: `DEMO_FAILED` / `DEMO_SKIPPED` -> falls through to `confirmation`

### 7. Confirmation gate

```bash
SECONDAXIS_MOCK=1 OPERANT_PI_DATA_DIR=$DATA_DIR \
  node $PLUGIN_ROOT/lib/cli/trigger-gate.js confirmation "$SPEC_DIR"
```

- Mock auto-approves -> `USER_CONFIRMED` -> `complete` -> `RESET` -> `idle`

### 8. Cleanup (if dry run)

```bash
rm -rf $SPECS_DIR/<spec-name>
echo "idle" >| $DATA_DIR/current-state.txt
echo "" >| $DATA_DIR/active-spec.txt
rm -f $DATA_DIR/gate-pending.json $DATA_DIR/reviewed-artifact.txt
```

## Key env vars

| Var | Purpose | Default |
|-----|---------|---------|
| `OPERANT_PI_DATA_DIR` | FSM state, pending/, processed/ | `$PWD/spec/.operant` |
| `OPERANT_PI_SPECS_DIR` | Where SDLC artifacts are written | `$PROJECT_ROOT/docs/specs` |
| `OPERANT_PI_PROJECT_ROOT` | Target project root | `$PWD` |
| `SECONDAXIS_MOCK` | `1` = auto-approve all gates (3s delay) | `0` |
| `RETELL_API_KEY` | Retell voice API | required for real calls |
| `TWILIO_ACCOUNT_SID` | Twilio WhatsApp | required for real gates |

## Classifier heuristics (classifyTranscript)

1. `call_analysis.custom_analysis_data.feature_name` present -> `requirements`
2. 2+ confirmation keywords AND transcript < 200 chars -> `confirmation`
3. Any requirement keyword (build, feature, need, want, etc.) -> `requirements`
4. Transcript > 20 chars -> `requirements` (over-classify rather than drop)
5. Otherwise -> `unknown` (FSM rejects, returns to idle)

## Hook chain during SDLC

```
sdlc-writer writes artifact
  -> PostToolUse(Write) -> detect-artifact.sh
    -> runs transition.js ARTIFACT_PRODUCED
    -> writes gate-pending.json + reviewed-artifact.txt
    -> outputs STOP instruction
  -> next UserPromptSubmit -> inject-context.sh
    -> reads gate-pending.json -> outputs BLOCKING: RUN GATE
  -> Claude runs trigger-gate.js in background
    -> sends WhatsApp/voice (or mock)
    -> polls pending/ for reply
    -> runs REVIEW_APPROVED/REJECTED transition
    -> clears gate-pending.json
  -> next UserPromptSubmit -> inject-context.sh
    -> reads new state -> outputs ACTION: invoke next agent
```
