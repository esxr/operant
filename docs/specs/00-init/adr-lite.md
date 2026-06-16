<!-- #core -->
# Architecture Decisions: Operant

**Last Updated:** 2026-06-10

---

## ADR-001: TypeScript over Plain ESM JavaScript

**Status:** Accepted

**Context:**  
The plugin could be written in plain ESM `.mjs` or TypeScript. The codebase spans `src/` (state machine, channel router, retell client, whatsapp client, memory client, PDF gen, config, CLI tools) and `scripts/` (shell-script hooks). Claude Code plugins use TypeScript natively.

**Decision:**  
Use TypeScript for all plugin source files in `src/` and `scripts/server.ts`. Use shell scripts for hook entry points in `scripts/*.sh`.

**Alternatives Considered:**

| Option | Pros | Cons |
| --- | --- | --- |
| TypeScript (.ts) | Claude Code plugin API is TS-native; discriminated unions for state/event messages; compile-time guards on state transitions; no build step via tsx | tsx adds startup latency; AI agents don't benefit from IDE type feedback |
| Plain ESM (.mjs) | Zero dependencies; what you write is what runs; Claude Code prototype worked fine | Reimplements half of TS value via JSDoc; loses exhaustive switch checking on state types; writes JS against a TS-native API |

**Rationale:**  
The "no build step" fact neutralizes the main argument against TS. The state machine (18 states, 23 events, 15 side effect types) and hook event types are exactly the problem space where discriminated unions prevent real bugs — a misspelled state type during a live phone call is expensive. Shell scripts are used for hook entry points (`hooks/hooks.json` → `scripts/*.sh`) because Claude Code hooks execute shell commands via `bash ${CLAUDE_PLUGIN_ROOT}/scripts/...`. The shell scripts call into TypeScript CLI tools (`src/cli/*.ts`) for logic.

**Consequences:**
- `"type": "module"` in package.json for ESM compatibility
- Hook entry points are shell scripts; complex logic lives in TypeScript CLI tools
- No compilation step needed; tsx handles execution

---

## ADR-002: Hook-Based Event Injection for Call Completion

**Status:** Accepted

**Context:**  
When the webhook server (`scripts/server.ts`) receives a completed call, the plugin needs to inject the call result into the running Claude Code session and advance the pipeline. In a Claude Code plugin architecture, hooks (`hooks/hooks.json`) are the primary mechanism for injecting context and controlling agent behavior. Available hook types: SessionStart, SessionEnd, PreToolUse, PostToolUse, UserPromptSubmit, Stop, SubagentStop, PreCompact, Notification.

**Decision:**  
Use PostToolUse/Stop hooks (via `scripts/detect-artifact.sh`, `scripts/check-blockers.sh`, `scripts/validate-state.sh`) to detect filesystem changes from call webhooks, and inject call completion context into the agent via hook responses.

**Alternatives Considered:**

| Option | Pros | Cons |
| --- | --- | --- |
| File-based event detection via hooks | Deterministic; hooks fire on every tool use; structured context injected automatically; no external API dependency | Must poll filesystem or watch for trigger files |
| Direct agent prompting | Simpler mental model | No structured details; timing depends on agent availability |

**Rationale:**  
Call completions are system events, not user input. Hook-based detection correctly models this — the webhook writes a trigger file to `spec/.operant/pending/`, and the next hook invocation detects it and injects structured context (callId, callerName) into the agent. This prevents interrupting active work and keeps event handling deterministic. (Ref: NFC-3 single session, D-5)

**Consequences:**
- Webhook handler writes trigger files to `spec/.operant/pending/`; hooks detect and process them
- Session context clearly distinguishes user input from call events
- Structured details available for phase inference on session recovery

---

## ADR-003: Project-Level Data Directory over Plugin-Bundled Data

**Status:** Accepted

**Context:**  
The current implementation stores runtime data (`calls/`, `pending/`, `processed/`, `.env`, PID files) inside the plugin directory at `data/`. This means reinstalling the plugin wipes state, and secrets live inside the plugin.

**Decision:**  
Move runtime data to `<projectRoot>/spec/.operant/` and secrets to the project's `.env`. Path resolved via `OPERANT_PI_DATA_DIR` env var, defaulting to `$PWD/spec/.operant` (see `src/config.ts`).

**Alternatives Considered:**

