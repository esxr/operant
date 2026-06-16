# Handoff: Operant Development Status

**Date:** 2026-06-06  
**Session:** secondaxis (Claude Code session building the voice-driven dev pipeline)  
**Context exhausted:** Yes — this document is the continuation brief for the next session.

---

## What Exists

Operant is a Claude Code plugin at `/Users/pranav/Desktop/operant/` that implements a voice-driven autonomous development pipeline. Phone calls are the human-in-the-loop mechanism at every gate.

### Core Files

| File | Status |
|------|--------|
| `hooks/hooks.json` | Working — 9 hook event types pointing to shell scripts in `scripts/` |
| `src/state-machine.ts` | Working — 18 states, 23 events, 15 side effect types, pure functions |
| `src/config.ts` | Working — `OPERANT_PI_DATA_DIR` env var, state I/O (`current-state.txt`, `active-spec.txt`) |
| `src/channel.ts` | Working — ChannelRouter with complexity classification + timeout escalation |
| `src/retell.ts` | Working — 5 call modes (requirements, blocker, review, confirmation, demo_invite), dynamic variables |
| `src/whatsapp.ts` | Working — Twilio WhatsApp channel (outbound + inbound reply handling) |
| `src/memory.ts` | Working — Supermemory HTTP client for cross-session context |
| `src/pdf.ts` | Working — PDF generation for spec artifacts |
| `scripts/server.ts` | Working — webhook handler for Retell call-completed events |
| `scripts/tunnel.sh` | Working — cloudflared tunnel lifecycle |
| `src/cli/*.ts` | Working — 8 CLI modules (transition, infer-state, status, whitelist, register-webhook, post-agent-check, process-trigger, trigger-gate) |

### Plugin Components

| Component | Files |
|-----------|-------|
| Manifest | `.claude-plugin/plugin.json` |
| Commands | `commands/` — process, start, status, stop, whitelist |
| Agents | `agents/` — auditor.md, dev-builder.md, sdlc-writer.md |
| Skills | `skills/` — sdlc-skill, development-methodology, audit-methodology, pipeline-knowledge |
| Hooks | `hooks/hooks.json` → `scripts/` (startup.sh, cleanup.sh, pre-write-guard.sh, pre-agent-guard.sh, detect-artifact.sh, check-blockers.sh, inject-context.sh, validate-state.sh, subagent-complete.sh, pre-compact.sh, notify-phase.sh) |

### Infrastructure

| Component | Details |
|-----------|---------|
| Retell.ai account | pranav@dhoolia.com, API key in Bitwarden "Retell.ai" |
| Retell Agent | `agent_fd50bd6b1cf61664e75e2a8dd9` |
| Retell LLM | `llm_1ec9eabfb59815dc7ca62d9f6f1e` (gpt-4o-mini) |
| Retell Phone | `+14482173844` |
| API Key | `$RETELL_API_KEY` |
| Project target | `/Users/pranav/Desktop/pegg.app` (the app being developed) |

---

## What Works (Verified)

### SDLC Spec Phase
- Inbound call -> webhook (`scripts/server.ts`) -> triage -> REQUIREMENTS.md -> agent writes intent doc
- PostToolUse hook (`detect-artifact.sh`) detects artifact -> FSM fires `ARTIFACT_PRODUCED` -> `TRIGGER_REVIEW_CALL`
- Mock: auto-approves review, activates Claude Code agent for next phase
- Real: ChannelRouter sends gate (WhatsApp for review mode, voice for complex) with `{{artifact_summary}}` dynamic variable
- Correct routing via `reviewedArtifactState`: intent->hld, hld->adr, adr->eis, eis->dev
- Each review call shows artifact-specific content (headings + first paragraph)
- Test result: 11 transitions, 4 review calls, PASS

### Triage
- `classifyTranscript()` correctly identifies requirements vs confirmation vs unknown
- call_analysis checked before empty transcript (fixes the Retell payload issue)
- Expanded keywords, stricter confirmation matching
- Non-trivial transcripts (>20 chars) default to "requirements"

---

## What Needs Work

### 1. P1: Dev Loop (NOT YET TESTED END-TO-END)

The dev phase activates the `dev-builder.md` agent with the development-methodology skill, but the full cycle hasn't been tested:

