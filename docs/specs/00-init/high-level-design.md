<!-- #core -->
# High-Level Design: Operant

**Version:** 5.0  
**Date:** 2026-06-10  
**Status:** Under Review  
**Changes from v4.0:** Channel abstraction (ADR-012): voice + WhatsApp routing with timeout escalation. Demo phase (ADR-013) between audit and confirmation: demo_setup, demo_calling, demo_active, demo_feedback. WhatsApp channel (Twilio), Supermemory context layer, PDF converter for WhatsApp media. Updated FSM to 18 states / 24 events / 15 side effects. Hook scripts enumerated. Module dependencies updated to reflect actual file layout.  
**Changes from v3.0:** Pure plugin architecture (ADR-011): Claude Code IS the runtime. No external orchestrator or subprocesses. Pipeline phases executed by Claude Code agents with skills injected via hooks (PreToolUse/PostToolUse/Stop). FSM driven by hook callbacks detecting filesystem changes.  
**Changes from v2.0:** Hook+state driven pipeline (ADR-010). `/operant process` command. `reviewedArtifactState` tracking. Mock auto-approve for testing.  
**Changes from v1.0:** Incorporated ADR-001 through ADR-009. Refined architecture based on TypeScript debate and structural evaluation.

## 1. Overview

Operant is a Claude Code plugin that implements a fully autonomous development pipeline driven by phone calls. A user calls in with a feature idea, and the system autonomously produces specs, implements code, audits it visually, runs a live demo, and only contacts the user at review gates or blockers. Human-in-the-loop gates are routed through a channel abstraction layer (`channel.ts`) that classifies gate complexity and dispatches to voice (Retell) or WhatsApp (Twilio), with timeout escalation from WhatsApp to voice. State transitions between phases are hardcoded in TypeScript within plugin hooks; Claude Code IS the runtime — agents run within Claude Code's own execution environment with skills injected via hooks (PreToolUse/PostToolUse/Stop). The FSM runs inside the plugin, driven by hook callbacks that detect filesystem changes. MCP servers (e.g., auditor-browser, supermemory) are directly available to agents via the plugin's `.mcp.json` configuration.

## 2. Goals and Non-Goals

### Goals

- Phone-only interface for the human — no chat, no terminal
- Deterministic state machine controlling phase transitions
- File-based state in `spec/` for resumability and inspectability
- 4 call-based review gates per spec (one per SDLC artifact)
- Autonomous dev → audit → demo → revision loop until user confirms
- Multi-channel gates: voice for complex decisions, WhatsApp for simple approvals

### Non-Goals