| Option | Pros | Cons |
| --- | --- | --- |
| `data/` inside plugin | Self-contained; no external dependencies | Reinstalls wipe state; secrets in plugin dir; git-tracking plugin includes runtime artifacts |
| `<projectRoot>/spec/.operant/` | Survives plugin reinstalls; colocated with specs; git-ignorable separately | Requires knowing project root at runtime |
| `~/.claude/data/operant/` | Global, survives everything | Not project-scoped; multiple projects would collide |

**Rationale:**  
Runtime data (call records, triggers, PID files) is project-scoped — it relates to a specific project's specs. Colocating it with `spec/` keeps everything inspectable. Claude Code provides the project CWD via the session context. Secrets should use the project `.env`, not a bundled file. (Ref: NFC-2 file-based state, B-5)

**Consequences:**
- `src/config.ts` resolves `dataDir` from `OPERANT_PI_DATA_DIR` env var, defaulting to `join(cwd, "spec", ".operant")`
- State files: `current-state.txt` (FSM state), `active-spec.txt` (current spec name)
- `.env` secrets (RETELL_API_KEY, TWILIO_ACCOUNT_SID, SUPERMEMORY_API_KEY, etc.) read from project `.env`
- `.gitignore` in project root should include `spec/.operant/`
- Plugin directory contains only code, skills, and prompts — no runtime state

---

## ADR-004: Extract State Machine into Separate Module

**Status:** Accepted

**Context:**  
All pipeline logic (phase transitions, hook handling, tool registration, lifecycle management) could live in a single plugin entry point. As the state machine grows (now 18 states, 23 events, 15 side effect types including demo phase), this becomes unwieldy.

**Decision:**  
Extract the state machine into `src/state-machine.ts`. Shell-script hooks in `scripts/*.sh` call CLI tools in `src/cli/*.ts` which import the FSM module.

**Alternatives Considered:**

| Option | Pros | Cons |
| --- | --- | --- |
| Monolithic plugin entry | Simple; everything in one place | Grows to 1000+ lines; hard to test state logic independently |
| Separate plugins per phase | Clean separation | No inter-plugin dependency ordering; phases share state (server, tunnel, current spec) |
| State machine module + glue hooks | FSM testable independently; hooks stay thin; phases share state naturally via module scope | One more file |

**Rationale:**  
The plugin uses hooks as the primary orchestration mechanism, but nothing prevents importing modules. The FSM has its own concerns (phase transitions, file-based state inference, blocker detection) that are independent of hook registration. Splitting per-phase into separate plugins is wrong because there is no dependency ordering and phases share state.

**Consequences:**
- `src/state-machine.ts` exports: types (`State`, `Phase`, `FSMEvent`, `SideEffect`), `transition()`, `InvalidTransitionError`
- CLI tools (`src/cli/transition.ts`, `src/cli/infer-state.ts`, `src/cli/post-agent-check.ts`) import FSM and provide entry points for shell-script hooks
- FSM is pure functions + filesystem reads — testable without Claude Code

---

## ADR-005: File-Based Event Decoupling for Server Communication

**Status:** Accepted

**Context:**  
The webhook server (`scripts/server.ts`) receives call completions and needs to signal the plugin. Direct coupling between the server process and the hook logic makes the system hard to test and inflexible.

**Decision:**  
Server writes trigger files to `spec/.operant/pending/`. Plugin hooks (via shell scripts) detect new trigger files on each invocation and process them.

**Alternatives Considered:**

| Option | Pros | Cons |
| --- | --- | --- |
| Direct coupling in server handler | Simple; fewer moving parts | Untestable; tight coupling; server must know plugin internals |
| File-based trigger detection | Decoupled; testable; any process can write triggers; hooks detect them naturally | One level of indirection via filesystem |

**Rationale:**  
File-based events align with the plugin's core design principle (NFC-2: file-based state). The webhook server writes a trigger file, and the next hook invocation detects and processes it. This is inspectable, crash-resumable, and testable without running Claude Code.

**Consequences:**
- Server writes trigger files to `spec/.operant/pending/`
- Plugin hooks scan for pending triggers on each invocation
- Processed triggers are moved to `spec/.operant/processed/`

---

## ADR-006: Dynamic Skill Loading via Hooks

**Status:** Accepted

**Context:**  
The pipeline has distinct phases that each need different skills: SDLC phase needs `sdlc-skill`, P1 needs `development-methodology`, P2 needs `audit-methodology`, and all phases benefit from `pipeline-knowledge`. Loading all skills at all times wastes context window and confuses the agent. Four skills exist in `skills/*/SKILL.md`.

