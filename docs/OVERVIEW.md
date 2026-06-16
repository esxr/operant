<!-- #core -->
# Operant: Voice-Driven Autonomous Development Pipeline

## Architecture

A **pure Claude Code plugin architecture** where the plugin orchestrates via hooks, agents, and skills — no external orchestrator process. All LLM work is performed by Claude Code agents with phase-specific skills injected via plugin hooks. Phone calls (Retell voice) and WhatsApp messages (Twilio) are the human-in-the-loop mechanisms at every gate, routed by a `ChannelRouter` with complexity classification and timeout escalation. State transitions are **hardcoded** (deterministic FSM with 18 states, 23 events, 15 side effect types — enforced by shell script hooks via `hooks/hooks.json`). Each pipeline phase activates a Claude Code agent with the appropriate skill loaded via hooks; Stop hooks detect filesystem changes and advance the FSM. MCP servers (auditor-browser, supermemory) are directly available to agents within Claude Code's runtime.

### Plugin Structure

```
.claude-plugin/plugin.json    # Plugin manifest (name, version, commands, agents)
hooks/hooks.json               # Hook definitions → shell scripts in scripts/
commands/                      # Slash commands (process, start, status, stop, whitelist)
agents/                        # Agent definitions (auditor.md, dev-builder.md, sdlc-writer.md)
skills/                        # Skills (sdlc-skill, development-methodology, audit-methodology, pipeline-knowledge)
scripts/                       # Hook scripts + infrastructure (startup.sh, tunnel.sh, server.ts, etc.)
src/                           # Core TypeScript modules (state-machine, channel, retell, whatsapp, memory, config, pdf)
src/cli/                       # CLI modules (transition, infer-state, status, whitelist, register-webhook, post-agent-check, process-trigger, trigger-gate)
```

### Hook Architecture

Hooks are defined in `hooks/hooks.json` and execute shell scripts via `${CLAUDE_PLUGIN_ROOT}/scripts/`:

| Hook Event | Matcher | Script | Purpose |
|------------|---------|--------|---------|
| SessionStart | `.*` | `startup.sh` | Initialize pipeline state, ensure data dirs |
| SessionEnd | `.*` | `cleanup.sh` | Clean up resources on session end |
| PreToolUse | `Write\|Edit` | `pre-write-guard.sh` | Guard file writes against spec constraints |
| PreToolUse | `Agent` | `pre-agent-guard.sh` | Guard agent launches against phase rules |
| PostToolUse | `Write\|Edit` | `detect-artifact.sh` | Detect new SDLC artifacts, advance FSM |
| PostToolUse | `Bash` | `check-blockers.sh` | Detect new blockers in dev phase |
| UserPromptSubmit | `.*` | `inject-context.sh` | Inject phase-specific context into prompts |
| Stop | `.*` | `validate-state.sh` | `inferState()` drift detection after agent completes |
| SubagentStop | `.*` | `subagent-complete.sh` | Handle subagent completion events |
| PreCompact | `.*` | `pre-compact.sh` | Preserve critical state before context compaction |
| Notification | `.*` | `notify-phase.sh` | Phase transition notifications |

### Pipeline Flow

