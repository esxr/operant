<!-- #core -->
# Implementation Specification: Operant

**Version:** 3.0  
**Date:** 2026-06-10  
**Based on:** Intent & Constraints v2.0, HLD v4.0, ADR-Lite (ADR-001 through ADR-012)

---

## 1. State Machine

### 1.1 Overview

The state machine is the core of operant. It is a **hardcoded finite state machine** implemented in `src/state-machine.ts` (ADR-004). All transitions are deterministic TypeScript code -- no LLM judgment controls phase changes. LLM work is performed by Claude Code agents *within* each phase (ADR-011); plugin hooks orchestrate transitions between phases. The FSM controls movement *between* phases. Transition detection uses 4 layers of defense in depth (ADR-010): PostToolUse hook, Stop hook, 10-minute timer, and `advance-pipeline` tool.

### 1.2 States

| State | Phase Group | Description |
|-------|------------|-------------|
| `idle` | idle | No active spec. Waiting for inbound call. |
| `call_active` | idle | An inbound call is in progress (webhook received but not yet processed). |
| `triage` | triage | Classifying a completed call transcript: new requirements vs. confirmation. |
| `sdlc_intent` | sdlc | Spec agent producing `intent-and-constraints.md`. |
| `sdlc_hld` | sdlc | Spec agent producing `high-level-design.md`. |
| `sdlc_adr` | sdlc | Spec agent producing `adr-lite.md`. |
| `sdlc_eis` | sdlc | Spec agent producing `implementation-spec.md`. |
| `sdlc_review` | sdlc | Outbound review call in progress. Awaiting user approval/rejection of current artifact. |
| `dev` | dev | Dev agent running (3-agent build: Maintainer/Builder/Police). |
| `dev_blocked` | dev | Dev agent exited with new blocker. Outbound call in progress to resolve. |
| `audit` | audit | Auditor agent running visual verification against spec. |
| `audit_failed` | audit | Audit failed. Revision written. Transitioning back to dev. |
| `demo_setup` | demo | Audit passed. Preparing demo environment (dev server, Google Meet). |
| `demo_calling` | demo | Outbound demo-invite call in progress. Waiting for user to join Meet. |
| `demo_active` | demo | User joined Meet. Walkthrough in progress. |
| `demo_feedback` | demo | Walkthrough complete. Capturing user feedback. |
| `confirmation` | confirmation | Outbound call asking user to confirm completed work. |
| `complete` | idle | Active spec marked complete. Pipeline returns to idle. |

### 1.3 Transitions

| # | From | To | Trigger | Guards | Side Effects |
|---|------|----|---------|--------|--------------|
| T1 | `idle` | `call_active` | `CALL_RECEIVED` (trigger file from server) | none | Log call start |
| T2 | `call_active` | `triage` | `CALL_COMPLETED` (webhook `call_analyzed`) | `triggerFile` exists | Parse transcript, process trigger |
| T3 | `triage` | `sdlc_intent` | `NEW_REQUIREMENTS` | Transcript classified as new feature | Create `spec/<name>/`, write `REQUIREMENTS.md`, load sdlc-skill |
| T4 | `triage` | `complete` | `CONFIRMATION_RECEIVED` | Transcript classified as confirmation AND active spec exists | Write `STATUS: complete` to active spec REQUIREMENTS.md |
| T5 | `triage` | `idle` | `REJECTED` | Transcript unclassifiable or empty | Log warning, discard |
| T6 | `sdlc_intent` | `sdlc_review` | `ARTIFACT_PRODUCED` | `intent-and-constraints.md` exists in spec dir | Trigger outbound review call with artifact summary |
| T7 | `sdlc_hld` | `sdlc_review` | `ARTIFACT_PRODUCED` | `high-level-design.md` exists | Trigger outbound review call |
| T8 | `sdlc_adr` | `sdlc_review` | `ARTIFACT_PRODUCED` | `adr-lite.md` exists | Trigger outbound review call |
| T9 | `sdlc_eis` | `sdlc_review` | `ARTIFACT_PRODUCED` | `implementation-spec.md` exists | Trigger outbound review call |
| T10 | `sdlc_review` | next sdlc state | `REVIEW_APPROVED` | Call transcript contains approval | Uses `reviewedArtifactState` to route: intent->hld, hld->adr, adr->eis, eis->dev. Activates next phase agent via hooks. |
| T11 | `sdlc_review` | previous sdlc state | `REVIEW_REJECTED` | Call transcript contains rejection/changes | Re-enter current artifact phase with revision context |
| T12 | `sdlc_review` | `dev` | `REVIEW_APPROVED` (from EIS review) | `implementation-spec.md` approved | Load development-methodology skill, launch dev agent |
| T13 | `dev` | `dev_blocked` | `BLOCKER_DETECTED` | New file(s) in `blockers/` dir | Trigger outbound blocker call |
| T14 | `dev` | `audit` | `DEV_COMPLETE` | Dev agent exited without new blockers | Load audit-methodology skill, launch audit agent |
| T15 | `dev_blocked` | `dev` | `BLOCKER_RESOLVED` | Blocker call completed with resolution | Re-activate dev agent with resolution context |
| T16 | `audit` | `audit_failed` | `AUDIT_FAILED` | New file(s) in `revisions/` dir | Transition marker |
| T17 | `audit_failed` | `dev` | `REVISION_READY` | Revision file written | Re-activate dev agent with original spec + all revisions |
| T18 | `audit` | `demo_setup` | `AUDIT_PASSED` | Audit agent completed without revisions | Create `.demo/` dir in spec, prepare demo environment |
| T19 | `confirmation` | `complete` | `USER_CONFIRMED` | Call transcript = approval | Write `STATUS: complete` |
| T20 | `confirmation` | `dev` | `USER_REJECTED` | Call transcript = rejection with pain points | Write new revision from pain points, re-activate dev |
| T21 | `complete` | `idle` | `RESET` | Automatic after marking complete | Clear active spec reference |
| T22 | `demo_setup` | `demo_calling` | `DEMO_READY` | Demo environment provisioned, Meet URL available | Trigger outbound demo-invite call with Meet URL and code |
| T23 | `demo_setup` | `confirmation` | `DEMO_FAILED` | Demo setup failed (server crash, Meet creation error) | Teardown demo, fall back to voice confirmation call |
| T24 | `demo_calling` | `demo_active` | `USER_JOINED_MEET` | User joined the Google Meet session | Start walkthrough |
| T25 | `demo_active` | `demo_feedback` | `WALKTHROUGH_COMPLETE` | Walkthrough finished (all features demonstrated) | Capture feedback |
| T26 | `demo_feedback` | `confirmation` | `DEMO_APPROVED` | User approved during demo feedback | Teardown demo, trigger confirmation call |
| T27 | `demo_feedback` | `dev` | `DEMO_REJECTED` | User rejected during demo with pain points | Write demo revision, teardown demo, re-activate dev with pain points |
| T28 | `demo_calling` | `confirmation` | `DEMO_SKIPPED` | User declined to join Meet or call timeout | Teardown demo, fall back to voice confirmation call |

### 1.4 FSM Diagram

```
                                    CALL_RECEIVED
                                         |
                                         v
                  +-------+         +-----------+
                  | idle  |<------->|call_active |
                  +-------+         +-----------+
                    ^  ^                 |
              RESET |  | REJECTED   CALL_COMPLETED
                    |  |                 |
               +--------+               v
               |complete|          +---------+
               +--------+          | triage  |
                 ^    ^            +---------+
                 |    |              |     |
      USER_      |    |   NEW_REQ    |     | CONFIRMATION_RECEIVED
      CONFIRMED  |    |              v     |
                 |    |       +-------------+
                 |    |       | sdlc_intent |
                 |    |       +-------------+
                 |    |              |
                 |    |       ARTIFACT_PRODUCED
                 |    |              |
                 |    |              v
                 |    |       +-------------+          REVIEW_REJECTED
                 |    |       | sdlc_review |------+     (loops to
                 |    |       +-------------+      |    same artifact)
                 |    |         |         |        |
                 |    |  APPROVED   APPROVED        |
                 |    |  (next)    (EIS final)      |
                 |    |    |           |             |
                 |    |    v           |             |
                 |    | sdlc_hld -> sdlc_adr -> sdlc_eis
                 |    |                           |
                 |    |                    REVIEW_APPROVED (EIS)
                 |    |                           |
                 |    |                           v
                 |    |      DEMO_FAILED     +---------+
                 |    |     +---+            | audit   |
                 |    |     |   |            +---------+
                 |    |     v   |              ^     |
           +------------+  |   |              |  AUDIT_FAILED
           |confirmation|  |   |       DEV_   |     |
           +------------+  |   |     COMPLETE |     v
                 |    ^    |   |              |  +-----------+
          USER_  |    |    |   |              |  |audit_failed|
          REJECTED    |    |   |              |  +-----------+
                 |    |    |   |              |       |
                 |    |    |   | AUDIT_       |  REVISION_READY
                 v    |    |   | PASSED       |       |
               +-----+    |   |              |       |
               | dev |<----|---|--+-----------+-------+
               +-----+    |   |  |
                 |  ^      |   |  |
       BLOCKER_  |  |      |   |  |DEMO_REJECTED
       DETECTED  |  |BLOCKER_  |  |
                 |  |RESOLVED  |  |
                 v  |      |   |  |
            +-----------+  |   |  |
            |dev_blocked|  |   |  |
            +-----------+  |   |  |
                           |   |  |
              +------------+   |  |
              |                |  |
              v                |  |
         +-----------+  DEMO_ |  |
         |demo_setup |--READY-+  |
         +-----------+        |  |
              |               v  |
              |         +-------------+
              |         |demo_calling  |
              |         +-------------+
              |           |    |
              |   USER_   |    | DEMO_SKIPPED
              |   JOINED  |    +---> confirmation
              |   _MEET   |
              |           v
              |     +------------+
              |     |demo_active |
              |     +------------+
              |           |
              |     WALKTHROUGH_
              |     COMPLETE
              |           |
              |           v
              |     +--------------+
              |     |demo_feedback |
              |     +--------------+
              |       |          |
              |  DEMO_APPROVED   DEMO_REJECTED
              |       |               |
              |       v               v
              +-> confirmation       dev
```