**Decision:**  
Use hook-based context injection (via `scripts/inject-context.sh` on `UserPromptSubmit` and `scripts/pre-write-guard.sh` on `PreToolUse`) to dynamically load phase-appropriate skills into the agent's context.

**Alternatives Considered:**

| Option | Pros | Cons |
| --- | --- | --- |
| All skills loaded always | Simple; no dynamic loading | Wastes context; agent may use wrong methodology for current phase |
| Dynamic via hooks | Agent only sees relevant skill; cleaner context; hooks inject skill content per phase | Must track phase state to determine which skill to inject |
| Static CLAUDE.md with all skills | Zero dynamic loading | Bloated context; agent may use wrong methodology for current phase |

**Rationale:**  
UserPromptSubmit and PreToolUse hooks fire before agent actions and can inject skill content based on the current pipeline phase. By reading the FSM state from `spec/.operant/current-state.txt` and injecting only the relevant skill content, the agent always knows what phase it's in and what methodology to follow. Phase transitions naturally cause the next hook invocation to inject the new skill.

**Consequences:**
- Hooks read current phase from `current-state.txt` and inject appropriate skill content
- Phase-aware context: "You are in phase P1 (dev). Follow the development-methodology skill."
- Phase transitions naturally cause skill context to change on next hook invocation

---

## ADR-007: Session Shutdown Cleanup

**Status:** Accepted

**Context:**  
When Claude Code exits (Ctrl+C, crash, SIGHUP), the webhook server and cloudflared tunnel continue running as orphan processes.

**Decision:**  
Register a SessionEnd hook (`scripts/cleanup.sh`) that kills the server and tunnel processes. Combined with PID-file cleanup on startup (`scripts/startup.sh`).

**Alternatives Considered:**

| Option | Pros | Cons |
| --- | --- | --- |
| No cleanup | Simpler | Orphaned processes on every exit; port 3456 stays occupied |
| SessionEnd hook cleanup | Clean exit; no orphans; fires when session ends | None — this is the correct plugin pattern |
| PID-file-based cleanup on next startup | Handles crashes too | Doesn't help for the current session; stale PID files can point to wrong process |

**Rationale:**  
The SessionEnd hook fires when the Claude Code session ends, providing a natural cleanup point. Combined with PID-file cleanup on startup (for crash recovery), this covers both graceful and ungraceful exits. The Stop hook (`scripts/validate-state.sh`) provides additional state validation when the agent finishes a turn.

**Consequences:**
- SessionEnd hook (`scripts/cleanup.sh`) kills server + tunnel via PID files
- On next startup (`scripts/startup.sh`), check for stale PID files and clean up

**Resolves:** HLD Risk "Claude Code session crashes mid-pipeline"

---

## ADR-008: Phase-Aware Context via UserPromptSubmit Hook

**Status:** Accepted

**Context:**  
The agent needs to know which pipeline phase it's in (idle/triage/sdlc/dev/audit/demo/confirmation) to apply the correct methodology. This context needs to be consistently available without manual repetition.

**Decision:**  
Use the `UserPromptSubmit` hook (`scripts/inject-context.sh`) to inject phase context into the agent's working context before every user prompt. Supplemented by `PreToolUse` hooks (`scripts/pre-write-guard.sh`, `scripts/pre-agent-guard.sh`) for write and agent guards.

**Alternatives Considered:**

| Option | Pros | Cons |
| --- | --- | --- |
| Repeat phase in every message | Explicit | Verbose; wastes tokens; easy to forget |
| UserPromptSubmit hook injection | Automatic; fires before every prompt; zero-maintenance | Requires reading phase from filesystem state |

**Rationale:**  
The UserPromptSubmit hook fires before every user prompt is processed, providing a natural injection point for phase context. Reading the current phase from `current-state.txt` and injecting the phase, active spec name, and blocker count gives the agent persistent awareness without manual repetition. PreToolUse hooks add guardrails for specific tool types (Write/Edit writes, Agent spawning).

**Consequences:**
- `scripts/inject-context.sh` injects: current phase, active spec, blocker count
- `scripts/pre-write-guard.sh` guards Write/Edit operations during SDLC phase
- `scripts/pre-agent-guard.sh` guards Agent spawning (ensures correct agent for phase)
- Agent always knows its context without explicit instructions

