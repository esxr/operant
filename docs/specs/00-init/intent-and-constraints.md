<!-- #core -->
# Intent & Constraints: Operant Autonomous Development Pipeline

**Version:** 3.0  
**Date:** 2026-06-10  
**Status:** Draft  
**Source:** Voice call requirements + chat refinement with Pranav Dhoolia  
**Audience:** Implementation agents (Claude Code plugin)

---

## 1. Problem Statement

Today, turning a product idea into working, verified code requires constant human babysitting — typing requirements into chat, manually reviewing intermediate artifacts, re-explaining blockers, and visually verifying output. The human is the bottleneck at every stage.

Operant eliminates this by replacing every human-in-the-loop touchpoint with a **phone call** (or WhatsApp message). The user calls in with requirements, hangs up, and the pipeline autonomously produces spec documents, implements code, audits it visually, demos the result via Google Meet, and only calls the user back when it needs a decision or confirmation. The goal is a system where the user's only interface is their phone — no terminal, no chat, no IDE.

**Core differentiator from existing tools:** State transitions between phases are **hardcoded** (deterministic TypeScript code in a standalone FSM module, not LLM judgment), while the work within each phase is LLM-driven by Claude Code agents. This gives reliability of a traditional CI/CD pipeline with the flexibility of an AI agent.

---

## 2. Goals

- **G-1:** A phone call is sufficient to go from idea → deployed, verified feature, with no chat or terminal interaction required.
- **G-2:** Every phase transition is deterministic — enforced by the FSM (`src/state-machine.ts`) and shell-script hooks (`hooks/hooks.json`), not LLM decision-making.
- **G-3:** The pipeline loops autonomously (dev → audit → revision → dev) until the implementation matches the spec, only calling the user for blockers and confirmations.
- **G-4:** File-based state — all pipeline state lives in `spec/.operant/` (current-state.txt, active-spec.txt) and `spec/<feature>/` folder structure, not in memory. Pipeline is resumable and inspectable.
- **G-5:** Review gates at each SDLC stage — the user is called once per artifact (Intent, HLD, ADR, EIS = 4 calls per spec).
- **G-6:** Multi-channel gates — simple gates (confirmation, review, demo invite) route to WhatsApp first with voice escalation on timeout; complex gates (blocker, requirements) route to voice directly.
- **G-7:** Demo phase — after audit passes, the pipeline sets up a live demo via Google Meet before final confirmation, giving the user a chance to interact with the built feature.

---

## 3. Functional Requirements

### FR-1: P0 — Triage (Call Intake)

- **FR-1.1:** Inbound calls are received via Retell.ai voice agent, transcribed, and delivered as webhook payloads to the local server (`scripts/server.ts`).
- **FR-1.2:** On call completion, the plugin classifies the transcript: is this a **new feature request** (non-trivial requirements) or a **confirmation** ("yes, it's done")?
- **FR-1.3:** If new requirements: derive a kebab-case spec name from the content, create `spec/<name>/`, write `spec/<name>/REQUIREMENTS.md` with the raw requirements.
- **FR-1.4:** If confirmation: mark the current active spec as complete, exit pipeline.
- **FR-1.5:** Classification logic is hardcoded heuristics + LLM assist (check for keywords like "done", "looks good", "confirmed" vs. substantive feature descriptions). Implemented in `src/cli/process-trigger.ts`.

### FR-2: SDLC Phase (Spec Creation)

- **FR-2.1:** When a new `spec/<name>/` folder is created containing REQUIREMENTS.md, a **spec agent** (`agents/sdlc-writer.md`) is activated within Claude Code with the `sdlc-skill` injected via hooks.
- **FR-2.2:** The spec agent reads REQUIREMENTS.md and produces `intent-and-constraints.md` (Phase 1 of SDLC).
- **FR-2.3:** After producing each artifact, the agent triggers an **outbound call** to the user with the artifact summary as dynamic context. The voice agent reads back key points and asks for approval.
- **FR-2.4:** The user's response (approve / request changes) is captured via the call webhook. If changes requested, the spec agent revises and re-calls.
- **FR-2.5:** The agent proceeds through all 4 SDLC phases sequentially: Intent & Constraints → HLD → ADR-Lite → Implementation Spec. Each phase has its own call-based review gate.
- **FR-2.6:** SDLC phase is complete when the user approves the Implementation Spec. This triggers P1.

### FR-3: P1 — Dev Loop

- **FR-3.1:** A **dev agent** (`agents/dev-builder.md`) is activated within Claude Code with the `development-methodology` skill injected via hooks (3-agent build: Maintainer → Builder → Police).
- **FR-3.2:** The dev agent reads all specs in `spec/<name>/` including any revisions from `spec/<name>/revisions/` as **additional context** on top of the original implementation-spec.
- **FR-3.3:** The dev agent can spawn subagents (Maintainer, Builder, Police) as specified in the methodology.
- **FR-3.4:** If a blocker is encountered, the dev agent writes a blocker report to `spec/<name>/blockers/<blocker_name>.md` and **exits**.
- **FR-3.5:** The Stop hook (`scripts/validate-state.sh`) detects new files in `spec/<name>/blockers/`. Detection is both heuristic (file modification time) and deterministic (compare file list before/after).
- **FR-3.6:** On new blocker detection, the plugin triggers an **outbound call** to the user with the blocker details as dynamic context.
- **FR-3.7:** After the blocker call, the user's resolution is captured. The dev agent is **re-activated** with the resolution as additional context. Dev loop continues.
- **FR-3.8:** Dev loop ends when the dev agent completes without writing any new blockers.