**What should happen:**
1. After EIS approved -> FSM transitions to `dev`
2. `dev-builder.md` agent activated with dev-methodology prompt + implementation-spec content
3. Agent implements code in target project
4. If blocker: writes `spec/<name>/blockers/<blocker>.md`, exits
5. PostToolUse hook (`check-blockers.sh`) detects blocker -> FSM fires `BLOCKER_DETECTED` -> `TRIGGER_BLOCKER_CALL`
6. ChannelRouter contacts user (blocker mode = voice/complex) -> user resolves -> new agent activated
7. If no blockers: Stop hook (`validate-state.sh`) fires `DEV_COMPLETE` -> transitions to `audit`

**Known issues:**
- The dev prompt reads the implementation-spec and passes it to the agent. The prompt may need refinement — it should tell the agent to read the spec from the spec dir, not inline it.
- Revision context (from `spec/<name>/revisions/`) needs to be included in the prompt when re-entering dev after audit failure.
- Blocker detection in `check-blockers.sh` uses `detectNewBlockers()` which compares file lists. The `knownBlockers` array needs to be populated correctly before activation.

### 2. P2: Audit Loop (NOT YET TESTED)

The audit phase activates the `auditor.md` agent with the audit-methodology skill, but hasn't been tested:

**What should happen:**
1. After dev complete -> FSM transitions to `audit`
2. `auditor.md` agent activated with audit-methodology prompt
3. Agent uses the `auditor-browser` MCP (headless Playwright) to visually verify
4. If fail: writes `spec/<name>/revisions/<revision>.md`, exits
5. Stop hook (`validate-state.sh`) detects revision -> FSM fires `AUDIT_FAILED` -> back to P1
6. If pass: Stop hook fires `AUDIT_PASSED` -> transitions to `demo_setup`
7. Demo phase runs (or falls back to confirmation if Meet creds unavailable)
8. ChannelRouter contacts user for confirmation

**Known issues:**
- The audit prompt needs the `auditor-browser` MCP config. Check the target project's `.mcp.json` for the auditor-browser setup (headless Playwright, 1280x720, devtools caps).
- Need to verify whether MCP servers from `.mcp.json` are available to the agent during execution.
- The dev server must be running for audit. The prompt tells the auditor to spin it up if not running.

### 3. Confirmation Flow (MOCK TESTED ONLY)

The `--confirm` harness test passes in mock mode. Real confirmation gates haven't been tested via either channel. The voice agent prompt has the confirmation mode (`{{call_mode}} = "confirmation"`) with pain point extraction. ChannelRouter defaults confirmation to WhatsApp (simple) with timeout escalation to voice.

### 4. Retell Agent Publishing

Every time the cloudflared tunnel restarts, the tunnel URL changes. The webhook URL must be updated AND the agent must be republished:

```bash
curl -s -X PATCH "https://api.retellai.com/update-agent/agent_fd50bd6b1cf61664e75e2a8dd9" \
  -H "Authorization: Bearer $RETELL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"webhook_url": "<new-tunnel-url>/webhook/call-completed"}'

curl -s -X POST "https://api.retellai.com/publish-agent/agent_fd50bd6b1cf61664e75e2a8dd9" \
  -H "Authorization: Bearer $RETELL_API_KEY" \
  -H "Content-Type: application/json" -d '{}'
```

The `/operant:start` command (via `scripts/tunnel.sh` + `src/cli/register-webhook.ts`) updates the webhook URL but only updates the draft — it doesn't publish. Consider adding auto-publish after webhook registration.

### 5. Spec Name Derivation

`deriveSpecName()` sometimes produces bad names like `the-user-called-to-provide-instructions-regarding` — it's using the `call_summary` instead of `feature_name` from Retell's analysis. The priority in `src/cli/process-trigger.ts` should be: `feature_name` > `feature_title` > truncated `call_summary`.

---

## Architecture Summary

```
Pure Claude Code plugin architecture:
  hooks/hooks.json → shell scripts orchestrate
  agents/ (auditor.md, dev-builder.md, sdlc-writer.md) do LLM work
  skills/ provide phase-specific context

Call -> Retell -> webhook -> cloudflared -> scripts/server.ts -> trigger file in spec/.operant/pending/
  -> /operant:process command -> src/cli/process-trigger.ts
  -> classifyTranscript() -> create spec dir + REQUIREMENTS.md
  -> agent activation (sdlc-writer.md with sdlc-skill) -> agent completes
  -> PostToolUse hook (detect-artifact.sh) checks filesystem -> ARTIFACT_PRODUCED -> sdlc_review
  -> TRIGGER_REVIEW_CALL -> ChannelRouter (WhatsApp or voice) with {{artifact_summary}}
  -> user approves -> REVIEW_APPROVED -> next SDLC phase (via reviewedArtifactState)
  -> ... repeat for HLD, ADR, EIS
  -> EIS approved -> dev phase -> dev-builder.md agent ("implement...")
  -> ... blocker loop / audit loop / demo / confirmation
```

