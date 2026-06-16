<!-- #core -->
# Intent & Constraints: Shared Context Layer for Pipeline Sessions

**Version:** 2.0  
**Date:** 2026-06-06  
**Status:** Implemented  
**Source:** Research on AI agent memory frameworks + architectural analysis  
**Audience:** Implementation agents (Claude Code plugin hooks, MCP servers, phase agents)

---

## 1. Problem Statement

The operant Claude Code plugin executes pipeline phases (SDLC spec, dev loop, audit loop) as hook-triggered agent runs within Claude Code. Each phase starts cold — the agent receives only its phase-specific skill prompt and reads filesystem artifacts. There is no mechanism for semantic context to flow between phases:

- The **dev agent** doesn't know what the spec agent learned about user preferences during voice review calls ("user always wants dark mode", "use Tailwind not CSS modules").
- The **audit agent** doesn't know what conventions the dev agent established or what architectural trade-offs were made during implementation.
- **Cross-feature learnings** are lost — if the pipeline built Feature A and learned "this codebase uses Zustand for state management", the Feature B pipeline starts from zero.
- **Blocker resolutions** are captured as files but their semantic implications ("user prefers X approach over Y") don't persist beyond the immediate phase.

The current file-based context (spec/, blockers/, revisions/) is structured but not semantic. It provides *what* was decided, but not *why* in a way that future phases can query and apply.

---

## 2. Goals

- **G-1:** Every execution phase in the pipeline can query and retrieve relevant context from prior phases — within the same feature and across features.
- **G-2:** Context is captured automatically at phase boundaries (phase-completion hooks, review call completion, blocker resolution) without requiring the agent to explicitly "save" memories.
- **G-3:** Context retrieval is scoped — a dev agent gets dev-relevant memories, not noise from unrelated features or phases.
- **G-4:** All execution happens within the Claude Code plugin runtime. The context layer integrates via MCP tool calls and `src/memory.ts` HTTP client — no separate orchestrator or external API calls from hook scripts.
- **G-5:** Integration adds minimal latency to phase transitions — context retrieval should complete in under 2 seconds.

---

## 3. Functional Requirements

### FR-1: Memory Persistence
Memories must persist across phase execution lifecycles. When one phase completes and the next begins (same feature or different feature), relevant memories are retrievable.

### FR-2: Automatic Capture
Context should be captured at these lifecycle points via hooks:
- **Phase completion:** When a phase-completion hook fires, key decisions/learnings from that phase are stored via MCP `add_memories` calls or the `src/memory.ts` `addMemory()` function.
- **Post-review:** After a voice/WhatsApp review completes and the user's feedback is processed, the feedback and any preference signals are stored.
- **Post-blocker:** After a blocker is resolved via phone call or WhatsApp, the resolution rationale is stored.
- **Post-audit:** After an audit pass/fail, the audit findings are stored.

### FR-3: Scoped Retrieval
When an agent begins a phase, it should retrieve context filtered by:
- **Feature scope:** Memories from the current feature's pipeline (highest priority).
- **Project scope:** Cross-feature learnings about the target codebase (e.g., coding conventions, architectural patterns).
- **User scope:** User preferences learned across all interactions (e.g., "user prefers concise specs", "user wants tests for all public APIs").

### FR-4: MCP Integration
The context layer should be accessible via MCP (Model Context Protocol) so that agents can query it using standard tool calls during execution. The Supermemory MCP server is registered in the plugin's `.mcp.json` and provides `search_memories` and `add_memories` tools to all agents.

### FR-5: On-Demand Retrieval via MCP
Agents access memories on-demand by calling the `search_memories` MCP tool during execution. There is no pre-injection step — agents know about the memory tools via MCP server registration in the plugin's `.mcp.json` and query when they need context. The cold-start problem is addressed by the agent's skill prompt mentioning available memory tools.

### FR-6: Memory Lifecycle
Memories should support:
- **Creation** with scope tags (feature, project, user).
- **Search** by semantic similarity and scope filters.
- **Update** when newer information supersedes older context.
- **Expiry/decay** for time-sensitive context (e.g., "dev server is on port 3001" may change).

---

## 4. Non-Functional Constraints

### NFC-1: Dual Memory Access
Memory operations happen via two paths: (1) MCP tool calls by agents during execution (via the Supermemory MCP server), and (2) direct HTTP calls from `src/memory.ts` for programmatic access by TypeScript modules (e.g., hook scripts, pipeline utilities). The `src/memory.ts` module provides `searchMemories()` and `addMemory()` functions using the Node.js `https` module against the Supermemory Cloud API.

### NFC-2: Latency Budget
- On-demand MCP `search_memories` calls: < 2 seconds per query.
- Phase-completion capture via MCP `add_memories` or `src/memory.ts` `addMemory()`: synchronous but bounded — < 3 seconds per memory. Capture must complete before next phase begins.
- In-session MCP tool calls: < 1 second per query.

### NFC-3: Cost
- Prefer solutions with a free tier or self-hostable option.
- Per-query costs (if any) must be negligible relative to the pipeline's operational model.
- Must not introduce per-token API billing that undermines cost efficiency.

### NFC-4: Data Locality
- Memories about the target project should stay local or in a controlled service.
- No code snippets or sensitive project data should be sent to third-party services without explicit opt-in.
- Self-hosted option must be viable.

### NFC-5: Resilience
- Pipeline must function if the context layer is unavailable — graceful degradation to current behavior (file-based context only).
- Memory service downtime should not block phase execution.
- `src/memory.ts` returns empty arrays on timeout or error (graceful degradation built in).

### NFC-6: Plugin Architecture Alignment
- The context layer is native to the Claude Code plugin model — MCP tools are the primary integration mechanism for agent access, and `src/memory.ts` provides programmatic access for TypeScript modules.
- No architectural assumptions that would require refactoring if Claude Code's plugin system evolves.
- All agent memory access is through MCP, which is the stable contract between plugins and the runtime.

---

## 5. Known Boundaries and Limitations

### What This Is NOT
- **Not a replacement for file-based state.** The spec/ directory structure remains the source of truth for pipeline state. The context layer adds semantic memory on top, not instead of.
- **Not a knowledge base or RAG system.** This is scoped, structured memory for pipeline sessions — not a general-purpose document retrieval system for the codebase.
- **Not real-time sync.** Memories are captured at lifecycle boundaries (phase completion hooks, review, blocker resolution), not streamed during agent execution.

### Open Questions (All Resolved)
- [x] **Q-1:** Hosting model — Supermemory cloud. See ADR-001.
- [x] **Q-2:** Memory conflicts — last-write-wins via Supermemory's recency ranking. See ADR-004.
- [x] **Q-3:** Capture mechanism — structured text extraction in hooks + `addMemory()` in `src/memory.ts`. See ADR-006.
- [x] **Q-4:** Memory granularity — atomic facts, one per decision/preference. See ADR-007.
- [x] **Q-5:** Source attribution — compact source tags in retrieved memory format. See ADR-008.

---

## 6. Success Criteria

- **SC-1:** A dev agent running for Feature B can retrieve and apply a coding convention learned during Feature A's dev phase — without that convention being in any spec file.
- **SC-2:** An audit agent knows what the dev agent's implementation approach was, reducing redundant code exploration.
- **SC-3:** After a blocker is resolved via phone call or WhatsApp, the resolution rationale is available to all future phases — not just the immediately subsequent one.
- **SC-4:** The pipeline runs end-to-end with the context layer disabled (graceful degradation).
- **SC-5:** MCP memory tool calls complete in under 2 seconds.