### FR-4: P2 — Audit Loop

- **FR-4.1:** After the dev loop completes, an **auditor agent** (`agents/auditor.md`) is activated within Claude Code with the `audit-methodology` skill injected via hooks.
- **FR-4.2:** The auditor uses the `auditor-browser` MCP server (headless Playwright, configured in plugin `.mcp.json`) to visually verify the implementation.
- **FR-4.3:** The auditor checks each functional requirement in `spec/<name>/implementation-spec.md` against the running app.
- **FR-4.4:** If the dev server is not running, the auditor spins it up first.
- **FR-4.5:** If the audit **fails**: the auditor writes a revision spec to `spec/<name>/revisions/<revision_name>.md` describing what failed, expected behavior, and observed behavior. Pipeline goes back to P1.
- **FR-4.6:** If the audit **passes**: pipeline transitions to the demo phase (FR-7).
- **FR-4.7:** If the user says **no** at confirmation → the voice agent probes for specific pain points ("What isn't right? What did you expect?"). A new revision is written from the user's feedback. Pipeline goes back to P1.

### FR-5: Voice Agent Dynamic Context

- **FR-5.1:** The Retell LLM prompt uses `{{variable}}` placeholders that are populated per-call via `retell_llm_dynamic_variables`.
- **FR-5.2:** Call modes (`src/retell.ts`): `requirements` (inbound intake), `blocker` (outbound blocker resolution), `review` (outbound spec review), `confirmation` (outbound completion check), `demo_invite` (outbound demo session invite).
- **FR-5.3:** Each mode has a distinct conversation flow in the voice agent prompt.
- **FR-5.4:** The voice agent must be instructed to extract pain points when the user rejects a confirmation (FR-4.7).

### FR-6: Skills

- **FR-6.1:** `sdlc-skill` (`skills/sdlc-skill/SKILL.md`) — Provides the spec-first methodology (Intent → HLD → ADR → EIS). Loaded via hook-based context injection during SDLC phase.
- **FR-6.2:** `development-methodology` (`skills/development-methodology/SKILL.md`) — Encodes the 3-agent build methodology (Maintainer → Builder → Police), including launch order, builder scoping rules, police verification, and CEO delegation principles. Loaded via hooks during dev phase.
- **FR-6.3:** `audit-methodology` (`skills/audit-methodology/SKILL.md`) — Encodes the Police/QA methodology using `auditor-browser` for visual verification, screenshot proof, and spec-vs-reality comparison. Loaded via hooks during audit phase.
- **FR-6.4:** `pipeline-knowledge` (`skills/pipeline-knowledge/SKILL.md`) — Knowledge about the FSM states, transitions, phases, artifact sequence, human gates, and how the autonomous development loop works. Used when Claude needs to understand pipeline behavior, interpret state, or route decisions.

### FR-7: Demo Phase

- **FR-7.1:** After the audit passes (`AUDIT_PASSED` event), the FSM transitions to `demo_setup` (not directly to `confirmation`).
- **FR-7.2:** The pipeline sets up a live demo environment and creates a Google Meet session for interactive walkthrough.
- **FR-7.3:** A `demo_invite` outbound call is placed to invite the user to join the Meet session.
- **FR-7.4:** Once the user joins (`USER_JOINED_MEET`), the pipeline enters `demo_active` and walks through the built feature.
- **FR-7.5:** After the walkthrough (`WALKTHROUGH_COMPLETE`), the pipeline transitions to `demo_feedback` for the user's reaction.
- **FR-7.6:** If the demo is approved (`DEMO_APPROVED`), the pipeline proceeds to `confirmation` for final sign-off.
- **FR-7.7:** If the demo is rejected (`DEMO_REJECTED`), pain points are captured, a revision is written, and the pipeline loops back to P1 (dev).
- **FR-7.8:** If demo setup fails (`DEMO_FAILED`) or is skipped (`DEMO_SKIPPED`), the pipeline falls back to a voice confirmation call.

### FR-8: WhatsApp Channel

- **FR-8.1:** Simple gate interactions (confirmation, review, demo invite) are routed to WhatsApp first via the Twilio API (`src/whatsapp.ts`).
- **FR-8.2:** Complex gate interactions (blocker, requirements) are routed directly to voice (Retell).
- **FR-8.3:** If a WhatsApp message goes unanswered within the configured timeout (5-10 min), the gate escalates to a voice call automatically.
- **FR-8.4:** Channel routing is managed by `ChannelRouter` (`src/channel.ts`), which classifies complexity per `CallMode` and manages timeout escalation.
- **FR-8.5:** WhatsApp messages can include PDF attachments of spec artifacts, generated via `src/pdf.ts`.