```
CALL IN (Retell voice) or WHATSAPP MESSAGE (Twilio)
  ↓
P0: TRIAGE
  ├─ "just confirming done" → exit
  └─ new requirements → save to spec/<name>/REQUIREMENTS.md
        ↓
SPEC PHASE (Claude Code agent with sdlc-skill)
  Intent & Constraints ←→ call/message user for review (reviewedArtifactState tracking)
  HLD ←→ call/message user for review
  ADR ←→ call/message user for review
  Implementation Spec ←→ call/message user for review
  NOTE: REVIEW_APPROVED uses reviewedArtifactState to route:
        intent→hld, hld→adr, adr→eis, eis→dev
        ↓
P1: DEV LOOP
  Claude Code agent with development-methodology skill
  (3-agent methodology: Maintainer → Builder → Police)
        │
        ├─ blocker hit → write spec/<name>/blockers/<blocker>
        │                 agent exits
        │                 Stop hook detects new blocker
        │                 → call/message user → resolve → resume agent via hook
        │                 → loop back
        │
        └─ no blockers → dev complete
              ↓
P2: AUDIT LOOP
  Claude Code agent with audit-methodology skill
  Uses auditor-browser MCP to visually verify against implementation-spec
  Dev server assumed running; if not, spin it up first
        │
        ├─ FAIL → write spec/<name>/revisions/<revision>
        │          → GOTO P1 (dev loop with revision as additional context)
        │
        └─ PASS → transition to DEMO phase
              ↓
P3: DEMO PHASE
  demo_setup → demo_calling → demo_active → demo_feedback
  Google Meet screen share + voice walkthrough for stakeholders
  If demo fails (no Meet creds) → fallback to confirmation
        │
        ├─ DEMO_APPROVED → confirmation
        ├─ DEMO_REJECTED → write revision → GOTO P1
        └─ DEMO_SKIPPED/DEMO_FAILED → confirmation (fallback)
              ↓
P4: CONFIRMATION
  Call/message user: "Are you satisfied?"
  User says "satisfied" → complete → idle (back to P0)
  User says "not satisfied" → voice agent extracts pain points
                               → new revision written
                               → GOTO P1
```

## Phase Details

### P0: Triage

**Trigger:** Inbound call completes, webhook fires, trigger file lands in `spec/.operant/pending/`.

**Logic (hardcoded via `/operant:process` command -- ADR-012):**
1. Read the transcript/analysis from the trigger file (entirely in hook script code, no separate LLM)
2. `classifyTranscript()` with improved heuristics:
   - `call_analysis` checked BEFORE empty transcript check (authoritative)
   - Expanded requirement keywords for broader matching
   - Stricter confirmation matching (reduces false positives)
   - Non-trivial transcripts (>20 chars) default to "requirements" not "unknown"
3. If confirmation → exit pipeline, mark current spec as complete
4. If new requirements → proceed
5. Derive a spec name (kebab-case slug) from the requirements
6. Create `spec/<name>/REQUIREMENTS.md` with the raw requirements from the call
7. Activate Claude Code agent with sdlc-skill for intent phase

### SDLC Phase (spec creation)

**Trigger (hardcoded):** New folder created in `spec/`.

**Agent:** `sdlc-writer.md` agent activated with sdlc-skill via plugin hooks.

**Input:** `spec/<name>/REQUIREMENTS.md`

**Process:**
1. Agent reads REQUIREMENTS.md
2. Produces `spec/<name>/intent-and-constraints.md`
3. **Contacts user** for review (via ChannelRouter — voice for complex, WhatsApp for simple with timeout escalation)
4. User approves or requests changes → agent revises
5. Agent produces `spec/<name>/high-level-design.md`
6. **Contacts user** for review
7. User approves → agent produces `spec/<name>/adr-lite.md`
8. **Contacts user** for review
9. User approves → agent produces `spec/<name>/implementation-spec.md`
10. **Contacts user** for final review
11. User approves → SDLC phase complete, trigger P1

**Each stage has a channel-routed review gate.** 4 interactions total (one per SDLC artifact). `CallMode` determines routing: `review` defaults to WhatsApp (simple), escalates to voice on timeout.

### P1: Dev Loop

**Trigger (hardcoded):** Implementation spec approved.

**Agent:** `dev-builder.md` agent with development-methodology skill (3-agent build methodology: Maintainer → Builder → Police).

**Input:** All specs in `spec/<name>/` + any revisions from `spec/<name>/revisions/` as additional context.

**Process:**
1. Agent reads implementation-spec (and any revision context)
2. Spawns Maintainer → sets up infra
3. Spawns Builder(s) → implements code
4. Spawns Police → verifies implementation
5. If a blocker is encountered at any point:
   - Write blocker to `spec/<name>/blockers/<blocker_name>.md`
   - Agent exits