### 4 Layers of Transition Detection (ADR-010)

1. PostToolUse hook (`detect-artifact.sh`) — BLOCKING on spec file writes
2. Stop hook (`validate-state.sh`) — `inferState()` drift detection
3. 10-minute timer — safety net polling
4. `advance-pipeline` tool — escape hatch

The PostToolUse and Stop hooks are the primary detection mechanisms.

### Key Functions

| Function | File | Purpose |
|----------|------|---------|
| `processTriggerFile()` | src/cli/process-trigger.ts | Handles trigger entirely in hook code, no LLM |
| `transition()` | src/state-machine.ts | Pure FSM transition table (18 states, 23 events) |
| `inferState()` | src/state-machine.ts | Filesystem-based crash recovery |
| `classifyTranscript()` | src/state-machine.ts | Keyword heuristics for triage |
| `ChannelRouter.sendGate()` | src/channel.ts | Routes gates to voice or WhatsApp by complexity |
| `readState()` / `writeState()` | src/config.ts | State persistence via `current-state.txt` |
| `readActiveSpec()` / `writeActiveSpec()` | src/config.ts | Active spec persistence via `active-spec.txt` |

---

## Bugs Fixed This Session

1. **classifyTranscript returned "unknown" for valid calls** — call_analysis not checked before empty transcript guard
2. **reviewedArtifactState not tracked** — added tracking when entering sdlc_review
3. **Review calls skipped HLD/ADR/EIS** — REVIEW_APPROVED now uses reviewedArtifactState for routing
4. **All reviews showed intent content** — detect-artifact.sh scanned all artifacts; fixed to check only the expected artifact for current state
5. **Whitelist missing at project path** — created at spec/.operant/whitelist.json
6. **Mock reviews not auto-approving** — added setTimeout with auto-approve + next agent activation
7. **No artifact summary in review calls** — reads actual file content (headings + first paragraph)

---

## Files Modified in pegg.app

The pipeline made real code changes to pegg.app during a live test (from a phone call about "user testing" Notion notes). These changes are uncommitted:

```bash
cd /Users/pranav/Desktop/pegg.app && git diff --stat
```

17 files modified (search, item-detail, wardrobe, pricing components). Review before committing.

---

## Next Steps (Priority Order)

1. **Test P1 dev loop end-to-end** — pre-create spec artifacts, trigger dev phase, verify dev-builder.md agent implements code and detect-artifact.sh/validate-state.sh hooks detect completion
2. **Test P2 audit loop** — verify auditor.md agent with auditor-browser MCP can visually verify, and revision -> dev loop works
3. **Test real channel gates** — remove SECONDAXIS_MOCK, verify ChannelRouter sends WhatsApp / makes Retell calls at each gate
4. **Add auto-publish to `/operant:start`** — after webhook registration via register-webhook.ts, publish the agent
5. **Fix spec name derivation** — prioritize feature_name over call_summary in process-trigger.ts
6. **Test demo phase** — demo_setup → demo_calling → demo_active → demo_feedback flow with Google Meet

---

## Memory Pointers

Check these memory files for context:
- `~/.claude/projects/-Users-pranav-Desktop-pegg-app/memory/project_operant_pi.md`
- `~/.claude/projects/-Users-pranav-Desktop-pegg-app/memory/project_voice_pipeline.md`

## Key Lessons

- `LESSONS.md` in pegg.app has the 3-agent methodology and all operational learnings
- User preference: always set 2-min bash timers when background agents run
- User preference: delegate everything to subagents, CEO doesn't implement
- Demo phase (P3) added with 4 states: demo_setup, demo_calling, demo_active, demo_feedback
- WhatsApp channel (`src/whatsapp.ts`) added with ChannelRouter complexity routing and timeout escalation
- State persisted as plain text files (`current-state.txt`, `active-spec.txt`) in `spec/.operant/`, not JSON