### 1.5 Phase Inference from Filesystem

The function `inferPhase()` determines the current phase by inspecting the `spec/` directory tree. This supports crash recovery (NFC-2, ADR-003).

**Algorithm (checked in order, first match wins):**

1. No directories in `spec/` (excluding `.operant/`) -> `idle`
2. Active spec dir exists (has REQUIREMENTS.md without `STATUS: complete`):
   a. `blockers/` has files newer than last dev agent start -> `dev_blocked`
   b. `revisions/` has files newer than last audit agent start -> `audit_failed`
   b2. `.demo/` directory exists (demo phase inference):
       - `meet.json` exists but no `feedback.json`:
         - `walkthrough.json` exists -> `demo_active`
         - no `walkthrough.json` -> `demo_setup`
       - `feedback.json` exists:
         - `feedback.decision === "rejected"` -> `dev`
         - otherwise -> `confirmation`
   c. `implementation-spec.md` exists AND `revisions/` exists -> `dev` (re-enter dev with revisions)
   d. `implementation-spec.md` exists AND no `revisions/` -> `dev` (first dev run)
   e. `adr-lite.md` exists but no `implementation-spec.md` -> `sdlc_eis`
   f. `high-level-design.md` exists but no `adr-lite.md` -> `sdlc_adr`
   g. `intent-and-constraints.md` exists but no `high-level-design.md` -> `sdlc_hld`
   h. `REQUIREMENTS.md` exists but no `intent-and-constraints.md` -> `sdlc_intent`
3. All specs have `STATUS: complete` -> `idle`

**Limitation:** Inference cannot distinguish `sdlc_review` (waiting for call) from the artifact-production state. On crash recovery, the system re-enters the artifact production state, which re-triggers the review call. This is acceptable because an extra confirmation call is harmless. Similarly, `demo_calling` cannot be distinguished from `demo_setup` -- both re-enter `demo_setup` on recovery.

---

## 2. Module Interfaces

### 2.1 Module: `state-machine.ts` (ADR-004)

**Path:** `src/state-machine.ts`

**Responsibility:** Hardcoded FSM logic, phase inference from filesystem, blocker detection. Pure functions + filesystem reads. No Claude Code API dependency.

**Public Interface:**

```typescript
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Coarse phase groups for skill loading and context injection */
export type Phase = "idle" | "triage" | "sdlc" | "dev" | "audit" | "demo" | "confirmation";

/** Fine-grained FSM states */
export type State =
  | "idle"
  | "call_active"
  | "triage"
  | "sdlc_intent"
  | "sdlc_hld"
  | "sdlc_adr"
  | "sdlc_eis"
  | "sdlc_review"
  | "dev"
  | "dev_blocked"
  | "audit"
  | "audit_failed"
  | "demo_setup"
  | "demo_calling"
  | "demo_active"
  | "demo_feedback"
  | "confirmation"
  | "complete";

/** Events that trigger state transitions */
export type FSMEvent =
  | "CALL_RECEIVED"
  | "CALL_COMPLETED"
  | "NEW_REQUIREMENTS"
  | "CONFIRMATION_RECEIVED"
  | "REJECTED"
  | "ARTIFACT_PRODUCED"
  | "REVIEW_APPROVED"
  | "REVIEW_REJECTED"
  | "DEV_COMPLETE"
  | "BLOCKER_DETECTED"
  | "BLOCKER_RESOLVED"
  | "AUDIT_PASSED"
  | "AUDIT_FAILED"
  | "REVISION_READY"
  | "USER_CONFIRMED"
  | "USER_REJECTED"
  | "RESET"
  | "DEMO_READY"
  | "USER_JOINED_MEET"
  | "WALKTHROUGH_COMPLETE"
  | "DEMO_APPROVED"
  | "DEMO_REJECTED"
  | "DEMO_SKIPPED"
  | "DEMO_FAILED";

/** Transition result */
export interface TransitionResult {
  from: State;
  to: State;
  event: FSMEvent;
  sideEffects: SideEffect[];
}

/** Side effects emitted by transitions */
export type SideEffect =
  | { type: "CREATE_SPEC_DIR"; name: string }
  | { type: "WRITE_REQUIREMENTS"; specDir: string; content: string }
  | { type: "TRIGGER_REVIEW_CALL"; specDir: string; artifactType: string; artifactSummary: string }
  | { type: "TRIGGER_BLOCKER_CALL"; specDir: string; blockerPath: string }
  | { type: "TRIGGER_CONFIRMATION_CALL"; specDir: string }
  | { type: "LOAD_SKILL"; phase: Phase }
  | { type: "LAUNCH_AGENT"; phase: Phase; specDir: string; context: string }
  | { type: "MARK_COMPLETE"; specDir: string }
  | { type: "EMIT_EVENT"; name: string; payload: Record<string, unknown> }
  | { type: "CREATE_DEMO"; specDir: string }
  | { type: "TRIGGER_DEMO_INVITE_CALL"; specDir: string; meetUrl: string; meetCode: string }
  | { type: "START_WALKTHROUGH"; specDir: string }
  | { type: "CAPTURE_FEEDBACK" }
  | { type: "WRITE_DEMO_REVISION"; specDir: string; painPoints: string[] }
  | { type: "TEARDOWN_DEMO" };

/** Spec directory status */
export interface SpecStatus {
  name: string;
  path: string;
  complete: boolean;
  artifacts: {
    requirements: boolean;
    intent: boolean;
    hld: boolean;
    adr: boolean;
    eis: boolean;
  };
  blockerCount: number;
  revisionCount: number;
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Infer the current pipeline phase from the filesystem state.
 * Used for crash recovery and session resume (NFC-2).
 *
 * @param specsRoot - Absolute path to the `spec/` directory
 * @returns The inferred coarse Phase
 */
export function inferPhase(specsRoot: string): Phase;

/**
 * Infer the current fine-grained FSM state from filesystem.
 *
 * @param specsRoot - Absolute path to the `spec/` directory
 * @returns The inferred State
 */
export function inferState(specsRoot: string): State;

/**
 * Validate and execute a state transition.
 * Returns the new state and any side effects. Throws InvalidTransitionError
 * if the transition is not allowed.
 *
 * @param current - Current FSM state
 * @param event - The triggering event
 * @param context - Optional context (spec name, transcript, etc.)
 * @returns TransitionResult with new state and side effects
 * @throws InvalidTransitionError if transition is not in the table
 */
export function transition(
  current: State,
  event: FSMEvent,
  context?: Record<string, string>
): TransitionResult;

/**
 * Find the active (non-complete) spec directory.
 * Returns null if all specs are complete or no specs exist.
 *
 * @param specsRoot - Absolute path to `spec/` directory
 * @returns Absolute path to active spec dir, or null
 */
export function getCurrentSpec(specsRoot: string): string | null;

/**
 * Get status of all spec directories.
 *
 * @param specsRoot - Absolute path to `spec/` directory
 * @returns Array of SpecStatus objects
 */
export function listSpecs(specsRoot: string): SpecStatus[];

/**
 * Detect new blocker files by comparing current state to known set.
 *
 * @param specDir - Absolute path to the active spec directory
 * @param knownBlockers - Array of previously known blocker filenames
 * @returns Array of NEW blocker filenames (not in knownBlockers)
 */
export function detectNewBlockers(specDir: string, knownBlockers: string[]): string[];

/**
 * Detect new revision files by comparing current state to known set.
 *
 * @param specDir - Absolute path to the active spec directory
 * @param knownRevisions - Array of previously known revision filenames
 * @returns Array of NEW revision filenames
 */
export function detectNewRevisions(specDir: string, knownRevisions: string[]): string[];

/**
 * Classify a call transcript as "requirements" | "confirmation" | "unknown".
 * Uses keyword heuristics with call_analysis checked first.
 *
 * Heuristic rules (checked in order):
 * 1. If callAnalysis has call_summary (top-level or under custom_analysis_data)
 *    -> "requirements" (Retell already determined this is substantive)
 *    Also checks custom_analysis_data.feature_name.
 * 2. If transcript is empty or whitespace-only -> "unknown"
 * 3. If transcript contains 2+ standalone confirmation keywords:
 *    "looks good", "confirmed", "approved", "satisfied", "ship it",
 *    plus standalone "done"/"yes" AND transcript < 200 chars -> "confirmation"
 * 4. If transcript contains 1+ requirement-indicating keywords:
 *    "requirements", "spec", "build", "feature", "implement", "solve",
 *    "fix", "create", "want", "need", "should", "must", "problem",
 *    "solution", "goal", "constraint", "design", "add", "update",
 *    "change", "modify", "improve", "garment", "notes", "testing"
 *    -> "requirements"
 * 5. If transcript has any non-trivial content (> 20 chars) -> "requirements"
 *    (default to requirements for anything substantive)
 * 6. Otherwise -> "unknown"
 *
 * @param transcript - Raw call transcript text
 * @param callAnalysis - Optional structured call analysis from Retell
 * @returns "requirements" | "confirmation" | "unknown"
 */
export function classifyTranscript(
  transcript: string,
  callAnalysis?: Record<string, unknown>
): "requirements" | "confirmation" | "unknown";

/**
 * Derive a kebab-case spec directory name from a feature description.
 *
 * @param featureName - Human-readable feature name or title
 * @returns kebab-case slug (max 50 chars, alphanumeric + hyphens only)
 */
export function deriveSpecName(featureName: string): string;

/**
 * Map a fine-grained State to its coarse Phase group.
 */
export function stateToPhase(state: State): Phase;

/**
 * Custom error for invalid transitions.
 */
export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: State,
    public readonly event: FSMEvent
  );
}
```