---

## ADR-009: Blocker Detection via PostToolUse Hook Interception

**Status:** Accepted

**Context:**  
The current design detects blockers by watching for new files in `spec/<name>/blockers/` via the Stop hook. An additional detection layer can intercept tool results to catch blockers in real-time (e.g., a bash command returning a specific error pattern).

**Decision:**  
Use PostToolUse hooks (`scripts/check-blockers.sh` on Bash, `scripts/detect-artifact.sh` on Write/Edit) as blocker and artifact detection mechanisms alongside state validation via the Stop hook (`scripts/validate-state.sh`).

**Alternatives Considered:**

| Option | Pros | Cons |
| --- | --- | --- |
| File watching only (Stop hook) | Simple; explicit | Misses blockers that aren't written to files; detection delayed until agent stops |
| PostToolUse hook interception | Real-time detection; catches error patterns; can auto-escalate | More complex; risk of false positives |
| Both | Defense in depth | Slightly more code |

**Rationale:**  
Some blockers manifest as tool failures (e.g., missing env var, failed build) before the agent formally writes a blocker doc. Intercepting PostToolUse for known error patterns allows faster detection. File watching via the Stop hook remains the primary mechanism for formal blockers.

**Consequences:**
- `scripts/check-blockers.sh` (PostToolUse on Bash) checks for patterns: permission denied, env var missing, build failed
- `scripts/detect-artifact.sh` (PostToolUse on Write/Edit) detects SDLC artifact creation and triggers review gates
- Does not replace file-based blocker detection — augments it

---

## ADR-010: Hook+State Driven Pipeline (Defense in Depth)

**Status:** Accepted

**Context:**  
The pipeline failed in production because the agent wrote spec artifacts but nothing triggered the FSM to advance. The `advance-pipeline` tool approach (agent-driven) is probabilistic — the agent can forget to call it. Pipeline transitions must be deterministic.

**Decision:**  
Use 4 layers of transition detection, in priority order:

1. **PostToolUse hook (BLOCKING)** — `scripts/detect-artifact.sh` fires on every Write/Edit to `spec/` files. Pattern-matches artifact filenames. Blocks the agent until the review call completes. Deterministic, can't be skipped.
2. **Stop hook** — `scripts/validate-state.sh` fires when the agent finishes a turn. Runs `src/cli/infer-state.ts` to detect phase changes missed by Layer 1. Catches dev/audit completion. Triggers next agent phase if needed.
3. **SubagentStop hook** — `scripts/subagent-complete.sh` fires when a subagent finishes. Runs `src/cli/post-agent-check.ts` to validate subagent output and advance pipeline if appropriate.
4. **`/operant process` command (escape hatch)** — manually trigger pipeline processing. Best case: hooks already handled it, command is a no-op.

**Alternatives Considered:**

| Option | Pros | Cons |
| --- | --- | --- |
| Agent-driven only (advance-pipeline tool) | Simple; explicit | Agent can forget; probabilistic; failed in production |
| Hook-driven only | Deterministic; can't be skipped | May miss edge cases; no manual override |
| Defense in depth (4 layers) | Covers all cases; deterministic primary + probabilistic fallback | More code; potential double-fires (handled via FSM idempotency) |

**Rationale:**  
Hooks are deterministic; agents are probabilistic. For guaranteed behavior (review calls at every gate), the primary mechanism must be a hook. The command is kept as an escape hatch. Double-fire risk is mitigated by FSM transition validation — `InvalidTransitionError` is caught and ignored when the state was already advanced by a hook.

**Consequences:**
- PostToolUse hook on Write/Edit detects artifact writes and blocks the agent
- Stop hook runs state inference after every agent turn, advances FSM and triggers next agent
- SubagentStop hook validates subagent completion and advances pipeline
- `/operant process` command kept as manual fallback
- FSM must handle duplicate transition attempts gracefully (catch InvalidTransitionError)

---

## ADR-011: Pure Plugin Architecture — Claude Code IS the Runtime

**Status:** Accepted

**Context:**  
The pipeline needs an orchestration layer that drives the FSM, manages hooks, handles webhooks, and triggers Retell calls. Rather than an external orchestrator process, Claude Code itself serves as both the runtime and the agent execution environment. The plugin uses the Claude Code plugin mechanism (`.claude-plugin/plugin.json`) with shell-script hooks (`hooks/hooks.json`), commands (`commands/*.md`), and agents (`agents/*.md`).