### FR-9: Context Layer (Supermemory)

- **FR-9.1:** Long-term memory across pipeline sessions is managed via the Supermemory API (`src/memory.ts`).
- **FR-9.2:** See `docs/specs/03-context-layer/` for the full context layer specification.

---

## 4. Non-Functional Constraints

- **NFC-1: Deterministic transitions.** Phase changes (P0 → SDLC → P1 → P2 → Demo → Confirmation) must be enforced by the FSM in `src/state-machine.ts`, driven by shell-script hooks. The LLM cannot skip phases or decide to proceed without user approval.
- **NFC-2: File-based state.** All state is in `spec/` folder structure. Current FSM state is persisted to `spec/.operant/current-state.txt`, active spec to `spec/.operant/active-spec.txt`. The pipeline must be resumable after a crash — no in-memory-only state.
- **NFC-3: Single Claude Code session.** Everything runs in one Claude Code session. Agents run within Claude Code's own runtime. No external orchestrator processes.
- **NFC-4: Call latency.** Outbound calls should be triggered within 30 seconds of the triggering event (blocker written, spec artifact produced, audit complete).
- **NFC-5: Retell cost.** Use `gpt-4o-mini` for the voice LLM (cheapest, fastest for phone calls). Use Claude Opus for the Claude Code agents (quality).

---

## 5. Known Boundaries and Limitations

- **B-1:** The voice agent cannot read or display documents — it can only read back summaries. Full spec review requires the user to read the file independently (or we read key sections aloud).
- **B-2:** Retell phone numbers are US-only. International callers (AU) must dial a US number.
- **B-3:** Cloudflared tunnels are ephemeral — URL changes on every restart. The webhook URL must be re-registered with Retell on each pipeline start.
- **B-4:** The auditor-browser MCP is a separate Playwright instance. It cannot share browser state with the user's Chrome.
- **B-5:** The plugin hook API (PreToolUse/PostToolUse/Stop/SessionStart/SessionEnd/UserPromptSubmit/SubagentStop/PreCompact/Notification) is the primary integration surface. Not all orchestration patterns are possible through hooks alone — some require file-based signaling.
- **B-6:** No deployment phase in this spec. Deployment is a separate concern (Vercel, existing infrastructure).

---

## 6. Open Questions

- **OQ-1:** How should the spec agent summarize long artifacts (like an EIS) for the phone call review? Read the whole thing? Just key decisions? A generated TL;DR?
- **OQ-2:** Should there be a timeout on the dev loop? (e.g., if the agent loops on blockers 5+ times, escalate differently)
- **OQ-3:** Should the pipeline support multiple concurrent specs? Or is it single-spec-at-a-time?
- **OQ-4:** Where do completed specs go? Stay in `spec/` or move to an `archive/` directory?
- **OQ-5:** ~~Should the pipeline persist its current phase to disk for crash recovery, or infer it from the file structure?~~ **Resolved:** State is persisted to `spec/.operant/current-state.txt`.

---

## 7. Existing Assets

| Asset | Location | Status |
|-------|----------|--------|
| Claude Code plugin manifest | `.claude-plugin/plugin.json` | Built — v0.2.0 with commands, agents |
| Webhook server | `scripts/server.ts` | Built — receives Retell + Twilio webhooks, writes trigger files |
| Tunnel manager | `scripts/tunnel.sh` | Built — cloudflared lifecycle via shell script |
| Retell client | `src/retell.ts` | Built — supports dynamic variables, 5 call modes |
| WhatsApp channel | `src/whatsapp.ts` | Built — Twilio sandbox, structured reply options |
| Channel router | `src/channel.ts` | Built — complexity classification, timeout escalation |
| State machine | `src/state-machine.ts` | Built — 18 states, 23 events, 15 side effect types |
| Config/state I/O | `src/config.ts` | Built — current-state.txt + active-spec.txt |
| Supermemory client | `src/memory.ts` | Built — context layer integration |
| PDF generator | `src/pdf.ts` | Built — markdown-to-PDF for WhatsApp attachments |
| CLI tools | `src/cli/*.ts` | Built — process-trigger, transition, infer-state, status, whitelist, trigger-gate, register-webhook, post-agent-check |
| Hook scripts | `scripts/*.sh` | Built — startup, cleanup, pre-write-guard, pre-agent-guard, detect-artifact, check-blockers, inject-context, validate-state, subagent-complete, pre-compact, notify-phase |
| Hook configuration | `hooks/hooks.json` | Built — 9 hook types: SessionStart, SessionEnd, PreToolUse, PostToolUse, UserPromptSubmit, Stop, SubagentStop, PreCompact, Notification |
| Commands | `commands/*.md` | Built — start, stop, status, whitelist, process |
| Agents | `agents/*.md` | Built — sdlc-writer, auditor, dev-builder |
| Skills | `skills/*/SKILL.md` | Built — sdlc-skill, development-methodology, audit-methodology, pipeline-knowledge |
| Retell account | dashboard.retellai.com | Configured — agent, LLM, phone number provisioned |
| auditor-browser MCP | Plugin `.mcp.json` | Configured — headless Playwright with video |