**Dependencies:** `node:fs`, `node:path` (no Claude Code API dependency -- testable standalone)

**Implementation notes:**
- The transition table is a `Map<State, Map<FSMEvent, { to: State | ((ctx) => State); sideEffects: (ctx: Record<string, string>) => SideEffect[] }>>`.
- Side effects are returned, not executed. The caller (plugin hooks) executes them. This keeps the FSM pure and testable.
- `classifyTranscript` is deliberately heuristic-first. The LLM assist mentioned in FR-1.5 is handled by the Claude Code agent after triage, not inside the FSM module.
- `stateToPhase` maps demo states (`demo_setup`, `demo_calling`, `demo_active`, `demo_feedback`) to the `"demo"` phase group.

---

### 2.2 Plugin Hooks (Shell Scripts via `hooks.json`)

**Responsibility:** Orchestration glue. Plugin hooks wire filesystem events to state machine transitions. Execute side effects returned by the FSM. Inject phase-appropriate skill context into agents. Track `reviewedArtifactState` for review routing.

Hooks are **shell scripts** registered in `hooks/hooks.json` and executed by the Claude Code plugin harness. Each hook is a bash script under `scripts/` that reads environment variables and communicates with the Claude Code runtime via JSON on stdout (for decisions) and by reading/writing state files.

**Hook Registration (`hooks/hooks.json`):**

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": ".*",
        "hooks": [{ "type": "command", "command": "bash ${CLAUDE_PLUGIN_ROOT}/scripts/startup.sh", "timeout": 30 }]
      }
    ],
    "SessionEnd": [
      {
        "matcher": ".*",
        "hooks": [{ "type": "command", "command": "bash ${CLAUDE_PLUGIN_ROOT}/scripts/cleanup.sh", "timeout": 15 }]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [{ "type": "command", "command": "bash ${CLAUDE_PLUGIN_ROOT}/scripts/pre-write-guard.sh", "timeout": 10 }]
      },
      {
        "matcher": "Agent",
        "hooks": [{ "type": "command", "command": "bash ${CLAUDE_PLUGIN_ROOT}/scripts/pre-agent-guard.sh", "timeout": 10 }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [{ "type": "command", "command": "bash ${CLAUDE_PLUGIN_ROOT}/scripts/detect-artifact.sh", "timeout": 10 }]
      },
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "bash ${CLAUDE_PLUGIN_ROOT}/scripts/check-blockers.sh", "timeout": 10 }]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": ".*",
        "hooks": [{ "type": "command", "command": "bash ${CLAUDE_PLUGIN_ROOT}/scripts/inject-context.sh", "timeout": 5 }]
      }
    ],
    "Stop": [
      {
        "matcher": ".*",
        "hooks": [{ "type": "command", "command": "bash ${CLAUDE_PLUGIN_ROOT}/scripts/validate-state.sh", "timeout": 15 }]
      }
    ],
    "SubagentStop": [
      {
        "matcher": ".*",
        "hooks": [{ "type": "command", "command": "bash ${CLAUDE_PLUGIN_ROOT}/scripts/subagent-complete.sh", "timeout": 15 }]
      }
    ],
    "PreCompact": [
      {
        "matcher": ".*",
        "hooks": [{ "type": "command", "command": "bash ${CLAUDE_PLUGIN_ROOT}/scripts/pre-compact.sh", "timeout": 5 }]
      }
    ],
    "Notification": [
      {
        "matcher": ".*",
        "hooks": [{ "type": "command", "command": "bash ${CLAUDE_PLUGIN_ROOT}/scripts/notify-phase.sh", "timeout": 5 }]
      }
    ]
  }
}
```

**Hook Scripts:**

| Script | Hook Type | Matcher | Purpose |
|--------|-----------|---------|---------|
| `startup.sh` | SessionStart | `.*` | Source `.env`, ensure data dirs exist, read `current-state.txt` and `active-spec.txt`, inject initial pipeline context. |
| `cleanup.sh` | SessionEnd | `.*` | Kill server and tunnel PIDs, remove PID files. |
| `pre-write-guard.sh` | PreToolUse | `Write\|Edit` | If a gate is pending (review/confirmation), block the write and instruct the agent to run the gate CLI first. Outputs `{"decision": "block", "reason": "..."}`. |
| `pre-agent-guard.sh` | PreToolUse | `Agent` | Block agent launches if a gate is pending. Same blocking pattern as `pre-write-guard.sh`. |
| `detect-artifact.sh` | PostToolUse | `Write\|Edit` | Pattern-match artifact filenames in spec dir writes. If an SDLC artifact was written, signal the gate by writing gate state files and instructing the agent to run `trigger-gate.js`. |
| `check-blockers.sh` | PostToolUse | `Bash` | Inspect Bash tool output for blocker patterns (`permission denied`, `EACCES`, `build failed`, `FATAL`, etc.). If matched during `dev` phase, write blocker signal. |
| `inject-context.sh` | UserPromptSubmit | `.*` | Read current state, active spec, and phase. Inject pipeline context and phase-appropriate instructions into the user prompt. Check for pending trigger files. |
| `validate-state.sh` | Stop | `.*` | Run `inferState()` equivalent for drift detection. Detect new blockers/revisions. Trigger next phase activation if state changed. |
| `subagent-complete.sh` | SubagentStop | `.*` | When a subagent (dev-builder, auditor, sdlc-writer) finishes, check its output and advance the FSM if appropriate. |
| `pre-compact.sh` | PreCompact | `.*` | Before context compaction, preserve critical pipeline state (current phase, active spec, pending gates) so it survives the compaction. |
| `notify-phase.sh` | Notification | `.*` | Emit phase-change notifications for logging and external integrations. |

All hook scripts source `scripts/_resolve-data-dir.sh` to resolve the data directory path from `OPERANT_PI_DATA_DIR`.

**Hook Types Reference:**

| Hook Type | When it Fires | Available to Hooks |
|-----------|--------------|-------------------|
| `SessionStart` | Claude Code session begins | Environment setup |
| `SessionEnd` | Claude Code session ends | Cleanup |
| `PreToolUse` | Before any tool invocation | Can block via `{"decision": "block"}` |
| `PostToolUse` | After any tool invocation | Tool output, can add context |
| `UserPromptSubmit` | User submits a prompt | Can prepend/modify prompt context |
| `Stop` | Agent completes a turn | State validation, drift detection |
| `SubagentStop` | A subagent finishes | Subagent output, FSM advancement |
| `PreCompact` | Before context compaction | State preservation |
| `Notification` | Plugin emits a notification | Logging, external integrations |

**Plugin-scoped state (persisted to filesystem for crash recovery):**

```
spec/.operant/current-state.txt     # Current FSM state (single line, e.g. "dev")
spec/.operant/active-spec.txt       # Active spec directory name (single line)
spec/.operant/gate-mode.txt         # Pending gate mode (review|confirmation|blocker)
spec/.operant/gate-artifact.txt     # Artifact type for pending gate
spec/.operant/gate-spec.txt         # Spec dir for pending gate
spec/.operant/server.pid            # Webhook server PID
spec/.operant/tunnel.pid            # Cloudflared tunnel PID
spec/.operant/tunnel_url.txt        # Current tunnel URL
spec/.operant/whitelist.json        # Caller whitelist
spec/.operant/latest-trigger.txt    # Most recent trigger filename (from server)
```

**Plugin manifest (`.claude-plugin/plugin.json`):**

```json
{
  "name": "operant",
  "version": "0.2.0",
  "description": "Voice-driven autonomous development pipeline. Phone calls become shipped features through spec, build, audit, and confirmation phases.",
  "author": { "name": "Pranav Dhoolia", "email": "pranav@dhoolia.com" },
  "keywords": ["voice", "pipeline", "sdlc", "retell", "autonomous"],
  "commands": ["./commands"],
  "agents": ["./agents/auditor.md", "./agents/dev-builder.md", "./agents/sdlc-writer.md"]
}
```

**Key design principles (per ADRs):**
- File-based event detection: webhook writes triggers, hooks detect and process them (ADR-005).
- Data paths resolve from `OPERANT_PI_DATA_DIR` env var, defaulting to `$PWD/spec/.operant` (ADR-003).
- State machine logic extracted to separate TypeScript module (ADR-004).
- `detect-artifact.sh` (PostToolUse): BLOCKING on spec file writes -- signals the gate and blocks further writes until the gate is resolved (Layer 1, ADR-010).
- `check-blockers.sh` (PostToolUse): blocker pattern detection in Bash output (ADR-009).
- `validate-state.sh` (Stop): drift detection via filesystem inference, next phase activation, session cleanup (ADR-007, ADR-010).
- **Pure plugin architecture (ADR-011):** Claude Code IS the runtime. Agents run within CC. No external subprocesses except the webhook server and tunnel.
- **`/operant process` command (ADR-012):** Trigger file handling via `commands/process.md` -- classifyTranscript(), REQUIREMENTS.md creation, FSM advancement.
- **`reviewedArtifactState` tracking:** FSM saves `previousState` on `sdlc_review` entry. `REVIEW_APPROVED` uses it for routing.
- **Mock auto-approve:** When `SECONDAXIS_MOCK=1` or no phone number, auto-approve review calls and activate next phase agent.

**Commands (registered via `commands/` directory):**

| Command | File | Description |
|---------|------|-------------|
| `/operant start` | `commands/start.md` | Start the pipeline: fork server, start tunnel, register webhook |
| `/operant stop` | `commands/stop.md` | Stop the pipeline: kill server and tunnel |
| `/operant status` | `commands/status.md` | Show pipeline state, active spec, blocker count |
| `/operant process` | `commands/process.md` | Process a trigger file: classify transcript, create REQUIREMENTS.md, advance FSM |
| `/operant whitelist` | `commands/whitelist.md` | Manage caller whitelist (list, add, remove) |

**Agents (registered via `agents/` directory):**

| Agent | File | Phase | Description |
|-------|------|-------|-------------|
| sdlc-writer | `agents/sdlc-writer.md` | sdlc | Produces SDLC artifacts sequentially (intent, hld, adr, eis) |
| dev-builder | `agents/dev-builder.md` | dev | 3-agent build (Maintainer/Builder/Police) |
| auditor | `agents/auditor.md` | audit | Visual verification using auditor-browser MCP |

---

### 2.3 Module: `server.ts`

**Path:** `scripts/server.ts`

**Responsibility:** HTTP webhook server. Receives Retell callbacks and Twilio WhatsApp webhooks, writes trigger files to filesystem. No IPC to plugin -- hooks detect trigger files independently.

**Data paths:** Resolved from `OPERANT_PI_DATA_DIR` env var, defaulting to `$PWD/spec/.operant`:

```typescript
const DATA_DIR = process.env.OPERANT_PI_DATA_DIR || join(process.cwd(), "spec", ".operant");
const CALLS_DIR = join(DATA_DIR, "calls");
const PENDING_DIR = join(DATA_DIR, "pending");
const WHITELIST_PATH = join(DATA_DIR, "whitelist.json");
const MEDIA_DIR = join(DATA_DIR, "media");
const PID_FILE = join(DATA_DIR, "server.pid");
const LATEST_TRIGGER = join(DATA_DIR, "latest-trigger.txt");
const STATE_FILE = join(DATA_DIR, "current-state.txt");
```

**Trigger file protocol (file-based communication):**

The server writes trigger files to `spec/.operant/pending/`. Plugin hooks detect these files on each invocation. No direct IPC between server and plugin -- communication is entirely file-based. The server also writes `latest-trigger.txt` to signal the most recent trigger file to hooks.

**HTTP endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| POST | `/webhook/call-completed` | Retell webhook. Writes call record to `calls/` + trigger file to `pending/`. Handles `call_started` (ack only), `call_ended`, and `call_analyzed` events. |
| POST | `/webhook/caller-check` | Retell pre-call check. Returns `{ allowed: true, caller_name }` for all callers. Looks up caller name from whitelist. |
| POST | `/webhook/whatsapp` | Twilio WhatsApp webhook. Handles inbound messages (writes trigger files) and status callbacks (logs and acks). Whitelisted callers only. URL-encoded form body. |
| GET | `/health` | Health check. Returns `{ status: "ok", uptime: N }`. |
| GET | `/state` | Returns current FSM state from `current-state.txt`. Returns `{ state: "<state>" }`. |
| GET | `/media/:spec/:file` | Serve PDF artifacts from `media/<spec>/<file>`. Used by WhatsApp channel to attach review documents. Returns `application/pdf`. |

**Port:** Reads from `SECONDAXIS_PORT` env var, defaults to `3456`.

---

### 2.4 Module: `retell.ts`

**Path:** `src/retell.ts`

**Responsibility:** Retell.ai REST API client. Manages outbound calls with dynamic variables. Implements the `Channel` interface for voice gates.

**CallMode type:**

```typescript
export type CallMode = "requirements" | "blocker" | "review" | "confirmation" | "demo_invite";
```

**DynamicVariables interface:**

```typescript
export interface DynamicVariables {
  // Common to all modes
  call_mode: CallMode;

