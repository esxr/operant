# Testing Strategy

## Philosophy

- **Plumbing is deterministic** — test exhaustively (FSM, hooks, API proxies)
- **Agent output is non-deterministic** — test for crashes, not correctness
- **Full pipeline is tested live** — real agents, real WhatsApp, real browser, only the inbound call is mocked
- Two layers: deterministic (unit/hook/integration) + full pipeline E2E

## Layer 1: Deterministic Tests (66 tests, <1s)

### Unit — Vitest + fast-check

- **`tests/unit/state-machine.test.ts`** — every transition, invalid events, edge states
- **`tests/unit/state-machine.prop.test.ts`** — fast-check command-based FSM fuzzing
  - Each FSM event = a fast-check `Command` with `check(model)` guard + `run(model, real)` executor
  - Catches: undefined `reviewedArtifact` in dynamic `to` fns, unreachable states, transition loops
- **`tests/unit/config.test.ts`** — `getMode()`, `getDataDir()`, `readState()`/`writeState()` round-trip
- Deps: `vitest`, `fast-check`

### Hooks — bats-core

- **Pattern:** pipe JSON stdin → set `$DATA_DIR` + `$CLAUDE_PLUGIN_ROOT` → run script → assert stdout/exit code
- **`tests/hooks/pre-write-guard.test.sh`** — blocks spec writes during `sdlc_review`, allows during `dev`, blocks when `gate-pending.json` exists
- **`tests/hooks/detect-artifact.test.sh`** — detects SDLC artifacts, ignores non-spec files
- **`tests/hooks/inject-context.test.sh`** — emits `## Pipeline Context` block with correct state/phase/blockers
- **`tests/hooks/validate-state.test.sh`** — detects state drift, runs cleanly in idle
- Deps: `bats-core`, `bats-support`, `bats-assert`

### Integration — Vitest + MSW

- **`tests/integration/retell-proxy.test.ts`** — `makeOutboundCall()` against MSW mock of `api.retellai.com`
- **`tests/integration/whatsapp-proxy.test.ts`** — `formatGateMessage()` + `parseReply()` pure function tests
- MSW intercepts `node:https` at network level — no code changes needed
- Deps: `msw`

## Layer 2: Full Pipeline E2E (`tests/e2e/full-pipeline.sh`)

Runs the **entire pipeline on a real codebase** (`esxr/operant-sample-app`). Only the inbound Retell call is mocked (seeded trigger file). Everything else is live.

- **Target:** `esxr/operant-sample-app` — minimal Express + HTML, cloned to `/tmp/operant-e2e-<timestamp>`
- **Feature:** "Add GET /health returning `{ status: 'ok', timestamp: '<ISO8601>' }`"
- **Trigger:** `tests/fixtures/health-endpoint-trigger.json` — seeded into `pending/`
- **Model:** all `claude -p` invocations use `--model haiku` for speed/cost
- **Cost:** ~$2-5 per run (haiku pricing: 5 WhatsApp gates + sdlc-writer + dev-builder + auditor + evaluator)

### Browser Setup

- Chrome launched automatically with `--remote-debugging-port=9223` in Phase 0
- Pre-opens **Tab 1: WhatsApp Web** (`web.whatsapp.com`) — used by all gate approvals
- `my-browser` MCP connects via CDP on port 9223 — agents reference Tab 1 directly
- `auditor-browser` MCP runs headless (separate instance, no pre-setup needed)
- Chrome killed automatically in cleanup

### Prompt Templates (`tests/prompts/`)

All `claude -p` prompts extracted to editable markdown files with `{{VAR}}` placeholders:

| File | Used by | Substitutions |
|------|---------|---------------|
| `sdlc-writer.md` | Phases 2-5: artifact production | `SPEC_DIR`, `FROM_STATE`, `FILENAME` |
| `whatsapp-approve-review.md` | Phases 2-5: gate approval | `ARTIFACT` |
| `dev-builder.md` | Phase 6: implementation | `WORKDIR`, `SPEC_DIR` |
| `auditor-browser.md` | Phase 7: browser audit | — |
| `whatsapp-approve-confirmation.md` | Phase 8: confirmation gate | — |
| `evaluator.md` | Phase 10: LLM-as-judge | `ISSUE_URL`, `ISSUE_NUM`, `ISSUE_REPO` |

Loaded via `load_prompt "file.md" "KEY=value" ...` helper in the script.

### Phases