6. If no blockers → dev loop complete, trigger P2

**Blocker escalation (hardcoded via 4-layer detection -- ADR-010):**
1. PostToolUse hook (`detect-artifact.sh`) — BLOCKING on spec file writes (catches blocker file creation)
2. Stop hook (`validate-state.sh`) — `inferState()` drift detection after agent completes
3. 10-minute timer — safety net polling
4. `advance-pipeline` tool — escape hatch for agents

- If new blocker found → contact user via ChannelRouter (`blocker` mode defaults to voice/complex)
- After call → user's resolution is captured
- Resume Claude Code agent with resolution context via hook
- Dev loop continues

**Mock auto-approve (testing):** When `SECONDAXIS_MOCK=1` or no API credentials, review gates are auto-approved and next agent run triggered via hook.

### P2: Audit Loop

**Trigger (hardcoded):** Dev loop completes without blockers.

**Agent:** `auditor.md` agent with audit-methodology skill (Police/QA methodology using visual verification).

**Tools:** Uses `auditor-browser` MCP (directly available to the agent, configured in `.mcp.json`) to:
- Navigate to the running app (dev server assumed running; if not, spin it up)
- Visually verify the implementation against `spec/<name>/implementation-spec.md`
- Check each functional requirement is met
- Screenshot proof

**If FAIL:**
- Write revision spec to `spec/<name>/revisions/<revision_name>.md`
- Describe what failed, what the expected behavior was, what was observed
- **GOTO P1** — dev loop runs again with the revision as additional context on top of the original implementation-spec

**If PASS (`AUDIT_PASSED`):**
- Transition to `demo_setup` (not directly to confirmation)
- Demo phase attempts Google Meet screen share + voice walkthrough
- If demo infra unavailable (`DEMO_FAILED`) → fallback to `confirmation`

### P3: Demo Phase

**Trigger (hardcoded):** Audit passes.

**States:** `demo_setup` → `demo_calling` → `demo_active` → `demo_feedback`

**Process:**
1. `demo_setup`: Create demo environment (`CREATE_DEMO` side effect)
2. `DEMO_READY` → `demo_calling`: Trigger demo invite call (`TRIGGER_DEMO_INVITE_CALL` with Meet URL + code)
3. `USER_JOINED_MEET` → `demo_active`: Start walkthrough (`START_WALKTHROUGH`)
4. `WALKTHROUGH_COMPLETE` → `demo_feedback`: Capture feedback (`CAPTURE_FEEDBACK`)

**Outcomes:**
- `DEMO_APPROVED` → `confirmation`
- `DEMO_REJECTED` → `dev` (with `WRITE_DEMO_REVISION` + `TEARDOWN_DEMO`)
- `DEMO_SKIPPED` → `confirmation` (with `TEARDOWN_DEMO`)
- `DEMO_FAILED` → `confirmation` (fallback when Meet creds unavailable)

### P4: Confirmation

**Trigger (hardcoded):** Demo approved/skipped/failed, or direct transition.

**Process:**
- Contact user via ChannelRouter (`confirmation` mode defaults to WhatsApp/simple): "The feature has been built and verified. Are you satisfied?"
- If yes (`USER_CONFIRMED`) → `complete` → `RESET` → `idle` (back to P0)
- If no (`USER_REJECTED`) → voice agent probes for pain points → new revision written → **GOTO P1**

## File Structure

```
spec/
└── <feature-name>/
    ├── REQUIREMENTS.md              # Raw requirements from voice call (P0)
    ├── intent-and-constraints.md    # SDLC Phase 1
    ├── high-level-design.md         # SDLC Phase 2
    ├── adr-lite.md                  # SDLC Phase 3
    ├── implementation-spec.md       # SDLC Phase 4
    ├── blockers/                    # Blocker reports (P1)
    │   ├── missing-api-key.md
    │   └── design-decision.md
    └── revisions/                   # Audit revisions (P2 → P1)
        ├── button-not-visible.md
        └── wrong-color-scheme.md
```