  // Blocker mode (call_mode = "blocker")
  blocker_id?: string;
  blocker_feature?: string;
  blocker_summary?: string;
  blocker_options?: string;

  // Review mode (call_mode = "review")
  artifact_type?: string;        // "intent" | "hld" | "adr" | "eis"
  artifact_summary?: string;     // 2-minute TL;DR of the artifact
  spec_name?: string;            // human-readable spec name

  // Confirmation mode (call_mode = "confirmation")
  feature_summary?: string;      // what was built
  test_results?: string;         // audit pass/fail summary

  // Demo invite mode (call_mode = "demo_invite")
  meet_url?: string;             // https://meet.google.com/abc-defg-hij
  meet_code?: string;            // abc-defg-hij

  // Index signature for extensibility
  [key: string]: string | undefined;
}
```

**`buildDynamicVars` function:**

```typescript
/**
 * Build a DynamicVariables object for a given call mode.
 * Pulls the relevant fields from `context` and sets `call_mode`.
 * Handles all 5 modes: requirements, blocker, review, confirmation, demo_invite.
 */
export function buildDynamicVars(
  mode: string,
  context: Record<string, string>
): DynamicVariables;
```

**RetellChannel class:**

```typescript
/**
 * Channel implementation for voice calls via Retell.ai.
 * Implements the Channel interface from channel.ts.
 */
export class RetellChannel implements Channel {
  readonly name = "voice" as const;
  constructor(log: (msg: string) => void, dataDir: string);
  async sendGate(context: GateContext): Promise<GateReply>;
}
```

**voiceEvents:**

```typescript
/**
 * Event bus for voice call completions.
 * The server emits "voice:reply" when a call_completed webhook arrives
 * during a pending voice gate.
 */
export const voiceEvents: EventEmitter;
```

**Other public functions (unchanged):** `createAgent`, `updateAgentWebhook`, `createPhoneNumber`, `makeOutboundCall`, `listPhoneNumbers`, `getCallDetails`, `getAgentId`, `getPhoneNumber`.

---

### 2.5 Module: `channel.ts`

**Path:** `src/channel.ts`

**Responsibility:** Channel abstraction layer for human-in-the-loop gates. Routes gate interactions to voice (Retell) or WhatsApp (Twilio) based on deterministic complexity classification. Manages timeout escalation.

**ADRs:** ADR-001 (abstraction in executor, not FSM), ADR-002 (deterministic complexity classification), ADR-006 (timeout escalation internal to ChannelRouter).

**Core types:**

```typescript
/** Result of a gate interaction, regardless of channel. */
export interface GateReply {
  interactionId: string;
  source: "voice" | "whatsapp";
  decision: "approved" | "rejected";
  rawText: string;
  feedback?: string;
  callerName: string;
  fromNumber: string;
}

/** Context passed to a channel for sending a gate message. */
export interface GateContext {
  mode: CallMode;
  specDir: string;
  specName: string;
  artifactType?: string;
  artifactSummary?: string;
  artifactPath?: string;
  blockerId?: string;
  blockerSummary?: string;
  blockerOptions?: string;
  featureSummary?: string;
  testResults?: string;
  meetUrl?: string;
  meetCode?: string;
}

/** A communication channel that can send gate messages and receive replies. */
export interface Channel {
  readonly name: "voice" | "whatsapp";
  sendGate(context: GateContext): Promise<GateReply>;
}
```

**Complexity classification (ADR-002):**

```typescript
export type Complexity = "simple" | "complex";

// Default complexity per call mode:
//   confirmation -> simple (WhatsApp first)
//   review       -> simple (WhatsApp first)
//   demo_invite  -> simple (WhatsApp first)
//   blocker      -> complex (voice directly)
//   requirements -> complex (voice directly)
//
// Overridable via env: CHANNEL_OVERRIDE_<mode>=voice|whatsapp

export function classifyComplexity(mode: CallMode): Complexity;
```

**Timeout configuration (ADR-006):**

```typescript
// Default timeouts per call mode (milliseconds):
//   confirmation -> 5 min
//   review       -> 10 min
//   demo_invite  -> 10 min
//   blocker      -> 10 min
//   requirements -> 10 min
//
// Overridable via env: CHANNEL_TIMEOUT_<mode>=<seconds>

export function getTimeout(mode: CallMode): number;
```

**ChannelRouter:**

```typescript
export class ChannelRouter {
  constructor(config: { voiceChannel: Channel; whatsappChannel: Channel; log: (msg: string) => void });

  /**
   * Send a gate via the appropriate channel based on complexity.
   * - "complex" gates go directly to voice.
   * - "simple" gates go to WhatsApp first, with timeout escalation to voice.
   * - If WhatsApp fails, falls back to voice immediately.
   */
  async sendGate(context: GateContext): Promise<GateReply>;

  /** Cancel any pending timeout escalation. */
  cancel(): void;
}
```

---

### 2.6 Module: `whatsapp.ts`

**Path:** `src/whatsapp.ts`

**Responsibility:** Twilio WhatsApp channel implementation. Sends outbound WhatsApp messages with structured reply options and waits for inbound replies.

**ADRs:** ADR-003 (Twilio sandbox for dev), ADR-005 (structured reply options), ADR-007 (separate WhatsApp number).

**Configuration (env vars):**
- `TWILIO_ACCOUNT_SID` -- Twilio account SID
- `TWILIO_AUTH_TOKEN` -- Twilio auth token
- `TWILIO_WHATSAPP_NUMBER` -- Outbound WhatsApp number (with or without `whatsapp:` prefix)
- `TWILIO_WHATSAPP_RECIPIENT` -- Default recipient (with or without `whatsapp:` prefix)
- `TWILIO_WHATSAPP_SANDBOX` -- Set to `"1"` for sandbox mode

**Public functions:**

```typescript
/**
 * Format a gate context into a WhatsApp message body.
 * Supports review, confirmation, demo_invite, and generic modes.
 * Uses structured reply options: "Reply *1* to APPROVE, Reply *2* to REJECT".
 */
export function formatGateMessage(context: GateContext): string;

/**
 * Parse an inbound WhatsApp reply text into a decision.
 * "1" -> approved, "2" -> rejected.
 * Also checks for keyword matches (approve, lgtm, ship it, etc.).
 * Unknown text defaults to rejected with the text as feedback (conservative).
 */