**Decision:**  
Claude Code IS the runtime. The plugin uses hooks (9 types: SessionStart, SessionEnd, PreToolUse, PostToolUse, UserPromptSubmit, Stop, SubagentStop, PreCompact, Notification) to orchestrate pipeline phases. Agents run within Claude Code's own runtime — no external subprocesses. The FSM runs inside TypeScript modules (`src/state-machine.ts`), called from shell-script hooks that detect filesystem changes. State transitions are deterministic code; LLM work happens naturally as the Claude Code agent operates within each phase.

**Alternatives Considered:**

| Option | Pros | Cons |
| --- | --- | --- |
| External orchestrator + subprocess agents | Process isolation; independent lifecycle | Complex subprocess management; IPC overhead; orphan process risk |
| Pure plugin architecture | Zero subprocess overhead; hooks provide deterministic control; agents have direct access to MCP servers; skills loaded via hooks; no process management | All state must be file-based for crash recovery |
| Agent SDK direct | Official API; structured tool use | Separate runtime; unnecessary when Claude Code already provides the agent |

**Rationale:**  
Claude Code already provides the agent runtime, MCP server access, and hook infrastructure. Using it directly eliminates subprocess management complexity, IPC overhead, and orphan process risk. Shell-script hooks provide deterministic orchestration (PostToolUse detects artifact writes, Stop hook advances FSM), while the agent naturally performs LLM work within each phase. The `reviewedArtifactState` tracking pattern (save previous state on entering `sdlc_review`, use it for routing on `REVIEW_APPROVED`) works identically in hooks.

**Consequences:**
- Agents (`agents/sdlc-writer.md`, `agents/dev-builder.md`, `agents/auditor.md`) run within Claude Code's runtime
- Shell-script hooks (`hooks/hooks.json`) detect artifact creation, blockers, state changes
- Stop hooks advance the FSM and activate the next pipeline phase with appropriate skill context
- Mock auto-approve: when `OPERANT_MOCK=1` or no phone number, review calls are auto-approved (enables e2e testing without Retell)
- `reviewedArtifactState`: FSM saves `previousState` when entering `sdlc_review`; `REVIEW_APPROVED` uses it to route correctly (intent→hld, hld→adr, adr→eis, eis→dev)
- MCP servers (e.g., auditor-browser) are directly available to agents via plugin `.mcp.json` configuration

**Validated:** 11 transitions, 4 review calls, all artifacts written, PASS. Full SDLC cycle: intent → review → hld → review → adr → review → eis → review → dev.

---

## ADR-012: `/operant process` Command for Trigger File Handling

**Status:** Accepted

**Context:**  
Trigger files from call webhooks need to be processed to classify transcripts, create REQUIREMENTS.md, and activate the first SDLC phase agent. This processing is deterministic and should happen in plugin code, not require LLM judgment.

**Decision:**  
Implement a `/operant process` command (`commands/process.md`) that handles trigger files via `src/cli/process-trigger.ts`. The CLI tool reads the trigger file, classifies the transcript via `classifyTranscript()`, creates REQUIREMENTS.md, and advances the FSM.

**Alternatives Considered:**

| Option | Pros | Cons |
| --- | --- | --- |
| LLM processes triggers | Uses natural language understanding | Wastes tokens on deterministic work; non-reproducible |
| Plugin code handles triggers | Zero LLM cost; deterministic; testable | Must implement `classifyTranscript()` heuristics in code |
| Separate script/process | Decoupled | Another process to manage; complexity |

**Rationale:**  
Trigger file processing is fundamentally deterministic: read JSON, classify transcript (heuristic), create a markdown file, activate the next pipeline phase. No LLM judgment is needed. Keeping it in TypeScript CLI code means the test harness and the webhook handler share the same code path.

**`classifyTranscript()` improvements:**
- `call_analysis` is checked BEFORE empty transcript check (call_analysis.call_summary is authoritative)
- Expanded requirement keywords for broader matching
- Stricter confirmation matching (reduces false positives)
- Non-trivial transcripts (>20 chars) default to `"requirements"` not `"unknown"`

**Consequences:**
- `/operant process` is the single entry point for trigger file handling
- Both the webhook handler and manual invocation use the same CLI tool (`src/cli/process-trigger.ts`)
- No LLM dependency for any part of the trigger → spec pipeline
- `classifyTranscript()` heuristics are unit-testable standalone