## Skills / Prompt Content

| Skill | Location | Used By | Delivery |
|-------|----------|---------|----------|
| `sdlc-skill` | `skills/sdlc-skill/SKILL.md` | SDLC phase (`sdlc-writer.md` agent) | Loaded via plugin hooks into agent context |
| `development-methodology` | `skills/development-methodology/SKILL.md` | P1 dev phase (`dev-builder.md` agent) | Loaded via plugin hooks into agent context |
| `audit-methodology` | `skills/audit-methodology/SKILL.md` | P2 audit phase (`auditor.md` agent) | Loaded via plugin hooks into agent context |
| `pipeline-knowledge` | `skills/pipeline-knowledge/SKILL.md` | All phases (context injection) | Loaded via `inject-context.sh` on UserPromptSubmit |

## Key Design Principles

1. **HARDCODED transitions** — Phase changes are deterministic code (18 states, 23 events), not LLM decisions
2. **Pure Plugin Architecture** — Claude Code plugin orchestrates via `hooks/hooks.json` shell scripts, agents, and skills. All LLM work is performed by Claude Code agents. No external orchestrator.
3. **Multi-channel gates** — Human reviews via ChannelRouter: voice (Retell) for complex interactions, WhatsApp (Twilio) for simple with timeout escalation to voice. 5 `CallMode`s: requirements, blocker, review, confirmation, demo_invite.
4. **File-based state** — FSM state in `spec/.operant/current-state.txt`, active spec in `spec/.operant/active-spec.txt`, artifacts in `spec/` folder structure
5. **Dynamic voice agent** — Retell LLM uses `{{variables}}` so each call has the right context
6. **Revision accumulation** — Revisions stack as additional context, never replace the original spec
7. **Exit only on confirmation** — Pipeline loops until the user explicitly says "done"
8. **Defense-in-depth transitions** — 4 layers: PostToolUse hook (`detect-artifact.sh`), Stop hook (`validate-state.sh`), 10-min timer, advance-pipeline tool
9. **`reviewedArtifactState` tracking** — Correct review routing: intent->hld, hld->adr, adr->eis, eis->dev
10. **Semantic memory** — Supermemory integration (`src/memory.ts`) for cross-session context via MCP

## Core Modules

| Module | File | Purpose |
|--------|------|---------|
| State Machine | `src/state-machine.ts` | 18 states, 23 events, 15 side effect types. Pure functions, no I/O. |
| Config | `src/config.ts` | `OPERANT_PI_DATA_DIR`, `OPERANT_PI_SPECS_DIR`, `OPERANT_PI_PROJECT_ROOT` env vars. State I/O (`current-state.txt`, `active-spec.txt`). |
| Channel Router | `src/channel.ts` | Routes gates to voice or WhatsApp by complexity. Timeout escalation. |
| Retell (voice) | `src/retell.ts` | Retell.ai API client. 5 `CallMode`s with dynamic variables. |
| WhatsApp | `src/whatsapp.ts` | Twilio WhatsApp channel. Outbound messages + inbound reply handling. |
| Memory | `src/memory.ts` | Supermemory HTTP client for cross-session context. |
| PDF | `src/pdf.ts` | PDF generation for spec artifacts. |
| Server | `scripts/server.ts` | Webhook handler for Retell call-completed events. |
| Tunnel | `scripts/tunnel.sh` | Cloudflared tunnel lifecycle management. |

## Validated Test Results

- Full E2E pipeline: 16/16 transitions, PASS
- `--detailed` test: 11 transitions, 4 review calls, all artifacts written, PASS
- Full SDLC cycle: intent → review → hld → review → adr → review → eis → review → dev
- Dev/Audit loop integration: 9/9 tests PASS
- Unit FSM tests: 59/59 PASS