export function parseReply(text: string): ParsedReply;
```

**WhatsAppChannel class:**

```typescript
export class WhatsAppChannel implements Channel {
  readonly name = "whatsapp" as const;
  constructor(log: (msg: string) => void, tunnelUrl: string | null);
  setTunnelUrl(url: string): void;
  async sendGate(context: GateContext): Promise<GateReply>;
}
```

**whatsappEvents:**

```typescript
/**
 * Event bus for WhatsApp inbound replies.
 * server.ts emits "whatsapp:reply" when a Twilio webhook arrives.
 */
export const whatsappEvents: EventEmitter;
```

---

### 2.7 Module: `memory.ts`

**Path:** `src/memory.ts`

**Responsibility:** Supermemory HTTP client for the context layer. Provides semantic search over project history and memory storage.

**ADR:** Follows the same `node:https` pattern as retell.ts (ADR-002).

**Configuration:** `SUPERMEMORY_API_KEY` env var.

**Public interface:**

```typescript
export interface MemoryResult {
  content: string;
  createdAt: string; // ISO8601
}

/**
 * Search Supermemory for relevant memories.
 * Returns empty array on timeout or error (graceful degradation).
 * Default timeout: 1500ms. Default limit: 10 results.
 */
export async function searchMemories(
  query: string,
  limit?: number,
  timeoutMs?: number,
): Promise<MemoryResult[]>;

/**
 * Store a memory. Fire-and-forget -- never throws, never blocks.
 */
export function addMemory(content: string): void;
```

---

### 2.8 Module: `pdf.ts`

**Path:** `src/pdf.ts`

**Responsibility:** Convert markdown artifacts to PDF for WhatsApp media attachments. PDFs are served via the cloudflared tunnel (ADR-004).

**Public interface:**

```typescript
/**
 * Convert a markdown file to PDF using md-to-pdf.
 * Returns the absolute path to the generated PDF.
 */
export async function markdownToPdf(
  markdownPath: string,
  outputDir: string,
  outputFilename: string,
): Promise<string>;

/**
 * Generate a PDF for a spec artifact and return the media URL.
 * Writes PDF to <dataDir>/media/<specName>/<artifactType>.pdf
 * Returns URL: <tunnelUrl>/media/<specName>/<artifactType>.pdf
 */
export async function generateArtifactPdf(
  artifactPath: string,
  specName: string,
  artifactType: string,
  dataDir: string,
  tunnelUrl: string,
): Promise<string>;
```

---

### 2.9 Module: `config.ts`

**Path:** `src/config.ts`

**Responsibility:** Shared configuration helpers for CLI scripts. Reads paths from environment variables and provides state file I/O.

**Public interface:**

```typescript
/**
 * Get the data directory path.
 * Reads OPERANT_PI_DATA_DIR env var, defaults to $PWD/spec/.operant.
 */
export function getDataDir(): string;

/**
 * Get the internal specs root directory (parent of data dir).
 * Used for pipeline state management.
 */
export function getSpecsRoot(): string;

/**
 * Get the specs output directory where SDLC artifacts are written.
 * Reads OPERANT_PI_SPECS_DIR env var, defaults to $PROJECT_ROOT/docs/specs.
 */
export function getSpecsOutputDir(): string;

/**
 * Get the project root directory.
 * Reads OPERANT_PI_PROJECT_ROOT env var, defaults to process.cwd().
 */
export function getProjectRoot(): string;

/**
 * Ensure the data directory and its standard subdirectories exist.
 * Creates: specs root, data dir, calls/, pending/, processed/.
 */
export function ensureDataDir(): void;

/**
 * Read the current FSM state from current-state.txt.
 * Returns "idle" if the file is missing or unreadable.
 */
export function readState(): State;

/**
 * Write the current FSM state to current-state.txt.
 */
export function writeState(state: State): void;

/**
 * Read the active spec name from active-spec.txt.
 * Returns null if the file is missing or empty.
 */
export function readActiveSpec(): string | null;

/**
 * Write the active spec name to active-spec.txt.
 */
export function writeActiveSpec(name: string): void;
```

**Environment variables:**
- `OPERANT_PI_DATA_DIR` -- Data directory path (default: `$PWD/spec/.operant`)
- `OPERANT_PI_SPECS_DIR` -- SDLC artifact output directory (default: `$PROJECT_ROOT/docs/specs`)
- `OPERANT_PI_PROJECT_ROOT` -- Project root (default: `process.cwd()`)

---

### 2.10 Tunnel: `scripts/tunnel.sh`

**Path:** `scripts/tunnel.sh`

**Responsibility:** Cloudflared quick-tunnel lifecycle management. Manages the tunnel process that exposes the local webhook server to the internet for Retell and Twilio callbacks.

**Data paths:** `OPERANT_PI_DATA_DIR` env var, defaults to `$PWD/spec/.operant`.

**Usage:**

```bash
tunnel.sh start <port>   # Start tunnel, write PID and URL
tunnel.sh stop            # Stop tunnel, remove PID file
tunnel.sh status          # Check if tunnel is running, print URL
```

**Files managed:**
- `$DATA_DIR/tunnel.pid` -- Cloudflared process PID
- `$DATA_DIR/tunnel_url.txt` -- Current tunnel URL (e.g., `https://xxx.trycloudflare.com`)

---

## 3. Persistence (File-Based State)

### 3.1 Directory Structure

```
<project_root>/
├── .env                           # Project secrets (RETELL_API_KEY, TWILIO_*, etc.)
├── spec/
│   ├── .operant/                  # Runtime data (ADR-003) -- git-ignored
│   │   ├── calls/                 # Raw call records from Retell
│   │   │   └── <call_id>.json
│   │   ├── pending/               # Unprocessed trigger files
│   │   │   └── <timestamp>-<call_id>.json
│   │   ├── processed/             # Processed trigger files (moved from pending/)
│   │   │   └── <timestamp>-<call_id>.json
│   │   ├── media/                 # Generated PDFs for WhatsApp media attachments
│   │   │   └── <spec-name>/
│   │   │       └── <artifact-type>.pdf
│   │   ├── current-state.txt      # Current FSM state (single line, e.g. "dev")
│   │   ├── active-spec.txt        # Active spec directory name (single line)
│   │   ├── latest-trigger.txt     # Most recent trigger filename (from server)
│   │   ├── whitelist.json         # Caller whitelist
│   │   ├── server.pid             # Webhook server PID
│   │   ├── tunnel.pid             # Cloudflared PID
│   │   └── tunnel_url.txt         # Current tunnel URL
│   │
│   └── <feature-name>/            # Per-feature spec tree (one per feature)
│       ├── REQUIREMENTS.md        # Raw requirements from voice call
│       ├── intent-and-constraints.md
│       ├── high-level-design.md
│       ├── adr-lite.md
│       ├── implementation-spec.md
│       ├── blockers/              # Created on first blocker
│       │   └── <blocker-name>.md
│       ├── revisions/             # Created on first audit failure
│       │   └── <revision-name>.md
│       └── .demo/                 # Created on audit pass (demo phase)
│           ├── meet.json          # Google Meet session info
│           ├── walkthrough.json   # Walkthrough progress/state
│           └── feedback.json      # User feedback and decision
```

### 3.2 File Formats

#### current-state.txt

Single-line text file containing the current FSM state. Example: `dev\n`. Read by `config.readState()`, written by `config.writeState()`. Returns `"idle"` if missing or empty.

#### active-spec.txt

Single-line text file containing the active spec directory name. Example: `notification-preferences\n`. Read by `config.readActiveSpec()`, written by `config.writeActiveSpec()`. Returns `null` if missing or empty.

#### REQUIREMENTS.md

```markdown
# Requirements: <Feature Title>

**Status:** in-progress | complete
**Source:** Voice call <call_id> on <date>
**Caller:** <caller_name>
**Priority:** <high|medium|low>

---

## Problem Statement

<raw problem statement from caller>

## Goals

- **G-1:** <goal description> -- Measure: <how to measure>
- **G-2:** ...

## Functional Requirements

### FR-1: <Title>
<description>
- <detail>
- <detail>

### FR-2: <Title>
...

## Non-Functional Constraints

- **NFC-1:** <constraint>
- **NFC-2:** ...

## Known Boundaries

- <boundary>
- ...

## Open Questions

- <question>
- ...

## Raw Transcript

<full call transcript, preserved for reference>
```

**Status marker:** The `**Status:**` line in the YAML-like header is the canonical completion signal. `inferPhase()` reads this line to determine if a spec is active or complete.

#### Trigger File (`pending/<timestamp>-<call_id>.json`)

```json
{
  "call_id": "string -- Retell call ID",
  "caller_name": "string -- resolved name or phone number",
  "from_number": "string -- E.164",
  "to_number": "string -- E.164",
  "duration_ms": "number",
  "end_timestamp": "string -- ISO8601",
  "spec": {
    "feature_name": "string -- kebab-case (from call_analysis)",
    "feature_title": "string -- human readable",
    "problem_statement": "string",
    "goals": [{ "id": "G-1", "description": "string", "measure": "string" }],
    "functional_requirements": [{ "id": "FR-1", "title": "string", "description": "string", "details": ["string"] }],
    "non_functional_constraints": [{ "id": "NFC-1", "description": "string" }],
    "boundaries": ["string"],
    "open_questions": ["string"],
    "raw_transcript": "string -- fallback if structured analysis unavailable"
  },
  "created_at": "string -- ISO8601"
}
```

WhatsApp trigger files follow the same pattern with additional fields:

```json
{
  "call_id": "wa-<timestamp>",
  "caller_name": "string",
  "from_number": "string",
  "source": "whatsapp",
  "message_sid": "string -- Twilio message SID",
  "spec": { "raw_text": "string" },
  "created_at": "string -- ISO8601"
}
```