| # | Phase | What happens | Gate |
|---|-------|-------------|------|
| 0 | Setup | Clone repo, seed trigger, create GH issue, launch Chrome | — |
| 1 | Triage | `process-trigger.js` classifies → sdlc_intent | — |
| 2 | SDLC Intent | sdlc-writer produces `intent-and-constraints.md` | WhatsApp → `my-browser` Tab 1 approves |
| 3 | SDLC HLD | sdlc-writer produces `high-level-design.md` | WhatsApp → `my-browser` Tab 1 approves |
| 4 | SDLC ADR | sdlc-writer produces `adr-lite.md` | WhatsApp → `my-browser` Tab 1 approves |
| 5 | SDLC Impl-spec | sdlc-writer produces `implementation-spec.md` | WhatsApp → `my-browser` Tab 1 approves |
| 6 | Dev | dev-builder implements /health in server.js | — |
| 7 | Audit | `curl` + `auditor-browser` (headless) verify /health returns 200 | — |
| 8 | Confirmation | WhatsApp confirmation gate | WhatsApp → `my-browser` Tab 1 approves |
| 9 | Assertions | Verify files, state, endpoint | — |
| 10 | Evaluation | `claude -p` reviews GH issue, comments PASS/FAIL | — |

### Logging
- GitHub issue created on `esxr/operant-sample-app` at start
- Every phase logged as a `gh issue comment` with state transition, files, duration
- Final `claude -p` evaluator reviews the thread and comments PASS/FAIL

### Assertions (Phase 9)
1. Trigger file moved to `processed/`
2. All 4 SDLC artifacts exist + REQUIREMENTS.md
3. `server.js` contains `/health` route
4. FSM state = `idle` or `complete`
5. `curl localhost:3000/health` returns 200 with `{ status: 'ok', timestamp: ... }`

## Headless Smoke Tests (claude -p)

Tested 2026-06-16. All passing.

```bash
# Plugin validation (no API cost)
claude plugin validate /path/to/operant

# /status — full pipeline state table
claude -p "/operant:status" \
  --plugin-dir /path/to/operant \
  --max-turns 3 --no-session-persistence --permission-mode dontAsk

# /whitelist — show whitelisted callers
claude -p "show me the whitelist using /operant:whitelist" \
  --plugin-dir /path/to/operant \
  --max-turns 5 --no-session-persistence --permission-mode dontAsk

# Plugin loads in fresh directory (hook chain test)
cd $(mktemp -d) && claude -p "respond with only: HOOKS_OK" \
  --plugin-dir /path/to/operant \
  --max-turns 1 --no-session-persistence --permission-mode dontAsk
```

## Running

```bash
# Layer 1 — deterministic (fast, every commit)
npx vitest run
npx bats tests/hooks/*.test.sh

# Layer 2 — full pipeline E2E (slow, ~$2-5, pre-release)
bash tests/e2e/full-pipeline.sh
```

## File Structure

```
tests/
  unit/
    state-machine.test.ts         # 26 transition tests + stateToPhase + classify + derive
    state-machine.prop.test.ts    # 3 fast-check property tests (500 runs each)
    config.test.ts                # 6 config round-trip tests
  hooks/
    setup.bash                    # shared bats setup (tmp dirs, env vars)
    pre-write-guard.test.sh       # 6 tests
    detect-artifact.test.sh       # 4 tests
    inject-context.test.sh        # 3 tests
    validate-state.test.sh        # 2 tests
  integration/
    retell-proxy.test.ts          # MSW mock of Retell API
    whatsapp-proxy.test.ts        # formatGateMessage + parseReply
  prompts/
    sdlc-writer.md                # artifact production prompt
    whatsapp-approve-review.md    # gate approval prompt (Tab 1 reference)
    whatsapp-approve-confirmation.md  # confirmation prompt (Tab 1 reference)
    dev-builder.md                # implementation prompt
    auditor-browser.md            # browser audit prompt
    evaluator.md                  # LLM-as-judge prompt
  e2e/
    full-pipeline.sh              # 10-phase real pipeline test
  fixtures/
    health-endpoint-trigger.json  # seeded Retell-like trigger
```

## Key Dependencies

| Package | Purpose |
|---------|---------|
| `vitest` | Test runner for TS unit + integration |
| `fast-check` | Property-based FSM fuzzing |
| `bats-core` | Shell hook testing |
| `msw` | HTTP-level API mocking (Retell, Twilio, Supabase) |