- Deployment automation (separate concern, existing Vercel infra)
- Multi-user concurrency (single-user, single-spec-at-a-time for v1)
- Chat-based fallback interface
- Custom voice agent training (using Retell's hosted LLM with dynamic variables)

## 3. System Architecture

### Component Diagram

```
                           ┌─────────────────────┐
                           │    User's Phone      │
                           └──────┬───────┬───────┘
                                  │ PSTN  │ WhatsApp
                           ┌──────▼───────┤
                           │  Retell.ai   │   ┌───────────────────┐
                           │  Voice Agent │   │ Twilio WhatsApp   │
                           │  (gpt-4o-   │   │ (sandbox/prod)    │
                           │   mini)      │   └─────────┬─────────┘
                           │ {{dynamic_  │              │
                           │  variables}}│              │
                           └──────┬──────┘              │
                                  │ Webhook (HTTPS)     │ Webhook (HTTPS)
                           ┌──────▼─────────────────────▼─────────────────┐
                           │           Cloudflared Tunnel                  │
                           └──────────────────┬───────────────────────────┘
                                              │ localhost:3456
┌─────────────────────────────────────────────▼───────────────────────────┐
│                        Operant Plugin (Claude Code)                      │
│                                                                          │
│  ┌──────────────┐    ┌──────────────────┐    ┌────────────────────────┐ │
│  │ Webhook      │FS  │ State Machine    │    │ Claude Code Agent      │ │
│  │ Server       │───▶│ (state-machine.ts│───▶│ (runs in CC runtime)   │ │
│  │ (scripts/    │    │  hardcoded FSM)  │    │                        │ │
│  │  server.ts)  │    └──────┬───────────┘    │ Skills injected via    │ │
│  └──────────────┘           │                │ hooks per phase        │ │
│         │            ┌──────▼──────┐         │                        │ │
│         │            │ Plugin      │         │ PostToolUse/Stop hooks │ │
│         │            │ Hooks       │         │ detect FS changes,     │ │
│         │            │ (hooks.json │         │ advance FSM            │ │
│         │            │  + scripts/)│         └────────────────────────┘ │
│  ┌──────▼──────┐     └──────┬──────┘                                    │
│  │ Channel     │            │                                           │
│  │ Router      │◀───────────┘                                           │
│  │(channel.ts) │  outbound gates                                        │
│  ├─────┬───────┤                                                        │
│  │Voice│WhatsAp│         ┌────────────────────────┐                     │
│  │Retell│Twilio│         │ spec/<feature>/         │                     │
│  └──┬──┴──┬───┘         │  REQUIREMENTS.md        │                     │
│     │     │              │  intent-and-constr.md   │                     │
│  ┌──▼─────▼──┐           │  high-level-design.md   │                     │
│  │retell.ts  │           │  adr-lite.md            │                     │
│  │whatsapp.ts│           │  implementation-spec.md │                     │
│  │pdf.ts     │           │  blockers/              │                     │
│  └───────────┘           │  revisions/             │                     │
│                          └────────────────────────┘                     │
│  ┌─────────────┐                                                        │
│  │ Tunnel      │         ┌─────────────┐                                │
│  │ (scripts/   │         │ .operant/   │                                │
│  │  tunnel.sh) │         │  calls/     │                                │
│  └─────────────┘         │  pending/   │                                │
│                          │  processed/ │                                │
│  ┌─────────────┐         │  media/     │                                │
│  │ MCP Servers │         │  *.pid      │                                │
│  │ (.mcp.json) │         │  current-   │                                │
│  │ auditor-    │         │   state.txt │                                │
│  │ browser,    │         │  active-    │                                │
│  │ supermemory │         │   spec.txt  │                                │
│  └─────────────┘         └─────────────┘                                │
│                                                                          │
│  ┌─────────────┐                                                        │
│  │ Memory      │                                                        │
│  │(memory.ts)  │──────▶ Supermemory API                                 │
│  └─────────────┘                                                        │
└─────────────────────────────────────────────────────────────────────────┘
```

### Component Descriptions

| Component | Responsibility | Key Interfaces |
| --- | --- | --- |
| Webhook Server (`scripts/server.ts`) | Receives Retell and Twilio webhooks, writes trigger files to `spec/.operant/pending/`, serves PDF media via tunnel URL | HTTP POST, filesystem trigger files, static media serving |
| State Machine (`src/state-machine.ts`) | Hardcoded FSM (18 states, 24 events, 15 side effects). Phase inference from filesystem, blocker detection. Tracks `reviewedArtifactState` for review routing. Demo phase between audit and confirmation. | Exports `stateToPhase()`, `transition()`, `inferState()` |
| Plugin Hooks (`hooks/hooks.json` + `scripts/*.sh`) | Bash script hooks orchestrate pipeline. Detect filesystem changes, inject skill context, advance FSM, trigger next phase agents. 11 hook scripts across 8 hook events. | Claude Code Hook API (SessionStart, SessionEnd, PreToolUse, PostToolUse, UserPromptSubmit, Stop, SubagentStop, PreCompact, Notification) |
| Claude Code Agents (`agents/`) | All LLM work — spec writing (`sdlc-writer`), dev (`dev-builder`), audit (`auditor`). Run within Claude Code's own runtime with phase-specific skill context injected via hooks. | Claude Code runtime, filesystem artifacts |
| Channel Router (`src/channel.ts`) | Classifies gate complexity (simple/complex), routes to voice or WhatsApp, manages timeout escalation from WhatsApp to voice | `sendGate()`, complexity classification, configurable timeouts |
| Retell Client (`src/retell.ts`) | Voice channel: outbound calls with `retell_llm_dynamic_variables`. 5 call modes: requirements, blocker, review, confirmation, demo_invite. | Retell REST API, `Channel` interface |
| WhatsApp Client (`src/whatsapp.ts`) | WhatsApp channel: outbound Twilio messages with structured reply options. Waits for inbound replies via webhook. | Twilio REST API, `Channel` interface |
| PDF Converter (`src/pdf.ts`) | Converts markdown artifacts to PDF for WhatsApp media attachments. Serves via cloudflared tunnel URL. | `md-to-pdf`, filesystem output |
| Supermemory Client (`src/memory.ts`) | Context layer: stores and retrieves project memory via Supermemory HTTP API | Supermemory REST API |
| Tunnel Manager (`scripts/tunnel.sh`) | Cloudflared lifecycle: start, health-check, stop | `cloudflared` CLI, PID files |
| Voice Agent (Retell) | Phone conversations — `{{call_mode}}` switches between requirements/blocker/review/confirmation/demo_invite | Retell LLM with dynamic variables |
| MCP Servers (`.mcp.json`) | External tool servers: `auditor-browser` (Playwright headless), `my-browser` (CDP debug), `context7` (docs), `supermemory` (memory) | MCP protocol, configured at plugin level |
| Config (`src/config.ts`) | Shared configuration: `OPERANT_PI_DATA_DIR`, state file I/O (`current-state.txt`, `active-spec.txt`), project root resolution | Environment variables, filesystem |
| CLI Commands (`commands/`) | 5 commands: `/operant start` (pipeline), `/operant stop`, `/operant status`, `/operant whitelist`, `/operant process` (trigger handling) | Plugin command frontmatter |

### Module Dependency Graph

```
hooks/hooks.json
  └── scripts/ (bash hooks)
        ├── startup.sh           SessionStart: init data dirs, PID cleanup
        ├── cleanup.sh           SessionEnd: kill server + tunnel
        ├── pre-write-guard.sh   PreToolUse(Write|Edit): phase write guards
        ├── pre-agent-guard.sh   PreToolUse(Agent): agent launch validation
        ├── detect-artifact.sh   PostToolUse(Write|Edit): artifact detection
        ├── check-blockers.sh    PostToolUse(Bash): blocker file detection
        ├── inject-context.sh    UserPromptSubmit: phase context injection
        ├── validate-state.sh    Stop: FSM drift detection, next phase trigger
        ├── subagent-complete.sh SubagentStop: agent completion handling
        ├── pre-compact.sh       PreCompact: state preservation
        ├── notify-phase.sh      Notification: phase change notifications
        └── _resolve-data-dir.sh (shared helper)

src/
  ├── state-machine.ts   FSM logic, pure functions + filesystem
  ├── config.ts          State I/O (current-state.txt, active-spec.txt)
  ├── channel.ts         Channel router (complexity + timeout escalation)
  │     ├── retell.ts    Voice channel (Retell API)
  │     └── whatsapp.ts  WhatsApp channel (Twilio API)
  │           └── pdf.ts PDF generation for WhatsApp media
  ├── memory.ts          Supermemory HTTP client
  └── retell.ts          Retell API client (also used standalone)

scripts/
  ├── server.ts          Webhook HTTP server (standalone process)
  └── tunnel.sh          Cloudflared tunnel lifecycle

skills/
  ├── sdlc-skill/         SDLC artifact production methodology
  ├── development-methodology/  Dev phase coding methodology
  ├── audit-methodology/  Visual audit methodology
  └── pipeline-knowledge/ Pipeline state and behavior reference

agents/
  ├── sdlc-writer.md     Spec artifact production agent
  ├── dev-builder.md     Development agent
  └── auditor.md         Visual audit agent
```

## 4. Data Flow

### Flow A: Inbound Call → Spec Creation

```
1. User calls +1(448)217-3844
2. Retell voice agent gathers requirements (call_mode=requirements)
3. Call ends → Retell fires call_analyzed webhook
4. Webhook hits cloudflared tunnel → localhost:3456
5. scripts/server.ts parses payload, writes trigger to spec/.operant/pending/
6. Next hook invocation detects pending trigger file
7. /operant process command handles trigger:
   a. classifyTranscript() — call_analysis checked BEFORE empty transcript
   b. Expanded requirement keywords, stricter confirmation matching
   c. Non-trivial transcripts (>20 chars) default to "requirements" not "unknown"
   d. Creates spec/<name>/REQUIREMENTS.md
8. Hook activates Claude Code agent with sdlc-skill context for intent phase
9. Agent produces intent doc within Claude Code runtime
10. PostToolUse hook (detect-artifact.sh) detects artifact write (BLOCKING)
11. Hook triggers outbound gate via ChannelRouter:
    - ChannelRouter classifies review as "simple" → WhatsApp first
    - WhatsApp sends summary + PDF attachment via Twilio
    - If WhatsApp times out (10 min) → escalates to voice call
12. FSM saves previousState as reviewedArtifactState on entering sdlc_review
13. User approves → REVIEW_APPROVED uses reviewedArtifactState to route:
    intent→hld, hld→adr, adr→eis, eis→dev
14. Stop hook (validate-state.sh) activates next phase agent
15. Repeat for HLD, ADR, EIS
16. EIS approved → state machine transitions to dev
```

### Flow B: Blocker Escalation

```
1. Dev agent encounters blocker
2. Writes spec/<name>/blockers/<blocker>.md
3. Dev agent exits
4. Stop hook (validate-state.sh) fires → state machine detects new blocker file
5. ChannelRouter classifies blocker as "complex" → voice call
   - Hook triggers outbound call (call_mode=blocker, details in {{variables}})
6. User resolves blocker on the call
7. Call ends → webhook → trigger file written to spec/.operant/pending/
8. Next hook invocation detects trigger, processes resolution
9. Stop hook re-activates dev agent with resolution context
```

### Flow C: Audit → Demo → Confirmation

```
1. Dev loop completes (no new blockers)
2. State machine transitions to audit
3. Stop hook (validate-state.sh) injects audit-methodology skill context
4. inject-context.sh injects: "Phase: audit. Verify against implementation-spec."
5. Audit agent uses auditor-browser MCP (directly available) → tests each FR visually
6. Audit fails → writes spec/<name>/revisions/<revision>.md
7. State machine transitions to audit_failed, then REVISION_READY → dev
8. Loop until audit passes
9. AUDIT_PASSED → demo_setup (NOT directly to confirmation)
10. Demo phase:
    a. demo_setup: CREATE_DEMO side effect prepares live environment
    b. DEMO_READY → demo_calling: outbound call (call_mode=demo_invite)
       with Google Meet URL and access code in {{variables}}
    c. USER_JOINED_MEET → demo_active: START_WALKTHROUGH guided demo
    d. WALKTHROUGH_COMPLETE → demo_feedback: CAPTURE_FEEDBACK
    e. DEMO_APPROVED → confirmation: teardown demo, trigger confirmation gate
       DEMO_REJECTED → dev: WRITE_DEMO_REVISION with pain points, teardown,
       re-enter dev loop with revision context
    f. DEMO_FAILED/DEMO_SKIPPED → confirmation: graceful fallback
11. Confirmation gate via ChannelRouter (classified "simple" → WhatsApp):
    - User confirms → spec complete, STATUS marker written → idle
    - User rejects → voice agent extracts pain points → dev loop
```

### Flow D: WhatsApp Gate Interaction

```
1. ChannelRouter receives gate context with CallMode
2. classifyComplexity() checks:
   a. Env override: CHANNEL_OVERRIDE_<mode>=voice|whatsapp
   b. Default mapping: confirmation/review/demo_invite → simple (WhatsApp)
      blocker/requirements → complex (voice)
3. Simple gate → WhatsApp path:
   a. whatsapp.ts formats message with structured reply options
   b. If artifact attached: pdf.ts converts markdown → PDF
   c. PDF served via tunnel URL (scripts/server.ts /media/ endpoint)
   d. Twilio sends outbound WhatsApp with PDF media URL
   e. User replies with structured option (approve/reject)
   f. Twilio webhook → scripts/server.ts → trigger file
   g. If no reply within timeout → escalate to voice call
4. Complex gate → voice path:
   a. retell.ts creates outbound call via Retell API
   b. Dynamic variables carry context for voice agent
   c. Call completes → webhook → trigger file
```

## 5. Technology Choices

| Layer | Choice | Rationale | ADR |
| --- | --- | --- | --- |
| Plugin language | TypeScript | Claude Code plugin API is TS-native; discriminated unions for state/events; no build step (tsx) | ADR-001 |
| Hook implementation | Bash scripts (`scripts/*.sh`) | Hooks are shell commands invoked by Claude Code harness. Bash scripts read `current-state.txt`, run `tsx` for FSM calls, write state back. Fast startup, no compilation. | ADR-010 |
| Agent runtime | Claude Code (pure plugin) | Claude Code IS the runtime. Agents run within CC with skills injected via hooks. No external subprocesses. | ADR-002, ADR-011 |
| Voice AI | Retell.ai (gpt-4o-mini) | Fastest for phone; `retell_llm_dynamic_variables` for per-call context | — |
| Telephony (voice) | Retell + Twilio (bundled) | US phone number, inbound + outbound | — |
| Telephony (WhatsApp) | Twilio WhatsApp API | Sandbox for dev, production number for deploy. Structured reply options. | ADR-012 |
| Channel routing | `ChannelRouter` (`channel.ts`) | Complexity-based dispatch: simple gates → WhatsApp, complex → voice. Timeout escalation. Env overrides per mode. | ADR-012 |
| PDF generation | `md-to-pdf` (`pdf.ts`) | Convert markdown artifacts to PDF for WhatsApp media attachments. Served via tunnel URL. | ADR-012 |
| Context layer | Supermemory (`memory.ts`) | Project memory storage and retrieval via HTTP API. MCP server also available to agents. | — |
| Tunneling | Cloudflared (free) | No account needed, quick tunnels | — |
| Visual audit | Playwright via `auditor-browser` MCP | Headless, isolated, video recording | — |
| State storage | Filesystem (`spec/` tree, `current-state.txt`, `active-spec.txt`) | Inspectable, git-trackable, crash-resumable | ADR-003 |
| Internal comms | File-based triggers + hooks | Decoupled, testable, crash-resumable | ADR-005 |

## 6. Key Design Decisions

- **D-1: Hardcoded state machine over LLM routing.** Transitions are `if/else` in TypeScript. Extracted into `state-machine.ts` for testability. 18 states, 24 events, 15 side-effect types. *(ADR-001, ADR-004)*

- **D-2: File-based triggers for server/plugin communication.** Webhook server (`scripts/server.ts`) writes trigger files to `spec/.operant/pending/`. Plugin hooks detect and process triggers on each invocation. *(ADR-002, ADR-005)*

- **D-3: Dynamic variables over separate voice agents.** One Retell agent with `{{call_mode}}` switching for requirements/blocker/review/confirmation/demo_invite (5 modes). *(Intent FR-5)*

- **D-4: Project-scoped runtime data.** Runtime state at `spec/.operant/` via `OPERANT_PI_DATA_DIR`. State persisted in `current-state.txt` and `active-spec.txt` (plain text files). Secrets in project `.env`. Plugin directory contains only code. *(ADR-003)*

- **D-5: Pure plugin architecture — Claude Code IS the runtime.** Agents run within Claude Code's own runtime with skills injected via hooks. PostToolUse hooks (`detect-artifact.sh`) detect artifact creation and advance FSM. Stop hooks (`validate-state.sh`) trigger next phase agents. No external subprocesses or orchestrator processes. *(ADR-011)*

- **D-6: Revision stacking over replacement.** Audit and demo revisions are additive context. Dev agent sees original spec + all revisions. *(Intent FR-3.2, FR-4.5)*

- **D-7: Defense-in-depth transition detection (4 layers).** (1) PostToolUse hook (`detect-artifact.sh`) — BLOCKING on spec file writes; (2) Stop hook (`validate-state.sh`) — `inferState()` drift detection, triggers next phase; (3) 10-minute timer — safety net polling; (4) `advance-pipeline` tool — escape hatch. *(ADR-009, ADR-010)*

- **D-8: Graceful shutdown.** SessionEnd hook (`cleanup.sh`) kills server + tunnel. PID-file cleanup on startup (`startup.sh`) for crash recovery. *(ADR-007)*

- **D-9: `reviewedArtifactState` tracking.** FSM saves `previousState` as `reviewedArtifactState` when entering `sdlc_review`. `REVIEW_APPROVED` uses this to route correctly: intent→hld, hld→adr, adr→eis, eis→dev. *(ADR-010)*

- **D-10: `/operant process` command.** Handles trigger files entirely in plugin code. Reads trigger, classifies transcript, creates REQUIREMENTS.md, activates SDLC agent. Used by test harness and webhook handler. *(ADR-012)*

- **D-11: Mock auto-approve for testing.** When `OPERANT_PI_MOCK=1` or no phone number: auto-approve review, activate next phase agent. Enables end-to-end testing without Retell or Twilio. *(ADR-011)*

- **D-12: Channel abstraction — voice + WhatsApp with complexity routing.** `ChannelRouter` dispatches gates based on deterministic complexity classification. Simple gates (confirmation, review, demo_invite) → WhatsApp first with PDF attachments. Complex gates (blocker, requirements) → voice call. Timeout escalation: if WhatsApp gets no reply within configurable timeout (default 5-10 min), automatically escalates to voice. Env overrides per mode (`CHANNEL_OVERRIDE_<mode>`). *(ADR-012)*

- **D-13: Demo phase between audit and confirmation.** After audit passes, AUDIT_PASSED transitions to `demo_setup` (not directly to confirmation). Four demo sub-states: `demo_setup` → `demo_calling` → `demo_active` → `demo_feedback`. User sees the live feature before final confirmation. Demo failures or skips gracefully fall back to voice confirmation. Demo rejections capture pain points and re-enter dev loop. *(ADR-013)*

## 7. Open Questions

### Resolved by ADRs

- [x] ~~OQ-4: Phase state inferred vs persisted~~ → Persisted in `current-state.txt` + `active-spec.txt` (ADR-003, D-4)
- [x] ~~OQ-6: Project CWD detection~~ → Use Claude Code session CWD (ADR-003)

### Remaining

- [ ] **OQ-1:** How to summarize long artifacts for phone review? — **Default:** 2-minute TL;DR focusing on key decisions. Read aloud, ask "Does this capture it?"
- [ ] **OQ-2:** Dev loop timeout after N blocker cycles? — **Default:** No timeout for v1. Stop hook counts blockers; after 5, escalate with "too many blockers" context.
- [ ] **OQ-3:** Where do completed specs go? — **Default:** Stay in `spec/` with `STATUS: complete` marker in REQUIREMENTS.md.
- [ ] **OQ-5:** Full spec or summary on phone? — **Default:** Summary only. Phone calls are for decisions, not document reading. WhatsApp gates attach full PDF for async review.

## 8. Risks and Mitigations

| Risk | Impact | Mitigation | ADR |
| --- | --- | --- | --- |
| Cloudflared tunnel drops mid-call | H | Retell retries 3x. Server logs payload for recovery. | — |
| Voice agent misinterprets approval | M | Always confirm: "Just to confirm, you're saying approve?" | — |
| Dev agent infinite blocker loop | M | Stop hook counts files; after 5, escalate differently | ADR-009 |
| Retell credit runs out | H | Monitor balance; alert below $2 | — |
| Claude Code session crash mid-pipeline | M | File-based state (`current-state.txt` + `active-spec.txt`) + PID cleanup on startup | ADR-003, ADR-007 |
| Audit agent can't start dev server | M | Check port, kill stale process, retry. If still fails, write blocker. | — |
| Orphaned processes on exit | M | SessionEnd hook (`cleanup.sh`) cleanup | ADR-007 |
| WhatsApp message delivery failure | M | ChannelRouter automatic fallback to voice on WhatsApp error. Twilio delivery receipts logged. | ADR-012 |
| WhatsApp reply timeout delays pipeline | L | Configurable timeouts per mode (5-10 min). Automatic escalation to voice call. | ADR-012 |
| Twilio sandbox rate limits | L | Sandbox for dev only. Production number for real usage. Rate-limit retry with backoff. | ADR-012 |
| PDF generation fails for WhatsApp | L | Fallback: send plain text summary without attachment. Log error for investigation. | — |
| Demo environment fails to start | M | `DEMO_FAILED` transition gracefully falls back to voice confirmation. No demo required for pipeline completion. | ADR-013 |
| User never joins demo Meet link | L | `DEMO_SKIPPED` transition after timeout. Falls back to confirmation gate. | ADR-013 |

## 9. Traceability

| Intent | HLD Section | ADR |
| --- | --- | --- |
| FR-1 (P0 Triage) | 4. Flow A (steps 6-7) | D-1, D-10 (ADR-012) |
| FR-2 (SDLC Phase) | 4. Flow A (steps 8-16) | D-3, D-5 (ADR-011), D-9 |
| FR-3 (P1 Dev Loop) | 4. Flow B | D-5, D-6, D-7 (ADR-009, ADR-010) |
| FR-4 (P2 Audit Loop) | 4. Flow C (steps 1-8) | D-4 (ADR-003), D-5 (ADR-011) |
| FR-4.1 (Demo Phase) | 4. Flow C (steps 9-10) | D-13 (ADR-013) |
| FR-5 (Voice Context) | 3. Voice Agent | D-3 |
| FR-5.1 (Channel Routing) | 4. Flow D | D-12 (ADR-012) |
| FR-6 (Skills) | 3. Component Descriptions | D-5 (ADR-011) |
| NFC-1 (Deterministic) | 6. D-1 | ADR-001, ADR-004 |
| NFC-2 (File-based state) | 6. D-4 | ADR-003 |
| NFC-3 (Pure plugin arch) | 6. D-5 | ADR-002, ADR-011 |
| NFC-4 (Multi-channel) | 6. D-12 | ADR-012 |