#### Call Record (`calls/<call_id>.json`)

```json
{
  "call_id": "string",
  "from_number": "string",
  "to_number": "string",
  "caller_name": "string",
  "duration_ms": "number",
  "end_timestamp": "string -- ISO8601",
  "transcript": "string -- full transcript text",
  "call_analysis": "object | null -- Retell's structured analysis",
  "received_at": "string -- ISO8601"
}
```

#### Blocker File (`blockers/<blocker-name>.md`)

```markdown
# Blocker: <Title>

**ID:** BLK-<NNN>
**Spec:** <feature-name>
**Created:** <ISO8601>
**Status:** open | resolved
**Resolution:** <empty until resolved>

---

## Description

<what is blocked and why>

## Context

<what was being attempted when the blocker was hit>

## Options

1. <option A>
2. <option B>
3. <option C>

## Impact

<what cannot proceed until this is resolved>
```

**Naming convention:** `<NNN>-<kebab-case-title>.md` where NNN is zero-padded sequence (001, 002, etc.).

#### Revision File (`revisions/<revision-name>.md`)

```markdown
# Revision: <Title>

**ID:** REV-<NNN>
**Source:** audit | user-feedback | demo-feedback
**Created:** <ISO8601>
**Spec:** <feature-name>

---

## What Failed

<description of the test/check that failed>

## Expected Behavior

<what the spec says should happen>

## Observed Behavior

<what actually happened>

## Evidence

<screenshot paths, console output, or test results>

## Fix Guidance

<specific guidance for the dev agent on how to fix>
```

**Naming convention:** `<NNN>-<kebab-case-title>.md`.

#### Whitelist (`whitelist.json`)

```json
{
  "callers": [
    {
      "phone": "+14155551234",
      "name": "Jane Doe",
      "role": "owner",
      "added": "2026-06-06",
      "note": "primary caller"
    }
  ],
  "default_blocker_target": "+14155551234"
}
```

---

## 4. Event Flow Contracts

### 4.1 Event: Call Completed (File-Based)

**Signaled by:** `scripts/server.ts` writing trigger file to `spec/.operant/pending/` and updating `latest-trigger.txt`  
**Detected by:** Plugin hooks (UserPromptSubmit or Stop) scanning pending directory  

**Trigger File Contents:**

```typescript
// spec/.operant/pending/<timestamp>-<call_id>.json
interface TriggerFilePayload {
  call_id: string;           // Retell call ID
  caller_name: string;       // Resolved name or phone number
  from_number: string;       // E.164 phone number
  to_number: string;         // E.164
  duration_ms: number;
  end_timestamp: string;     // ISO8601
  spec: object;              // Structured spec content (see Section 3.2)
  created_at: string;        // ISO8601
}
```

**Flow:**
1. Retell fires `call_analyzed` webhook to `POST /webhook/call-completed`
2. `server.ts` writes call record to `calls/<call_id>.json`
3. `server.ts` writes trigger to `pending/<ts>-<call_id>.json`
4. `server.ts` writes trigger filename to `latest-trigger.txt`
5. Next hook invocation (UserPromptSubmit or Stop) scans `spec/.operant/pending/`
6. Hook reads trigger file, extracts transcript/analysis
7. Hook calls `classifyTranscript()` for triage
8. Hook calls `transition(currentState, event, context)`
9. Hook executes returned side effects
10. Hook moves trigger to `spec/.operant/processed/`

### 4.2 Event: Blocker Detected (Hook-Based)

**Detected by:** PostToolUse hook (`check-blockers.sh` pattern matching) OR Stop hook (`validate-state.sh` file watching)  

**Blocker Signal (for PostToolUse detection):**

```typescript
// spec/.operant/blocker-detected.json (written by check-blockers.sh)
interface BlockerSignal {
  source: "post_tool_use" | "file_watch";
  specDir: string;           // Absolute path to active spec dir
  blockerPath?: string;      // Path to blocker .md file (if file_watch source)
  toolName?: string;         // Tool that produced the error (if post_tool_use source)
  pattern?: string;          // Matched error pattern (if post_tool_use source)
  excerpt?: string;          // First 500 chars of the error (if post_tool_use source)
  detected_at: string;       // ISO8601
}
```

**Flow (file_watch source -- Stop hook / `validate-state.sh`):**
1. Dev agent exits (Stop hook fires)
2. `detectNewBlockers(specDir, knownBlockers)` returns new files
3. Stop hook calls `transition(currentState, "BLOCKER_DETECTED", context)`
4. Side effect: trigger outbound blocker call

**Flow (post_tool_use source -- `check-blockers.sh`):**
1. PostToolUse hook matches error pattern in Bash tool output
2. Hook writes `spec/.operant/blocker-detected.json` signal file
3. Informational only -- does NOT trigger a call directly
4. File-based detection via Stop hook remains the primary trigger for blocker calls

### 4.3 Event: Phase Changed (File-Based)

**Signaled by:** Hooks writing updated state to `spec/.operant/current-state.txt` and `spec/.operant/active-spec.txt`  
**Detected by:** Next hook invocation reading FSM state from filesystem  

**State files:**

```
spec/.operant/current-state.txt    # Single line: current State value
spec/.operant/active-spec.txt      # Single line: active spec directory name
```

**Flow:**
1. Any successful `transition()` call writes new state to `current-state.txt` via `config.writeState()`
2. If the active spec changed, `config.writeActiveSpec()` updates `active-spec.txt`
3. Next hook invocation reads the updated state via `config.readState()`
4. If phase changed, hook injects new skill content appropriate to the new phase
5. UserPromptSubmit hook (`inject-context.sh`) automatically picks up new phase context on next invocation

### 4.4 File-Based Communication Protocol

All communication between the webhook server and plugin hooks is file-based. No IPC messages are used. The server writes files; hooks detect them.

```
Server writes:
  spec/.operant/pending/<ts>-<call_id>.json    # Trigger files
  spec/.operant/calls/<call_id>.json           # Call records
  spec/.operant/latest-trigger.txt             # Most recent trigger filename
  spec/.operant/server.pid                     # Server PID

Hooks read/write:
  spec/.operant/current-state.txt              # FSM state (read/write)
  spec/.operant/active-spec.txt                # Active spec (read/write)
  spec/.operant/pending/                       # Scan for new triggers
  spec/.operant/processed/                     # Move processed triggers here

File detection is deterministic:
  1. Read pending/ directory listing
  2. Compare to processed/ directory (or known-processed set)
  3. New files = unprocessed triggers
```

---

## 5. Voice Agent Modes

The Retell voice agent uses a single prompt (`prompts/voice-agent.md`) with `{{variable}}` placeholders populated via `retell_llm_dynamic_variables` on each call. The `call_mode` variable controls which conversation flow the agent follows.

### 5.1 Mode: `requirements` (Inbound)

**Trigger:** User calls in.  
**Direction:** Inbound only. Dynamic variables set to defaults by Retell agent config.

**Dynamic Variables:**

| Variable | Value | Source |
|----------|-------|--------|
| `call_mode` | `"requirements"` | Retell agent default config |
| (no other variables needed) | | Requirements mode uses the agent's base prompt |

**Voice agent behavior:** Follows the Requirements Gathering flow in `voice-agent.md`. Walks caller through Problem Statement, Goals, Functional Requirements, Non-Functional Constraints, Known Boundaries. Produces structured JSON output via `call_analysis`.

### 5.2 Mode: `blocker` (Outbound)

**Trigger:** Dev agent writes a blocker file. Plugin calls user.  
**Direction:** Outbound via `retell.makeOutboundCall()`.

**Dynamic Variables:**

| Variable | Value | Source |
|----------|-------|--------|
| `call_mode` | `"blocker"` | Hardcoded by plugin |
| `blocker_id` | `"BLK-001"` | From blocker filename |
| `blocker_feature` | `"notification-preferences"` | From active spec dir name |
| `blocker_summary` | `"The Supabase schema..."` | First 500 chars of blocker Description section |
| `blocker_options` | `"1. Add migration\n2. ..."` | Options section from blocker .md |

**Voice agent behavior:** Follows the Blocker Resolution flow. Reads blocker summary, presents options, captures decision. Produces structured JSON with `decision`, `conditions`, and `follow_up_items`.

### 5.3 Mode: `review` (Outbound)

**Trigger:** Spec agent produces an SDLC artifact. Plugin calls user for review.  
**Direction:** Outbound.

**Dynamic Variables:**

| Variable | Value | Source |
|----------|-------|--------|
| `call_mode` | `"review"` | Hardcoded by plugin |
| `artifact_type` | `"intent"` / `"hld"` / `"adr"` / `"eis"` | From current SDLC state |
| `artifact_summary` | `"This spec defines..."` | LLM-generated 2-minute TL;DR of the artifact |
| `spec_name` | `"notification-preferences"` | From active spec dir name |

**Voice agent behavior (requires prompt addition):**
```
## REVIEW (when {{call_mode}} = "review")

You are calling to review a {{artifact_type}} document for the {{spec_name}} feature.

Here is the summary:
{{artifact_summary}}

### Your approach:
1. Greet: "Hey, it's the pipeline. I have the {{artifact_type}} ready for {{spec_name}}."
2. Read back the summary clearly. Pause for questions after each section.
3. Ask: "Does this capture what you had in mind? Any changes?"
4. If they approve: "Great, I'll move to the next phase."
5. If they want changes: "What specifically should change?" -- capture details.
6. Summarize: "So you're saying [approve/revise with X changes]. Correct?"
7. End call.
```

**Structured output for review calls:**
```json
{
  "call_mode": "review",
  "artifact_type": "{{artifact_type}}",
  "decision": "approved" | "revise",
  "revision_notes": "string -- empty if approved",
  "specific_changes": ["string -- list of requested changes"]
}
```

### 5.4 Mode: `confirmation` (Outbound)

**Trigger:** Demo approved (or demo skipped/failed). Plugin calls user to confirm satisfaction.  
**Direction:** Outbound.

**Dynamic Variables:**

| Variable | Value | Source |
|----------|-------|--------|
| `call_mode` | `"confirmation"` | Hardcoded by plugin |
| `feature_summary` | `"We built notification..."` | 3-sentence summary of what was implemented |
| `test_results` | `"All 12 FRs verified..."` | Summary of audit results |
| `spec_name` | `"notification-preferences"` | From active spec dir name |

**Voice agent behavior (requires prompt addition):**
```
## CONFIRMATION (when {{call_mode}} = "confirmation")

You are calling to confirm that the {{spec_name}} feature is complete.

**What was built:** {{feature_summary}}
**Test results:** {{test_results}}

### Your approach:
1. Greet: "Hey, the {{spec_name}} feature is built and verified."
2. Read the summary: {{feature_summary}}
3. Read test results: {{test_results}}
4. Ask: "Are you satisfied with this, or do you want changes?"
5. If YES: "Perfect, I'll mark it complete. Call anytime with the next feature."
6. If NO: Probe specifically:
   - "What isn't right?"
   - "What did you expect to see?"
   - "Can you describe the difference between what you wanted and what you got?"
7. Capture pain points as structured revision notes.
8. End call.
```

**Structured output for confirmation calls:**
```json
{
  "call_mode": "confirmation",
  "decision": "confirmed" | "rejected",
  "pain_points": ["string -- specific complaints if rejected"],
  "expected_behavior": "string -- what the user wanted",
  "observed_behavior": "string -- what they got"
}
```

### 5.5 Mode: `demo_invite` (Outbound)

**Trigger:** Demo environment ready. Plugin calls user to join Google Meet.  
**Direction:** Outbound.

**Dynamic Variables:**

| Variable | Value | Source |
|----------|-------|--------|
| `call_mode` | `"demo_invite"` | Hardcoded by plugin |
| `spec_name` | `"notification-preferences"` | From active spec dir name |
| `feature_summary` | `"Your feature is ready..."` | Summary of what was built |
| `meet_url` | `"https://meet.google.com/abc-defg-hij"` | From demo setup |
| `meet_code` | `"abc-defg-hij"` | From demo setup |

**Voice agent behavior:**
```
## DEMO INVITE (when {{call_mode}} = "demo_invite")

You are calling to invite the user to a live demo of their {{spec_name}} feature.

**Feature:** {{feature_summary}}
**Meet URL:** {{meet_url}}
**Meet code:** {{meet_code}}

### Your approach:
1. Greet: "Hey, your {{spec_name}} feature is ready for demo."
2. Explain: "I've set up a live demo you can walk through."
3. Share: "Join at {{meet_url}} or use code {{meet_code}}."
4. Ask: "Would you like to join now, or skip the demo and go straight to confirmation?"
5. If YES: "Great, I'll wait for you to join."
6. If SKIP: "No problem, I'll call back for final confirmation."
7. End call.
```

**Structured output for demo invite calls:**
```json
{
  "call_mode": "demo_invite",
  "decision": "join" | "skip",
  "meet_url": "{{meet_url}}",
  "meet_code": "{{meet_code}}"
}
```

---

## 6. Skills

### 6.1 Skill: `sdlc-skill/`

**Source:** Plugin skill directory `skills/sdlc-skill/`.

**Structure:**

```
skills/sdlc-skill/
└── SKILL.md               # Complete SDLC methodology, templates, and triggers
```

The `SKILL.md` contains the full SDLC methodology including templates for all four artifacts (intent-and-constraints, high-level-design, adr-lite, implementation-spec) embedded as sections within the single file.

**Loaded when:** `Phase === "sdlc"` (injected via `inject-context.sh` UserPromptSubmit hook)

**Agent behavior when loaded:** The sdlc-writer agent reads the skill content and follows the SDLC methodology to produce artifacts sequentially. Each artifact is written to the active spec dir. After writing, the `detect-artifact.sh` PostToolUse hook detects the artifact and triggers the review gate.

### 6.2 Skill: `development-methodology/`

**Source:** Plugin skill directory `skills/development-methodology/`.

**Structure:**

```
skills/development-methodology/
└── SKILL.md
```

**SKILL.md sections:**

1. **Three-Agent Build Methodology** -- CEO delegates to Maintainer, Builder, and Police subagents. CEO never writes code directly.
2. **Maintainer Role** -- Reads all specs + revisions. Creates implementation plan. Assigns scoped tasks to Builders.
3. **Builder Role** -- Receives scoped task from Maintainer. Implements exactly what is specified. Cannot open browser or modify scope.
4. **Police Role** -- Reviews Builder output against spec. Runs tests. Reports pass/fail to Maintainer.
5. **Blocker Protocol** -- If any agent encounters an unresolvable issue, write a blocker .md to `spec/<name>/blockers/` and EXIT immediately. Do not attempt workarounds.
6. **Revision Handling** -- On re-activation, read ALL files in `spec/<name>/revisions/` as additive context on top of the original implementation-spec. Revisions override conflicting sections of the original spec.
7. **Exit Criteria** -- Dev loop is complete when: all FRs implemented, Police passes all checks, no new blockers written.

**Loaded when:** `Phase === "dev"` (injected via `inject-context.sh` UserPromptSubmit hook)

### 6.3 Skill: `audit-methodology/`

**Source:** Plugin skill directory `skills/audit-methodology/`.

**Structure:**

```
skills/audit-methodology/
└── SKILL.md
```

**SKILL.md sections:**

1. **Visual Verification Protocol** -- Use `auditor-browser` MCP server (headless Playwright) to test each FR against the running app.
2. **Dev Server Management** -- Check if dev server is running. If not, start it. Wait for ready state.
3. **Test Execution** -- For each FR in `implementation-spec.md`: navigate to relevant page, perform the action, screenshot the result, compare against expected behavior.
4. **Evidence Collection** -- Save screenshots to `proof-of-working/<spec-name>/`. Each screenshot named `FR-<N>-<description>.png`.
5. **Pass/Fail Criteria** -- All FRs must pass. Any failure results in a revision file.
6. **Revision Writing** -- On failure, write a revision .md to `spec/<name>/revisions/` with: What Failed, Expected Behavior, Observed Behavior, Evidence paths, Fix Guidance.
7. **Exit Criteria** -- Audit is complete when: all FRs checked, all screenshots captured, pass/fail determination made, revision written if needed.

**Loaded when:** `Phase === "audit"` (injected via `inject-context.sh` UserPromptSubmit hook)

### 6.4 Skill: `pipeline-knowledge/`

**Source:** Plugin skill directory `skills/pipeline-knowledge/`.

**Structure:**

```
skills/pipeline-knowledge/
└── SKILL.md
```

**Responsibility:** Knowledge about the operant voice pipeline -- FSM states, transitions, phases, artifact sequence, human gates, and how the autonomous development loop works. Used when Claude needs to understand pipeline behavior, interpret pipeline state, route decisions, or explain pipeline mechanics.

**Loaded when:** Any phase, on demand (referenced by the `/operant` commands and the `operant:pipeline-knowledge` skill trigger).

---

## 7. Traceability Matrix

| Requirement | HLD Section | ADR | EIS Section | Test Category |
|-------------|-------------|-----|-------------|---------------|
| **FR-1.1** Inbound calls via Retell | 4. Flow A (1-4) | -- | 2.3 server.ts, 4.1 call-completed | webhook_integration |
| **FR-1.2** Transcript classification | 4. Flow A (9) | D-1, D-10 (ADR-012) | 2.1 `classifyTranscript()` (call_analysis first, expanded keywords) | triage_classification |
| **FR-1.3** Create spec dir + REQUIREMENTS.md | 4. Flow A (7) | D-10 (ADR-012) | 1.3 T3, 3.2 REQUIREMENTS.md format, `/operant process` | spec_creation |
| **FR-1.4** Confirmation marks complete | 4. Flow A | -- | 1.3 T4, 3.2 STATUS marker | spec_completion |
| **FR-1.5** Classification heuristics | 4. Flow A (9) | D-1 | 2.1 `classifyTranscript()` algorithm | triage_heuristics |
| **FR-2.1** Spec agent activation on REQUIREMENTS.md | 4. Flow A (8-9) | ADR-006, ADR-011 | 1.3 T3, 2.2 hook-based agent activation | agent_launch |
| **FR-2.2** Produce intent doc | 4. Flow A (13) | -- | 1.3 T6 (ARTIFACT_PRODUCED) | sdlc_artifact |
| **FR-2.3** Outbound review call per artifact | 4. Flow A (14) | -- | 1.3 T6-T9, 5.3 review mode | review_call |
| **FR-2.4** Approval/rejection handling | 4. Flow A (13) | D-9 | 1.3 T10-T11 (`reviewedArtifactState` routing), 5.3 structured output | review_decision |
| **FR-2.5** Sequential SDLC phases | 4. Flow A (15) | -- | 1.2 States (sdlc_intent through sdlc_eis) | sdlc_sequence |
| **FR-2.6** EIS approval triggers P1 | 4. Flow A (16) | -- | 1.3 T12 | phase_transition |
| **FR-3.1** Dev agent with methodology | 4. Flow B | ADR-006 | 2.2 hook skill injection, 6.2 dev-methodology | dev_agent |
| **FR-3.2** Dev reads all specs + revisions | 4. Flow B | D-6 | 2.2 hook context injection, 6.2 Revision Handling | dev_context |
| **FR-3.3** Dev subagents (Maintainer/Builder/Police) | 4. Flow B | -- | 6.2 Three-Agent Build | dev_subagents |
| **FR-3.4** Blocker written on block | 4. Flow B (2) | -- | 3.2 Blocker format, 6.2 Blocker Protocol | blocker_write |
| **FR-3.5** Hook+state driven detection | 4. Flow B (4) | ADR-009, ADR-010 | 2.1 `detectNewBlockers()`, 4.2, PostToolUse check-blockers.sh | blocker_detection |
| **FR-3.6** Outbound blocker call | 4. Flow B (6) | -- | 1.3 T13, 5.2 blocker mode | blocker_call |
| **FR-3.7** Blocker resolution re-activates dev | 4. Flow B (8-9) | -- | 1.3 T15 | blocker_resolution |
| **FR-3.8** Dev complete when no blockers | 4. Flow B | -- | 1.3 T14, 6.2 Exit Criteria | dev_completion |
| **FR-4.1** Auditor agent launch | 4. Flow C (2-4) | ADR-006 | 1.3 T14, 6.3 audit-methodology | audit_launch |
| **FR-4.2** Auditor uses auditor-browser MCP | 4. Flow C (5) | -- | 6.3 Visual Verification | audit_browser |
| **FR-4.3** Check each FR against app | 4. Flow C (5) | -- | 6.3 Test Execution | audit_verification |
| **FR-4.4** Dev server management | 4. Flow C | -- | 6.3 Dev Server Management | audit_devserver |
| **FR-4.5** Audit fail writes revision | 4. Flow C (6) | -- | 1.3 T16, 3.2 Revision format | audit_revision |
| **FR-4.6** Audit pass triggers demo | 4. Flow C (9) | -- | 1.3 T18 (audit -> demo_setup), 1.2 demo states | audit_demo |
| **FR-4.7** User confirms -> complete | 4. Flow C (10) | -- | 1.3 T19 | completion_flow |
| **FR-4.8** User rejects -> pain points -> revision | 4. Flow C (10) | -- | 1.3 T20, 5.4 structured output | rejection_revision |
| **FR-5.1** Dynamic variables via `{{variable}}` | 3. Voice Agent | D-3 | 5.1-5.5 variable tables | dynamic_vars |
| **FR-5.2** Five call modes | 3. Voice Agent | D-3 | 5.1-5.5 | call_modes |
| **FR-5.3** Distinct flows per mode | 3. Voice Agent | -- | 5.1-5.5 voice agent behaviors | call_flows |
| **FR-5.4** Extract pain points on rejection | 3. Voice Agent | -- | 5.4 confirmation structured output | pain_extraction |
| **FR-6.1** sdlc-skill in plugin | 3. Component Descriptions | ADR-006 | 6.1 | skill_sdlc |
| **FR-6.2** development-methodology skill | 3. Component Descriptions | ADR-006 | 6.2 | skill_dev |
| **FR-6.3** audit-methodology skill | 3. Component Descriptions | ADR-006 | 6.3 | skill_audit |
| **FR-6.4** pipeline-knowledge skill | 3. Component Descriptions | -- | 6.4 | skill_pipeline |
| **FR-7.1** Demo phase after audit | -- | -- | 1.2 demo states, 1.3 T18/T22-T28 | demo_phase |
| **FR-7.2** Demo invite via voice/WhatsApp | -- | -- | 5.5 demo_invite mode, 2.5 channel routing | demo_invite |
| **FR-7.3** Demo feedback loop | -- | -- | 1.3 T25-T27, demo_feedback state | demo_feedback |
| **FR-7.4** Demo skip/failure fallback | -- | -- | 1.3 T23/T28, confirmation fallback | demo_fallback |
| **FR-8.1** WhatsApp channel for simple gates | -- | ADR-001, ADR-002 | 2.5 channel.ts, 2.6 whatsapp.ts | whatsapp_channel |
| **FR-8.2** Complexity-based routing | -- | ADR-002 | 2.5 classifyComplexity() | channel_routing |
| **FR-8.3** Timeout escalation | -- | ADR-006 | 2.5 ChannelRouter, getTimeout() | timeout_escalation |
| **FR-8.4** WhatsApp webhook endpoint | -- | ADR-003 | 2.3 POST /webhook/whatsapp | whatsapp_webhook |
| **FR-8.5** PDF media attachments | -- | ADR-004 | 2.8 pdf.ts, 2.3 GET /media/:spec/:file | pdf_media |
| **FR-9.1** Context layer (Supermemory) | -- | -- | 2.7 memory.ts | context_layer |
| **FR-9.2** Semantic memory search | -- | -- | 2.7 searchMemories() | memory_search |
| **FR-9.3** Memory storage | -- | -- | 2.7 addMemory() | memory_storage |
| **NFC-1** Deterministic transitions | 6. D-1 | ADR-001, ADR-004 | 1.1-1.3 (entire FSM) | fsm_determinism |
| **NFC-2** File-based state | 6. D-4 | ADR-003 | 1.5 Phase Inference, 3.1 Dir Structure | crash_recovery |
| **NFC-3** Pure plugin arch (Claude Code) | 6. D-5 | ADR-002, ADR-011 | 2.2 Plugin Hooks (agents run in CC runtime) | session_model |
| **NFC-4** Call latency < 30s | 3. Component Descriptions | -- | 4.1 Flow steps 1-11 | call_latency |
| **NFC-5** Retell gpt-4o-mini | 5. Technology Choices | -- | 5.1-5.5 (Retell config, not code) | cost_model |

---

## 8. Open Question Resolutions

These resolutions are binding for implementation:

| ID | Question | Resolution | Rationale |
|----|----------|------------|-----------|
| OQ-1 | How to summarize long artifacts for phone? | Generate a 2-minute TL;DR focusing on key decisions. Pass as `artifact_summary` dynamic variable. Agent reads it aloud and asks "Does this capture it?" For WhatsApp, also attach PDF via tunnel. | Phone calls are for decisions, not document reading (HLD OQ-1 default). WhatsApp can carry richer content. |
| OQ-2 | Dev loop timeout? | No timeout for v1. Stop hook counts blocker files. After 5 blockers on the same spec, the blocker call context includes: "We've hit 5 blockers on this feature. Consider simplifying scope." | Avoids complexity. The human can always say "stop" on the phone (HLD OQ-2 default). |
| OQ-3 | Multiple concurrent specs? | Single-spec-at-a-time for v1. `getCurrentSpec()` returns the first non-complete spec. If a new call arrives while a spec is active, triage classifies it as context for the active spec (revision/clarification), not a new spec. | Simplicity. Concurrent specs require multi-session management, which is out of scope (HLD Non-Goals). |
| OQ-4 | Where do completed specs go? | Stay in `spec/` with `STATUS: complete` marker in REQUIREMENTS.md. No archival. | Inspectable, git-trackable (HLD OQ-3 default, ADR-003). |
| OQ-5 | Persist phase or infer? | Hybrid: `current-state.txt` and `active-spec.txt` for fast reads, with `inferState()` as crash-recovery fallback. | Fast reads for hooks, with filesystem inference as safety net. |

---

## 9. Implementation Sequencing

The following order minimizes integration risk. Each step produces a testable artifact.

| Step | Module | Deliverable | Dependencies | Status |
|------|--------|-------------|--------------|--------|
| 1 | `state-machine.ts` | FSM with all 18 states, 28 transitions (including demo), inference. Unit-testable standalone. | None | Done |
| 2 | `scripts/server.ts` | Webhook server with `OPERANT_PI_DATA_DIR` env var, file-based triggers, WhatsApp webhook, media serve, state endpoint. | None (parallel with step 1) | Done |
| 3 | `retell.ts` | Expand `DynamicVariables` with demo_invite mode, `buildDynamicVars`, RetellChannel class, voiceEvents. | None (parallel with step 1) | Done |
| 4 | `scripts/tunnel.sh` | Cloudflared tunnel management, `OPERANT_PI_DATA_DIR` env var. | None (parallel with step 1) | Done |
| 5 | `config.ts` | Shared config helpers: `getDataDir`, `readState`/`writeState`, `readActiveSpec`/`writeActiveSpec`, `getSpecsOutputDir`, `getProjectRoot`. | None (parallel with step 1) | Done |
| 6 | Plugin hooks | Shell script hooks via `hooks/hooks.json`: startup.sh, cleanup.sh, pre-write-guard.sh, pre-agent-guard.sh, detect-artifact.sh, check-blockers.sh, inject-context.sh, validate-state.sh, subagent-complete.sh, pre-compact.sh, notify-phase.sh. | Steps 1-5 | Done |
| 7 | `voice-agent.md` | Add `review`, `confirmation`, and `demo_invite` prompt sections. | None (parallel with step 6) | Done |
| 8 | Skills | sdlc-skill, development-methodology, audit-methodology, pipeline-knowledge -- all single SKILL.md files. | None (parallel with step 6) | Done |
| 9 | `channel.ts` | Channel abstraction: GateReply, GateContext, Channel interface, ChannelRouter with complexity classification and timeout escalation. | Steps 3, 10 | Done |
| 10 | `whatsapp.ts` | WhatsAppChannel, formatGateMessage, parseReply, whatsappEvents. Twilio HTTP client. | None (parallel with step 9) | Done |
| 11 | `memory.ts` | Supermemory client: searchMemories, addMemory. Graceful degradation on timeout/error. | None (parallel with step 9) | Done |
| 12 | `pdf.ts` | markdownToPdf, generateArtifactPdf. md-to-pdf integration for WhatsApp media. | None (parallel with step 9) | Done |
| 13 | `src/cli/trigger-gate.ts` | CLI for triggering gates: cross-process FSM transitions via filesystem polling. | Steps 1, 5 | Done |
| 14 | Integration test | End-to-end test with mock Retell. 28 transitions, 4 review calls + demo phase, all artifacts written, PASS. Full SDLC cycle validated: intent -> review -> hld -> review -> adr -> review -> eis -> review -> dev -> audit -> demo -> confirmation. | Steps 6-13 | PASS |
