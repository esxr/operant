<!-- #core -->
# High-Level Design: Shared Context Layer for Pipeline Sessions

**Version:** 3.0  
**Date:** 2026-06-06  
**Status:** Implemented  
**Revision:** v1.0 -> v1.1: Switched from self-hosted Mem0 to Supermemory. v1.1 -> v2.0: All open questions resolved via ADR-Lite. v2.0 -> v3.0: Recontextualized for pure Claude Code plugin model with `src/memory.ts` HTTP client.

## 1. Overview

The context layer adds persistent semantic memory to the operant Claude Code plugin's pipeline, enabling agents running within Claude Code to share learnings, decisions, and user preferences across phases and features. It integrates via two paths: (1) MCP tool calls for agent access during execution, and (2) `src/memory.ts` for programmatic access by TypeScript modules and hook scripts. Agents call `search_memories` on-demand during execution, and phase-completion hooks call `addMemory()` to capture context. The existing file-based state in `spec/` remains the source of truth for pipeline transitions; the context layer sits alongside it as a queryable knowledge store.

Supermemory provides the memory backend as a managed cloud service with a zero-config MCP plugin for Claude Code. Additionally, `src/memory.ts` provides a lightweight HTTP client (`searchMemories`, `addMemory`) for direct programmatic access using the Node.js `https` module. Claude Code IS the runtime — there are no external subprocesses or separate orchestrators.

## 2. Goals and Non-Goals

### Goals
- Cross-phase memory: phase B's agent retrieves what phase A's agent learned
- Automatic capture at lifecycle boundaries via hooks (phase completion, review, blocker resolution)
- Scoped retrieval (feature -> project -> user) to minimize noise
- Native integration with the Claude Code plugin model via MCP and `src/memory.ts`
- Graceful degradation when memory service is unavailable

### Non-Goals
- Replacing the `spec/` directory as source of truth for FSM state
- Building a general-purpose RAG system over the codebase
- Real-time memory streaming during agent execution
- Self-hosting the memory layer (accepted trade-off for simplicity)

## 3. System Architecture

### Component Diagram

```
                    ┌──────────────────────────────────────────┐
                    │         Claude Code Runtime              │
                    │                                          │
                    │  ┌────────────────────────────────────┐  │
                    │  │       Operant Plugin                │  │
                    │  │                                     │  │
                    │  │  hooks/hooks.json                   │  │
                    │  │  ├─ SessionStart → startup.sh       │  │
                    │  │  ├─ PostToolUse → detect-artifact.sh│  │
                    │  │  ├─ Stop → validate-state.sh        │  │
                    │  │  └─ ...                             │  │
                    │  │                                     │  │
                    │  │  agents/                            │  │
                    │  │  ├─ dev-builder.md                  │  │
                    │  │  ├─ auditor.md                      │  │
                    │  │  └─ sdlc-writer.md                  │  │
                    │  │                                     │  │
                    │  │  src/memory.ts  ←── HTTP client     │  │
                    │  │  (searchMemories, addMemory)        │  │
                    │  └────────────────────────────────────┘  │
                    │         │                │               │
                    │    MCP tool calls   src/memory.ts        │
                    │    (agents)         (hooks/scripts)      │
                    │         │                │               │
                    │  ┌──────▼────────────────▼────────────┐  │
                    │  │     Supermemory MCP Server          │  │
                    │  │     (registered in .mcp.json)       │  │
                    │  │     • search_memories               │  │
                    │  │     • add_memories                  │  │
                    │  └──────────────┬─────────────────────┘  │
                    └─────────────────┼────────────────────────┘
                                      │  HTTP (MCP server + src/memory.ts)
                                      ▼
                              ┌──────────────────────┐
                              │ Supermemory Cloud API │
                              │ api.supermemory.ai    │
                              │ • POST /v3/memories   │
                              │ • POST /v3/search     │
                              └──────────────────────┘
```

### Component Descriptions

| Component | Responsibility | Key Interfaces |
|-----------|---------------|----------------|
| **Supermemory Cloud** | Managed memory backend. Stores memories as embeddings, handles semantic search, deduplication, and retrieval ranking. | REST API: `POST /v3/memories` (add), `POST /v3/search` (query). Accessed by the MCP server and by `src/memory.ts`. |
| **Supermemory MCP Server** | Exposes memory tools to all agents and hooks within Claude Code. Registered in `.mcp.json`. Handles HTTP transport to the Supermemory Cloud API internally. | `search_memories(query)` -> returns relevant memories. `add_memories(content)` -> stores new memory. |
| **`src/memory.ts`** | Lightweight HTTP client for programmatic memory access by TypeScript modules and scripts. Uses Node.js `https` module with the same `node:https` pattern as `src/retell.ts`. Provides `searchMemories()` and `addMemory()` functions. Returns empty arrays on timeout/error (graceful degradation). | `searchMemories(query, limit?, timeoutMs?)` -> `MemoryResult[]`. `addMemory(content)` -> fire-and-forget. |
| **Phase-Completion Hooks** | Hook scripts (registered in `hooks/hooks.json`) that fire at lifecycle boundaries. Extract structured summaries from phase artifacts and store them via `addMemory()` or MCP `add_memories` calls. | Hook receives phase context (specDir, state). Calls memory API with tagged content. |
| **Phase Agents** | Agent runs within Claude Code that execute pipeline phases (spec, dev, audit). Query memories on-demand via MCP `search_memories` calls when they need context from prior phases. | Agent calls `search_memories` tool during execution. No pre-injection — agents know about memory tools via MCP registration. |

## 4. Data Flow

### 4.1 On-Demand Memory Retrieval (FR-5)

```
Agent begins phase execution (triggered by hook/skill)
  │
  ├─ 1. Agent's skill prompt includes instruction:
  │     "You have access to search_memories and add_memories MCP tools.
  │      Query prior context before making key decisions."
  │
  ├─ 2. Agent calls MCP tool: search_memories({
  │       query: "[feature:${specName}] [phase:${state}] context for ${state} phase",
  │       limit: 10
  │     })
  │
  ├─ 3. Supermemory MCP server handles HTTP internally:
  │     POST https://api.supermemory.ai/v3/search → returns relevant memories
  │
  ├─ 4. Agent receives memories as tool response:
  │     [ { content: "User prefers Tailwind...", createdAt: "..." },
  │       { content: "HLD decided on REST over GraphQL...", createdAt: "..." } ]
  │
  └─ 5. Agent incorporates memories into its reasoning and decisions
        (if MCP call fails, agent proceeds without memories — graceful degradation)
```

### 4.2 Phase-Completion Capture (FR-2)

```
Phase-completion hook fires (specDir, completedState)
  │
  ├─ 1. Read the phase output (artifact content, blocker file, revision file)
  │
  ├─ 2. Extract structured summary (headings + first paragraph — same
  │     technique already used for review call artifact_summary)
  │
  ├─ 3. Tag with metadata prefix:
  │     content = "[feature:${basename(specDir)}] [phase:${completedState}] ${summary}"
  │
  ├─ 4. Store via src/memory.ts addMemory(content) or MCP add_memories tool
  │     addMemory() is fire-and-forget with 5-second timeout.
  │
  └─ NOTE: The capture payload is structured text, NOT raw file content.
           The hook reads the file and extracts headings/summary. No LLM needed.
```

### 4.3 In-Session MCP Access (FR-4)

```
Claude Code agent (during phase execution)
  │
  ├─ Agent decides it needs context:
  │   "What conventions does this codebase use for state management?"
  │
  ├─ Calls MCP tool: search_memories({ query: "state management conventions" })
  │
  ├─ Supermemory MCP server queries cloud API → returns relevant memories
  │
  └─ Agent uses memories to inform implementation decisions
```

### 4.4 Post-Review Capture

```
Review completes → hook fires
  │
  ├─ Hook extracts user feedback from call transcript/WhatsApp reply
  │
  ├─ If feedback contains preference signals:
  │   Call addMemory() from src/memory.ts:
  │   addMemory("[user-preference] [feature:${specName}] User prefers X over Y. Reason: <from feedback>")
  │
  └─ Pipeline continues normally (FSM transition for REVIEW_APPROVED/REVIEW_REJECTED)
```

## 5. Technology Choices

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Memory backend | **Supermemory** (managed cloud) | Zero-config MCP plugin for Claude Code. Purpose-built for coding agent memory. Shared memory across sessions out of the box. No infrastructure to manage. |
| MCP server | **Supermemory MCP plugin** | One-command install. Added to `.mcp.json` alongside existing auditor-browser and context7. All agents get memory tools automatically via MCP registration. |
| HTTP client | **`src/memory.ts`** using Node.js `https` | Follows the same `node:https` pattern as `src/retell.ts` (ADR-002). Provides `searchMemories()` (with graceful degradation) and `addMemory()` (fire-and-forget) for programmatic access by hooks and scripts. |
| Memory retrieval | **On-demand MCP `search_memories` tool calls** | Agents call `search_memories` when they need context. No pre-injection or prompt manipulation. MCP is the primary access mechanism for agents. |
| Phase-completion capture | **`src/memory.ts` `addMemory()` in hooks** | Hook scripts extract structured summaries and store them via the HTTP client. Fire-and-forget with timeout to prevent pipeline stalls. |
| Scoping | **Tag-based via content prefixes** | Supermemory doesn't have native multi-scope tagging like Mem0. We encode scope as content prefixes: `[feature:login]`, `[phase:dev]`, `[user-preference]`. Semantic search still finds them by relevance. |

## 6. Key Design Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D-1 | Supermemory cloud over self-hosted Mem0 | Simplicity. Zero infrastructure — no Docker, Qdrant, Ollama. One-command install. Serves the current purpose. Can migrate to Mem0 self-hosted later if data locality becomes critical (the integration surface is just MCP + HTTP, vendor-swappable). |
| D-2 | Dual access: MCP for agents, `src/memory.ts` for scripts | Agents access memory via MCP tool calls (the native Claude Code mechanism). TypeScript modules and hook scripts use `src/memory.ts` for programmatic access. This provides flexibility: agents get the MCP interface, scripts get a direct HTTP client. |
| D-3 | MCP-only retrieval for agents (no spawn-time injection) | Agents call `search_memories` on-demand during execution. The cold-start problem is solved by skill prompts that instruct agents to query memory tools at the start of each phase. This is simpler than dual-path access and eliminates prompt manipulation. |
| D-4 | Fire-and-forget capture via `addMemory()` in `src/memory.ts` | The `addMemory()` function is fire-and-forget with a 5-second timeout. Failures are logged but never throw. This ensures memory capture never blocks the pipeline. |
| D-5 | Structured text extraction for capture, not raw file dump | Hooks extract headings + first paragraph from phase artifacts. Same technique for memory capture. Keeps memories concise and queryable without requiring LLM summarization. |
| D-6 | Content-prefix scoping instead of native scope fields | Supermemory's search is semantic — including `[feature:login]` or `[user-preference]` in the content means scope-related queries naturally match. Simpler than maintaining separate metadata. Trade-off: less precise filtering. Acceptable for v1. |
| D-7 | Accept cloud data trade-off for v1 | NFC-4 (data locality) is partially relaxed. Memory content (summaries, decisions, preferences) is sent to Supermemory cloud. Raw code is NOT sent — only structured summaries. If this becomes a concern, migration path to Mem0 self-hosted is straightforward (swap MCP server entry in `.mcp.json` and update `src/memory.ts` API host). |

## 7. Open Questions (All Resolved)

- [x] **Q-1 (hosting model):** Supermemory cloud. No Docker needed. -- See ADR-001.
- [x] **Q-2 (memory conflicts):** Last-write-wins via Supermemory's recency ranking. No explicit conflict resolution in v1. -- See ADR-004.
- [x] **Q-3 (capture mechanism):** Structured text extraction in phase-completion hooks (headings + first paragraph), no LLM needed. Stored via `src/memory.ts` `addMemory()`. -- See ADR-006.
- [x] **Q-4 (memory granularity):** Atomic facts. One memory per decision/preference. -- See ADR-007.
- [x] **Q-5 (source attribution):** Yes, include compact source tags in retrieved memory format. -- See ADR-008.
- [x] **Ollama vs. cloud embeddings:** N/A — Supermemory handles embeddings internally. -- See ADR-001.
- [x] **Access pattern:** Dual: MCP for agents, `src/memory.ts` HTTP client for scripts. -- See ADR-002.
- [x] **API key management:** Env var (`SUPERMEMORY_API_KEY`), passed to MCP server via `.mcp.json` env config and read directly by `src/memory.ts`. -- See ADR-002.

## 8. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Supermemory service unavailable (outage, network issue) | M | Graceful degradation: MCP tool calls return empty results, `src/memory.ts` `searchMemories()` returns `[]`, agent proceeds without memories. `addMemory()` failures are logged but never throw. Pipeline runs as it does today. |
| Memory pollution: bad/stale memories degrade agent quality | H | Content-prefix scoping limits blast radius. Recency bias in Supermemory's ranking. Memories can be deleted via API. v2: add explicit expiry. |
| Latency blow-up: Supermemory API takes > 2s | M | MCP tool calls have built-in timeout handling. `searchMemories()` has a configurable timeout (default 1500ms). Limit retrieval to 10 results. |
| Data sent to cloud (NFC-4 relaxation) | M | Only structured summaries sent, never raw code. Content prefixes don't contain sensitive data. Migration path to Mem0 self-hosted documented if this becomes a blocker. |
| NFC-1 violation: capture requires LLM summarization | H | v1 uses structured text extraction (headings + paragraphs) in hooks. No LLM needed. If richer extraction needed in v2, the hook can instruct the agent to extract and store memories before completing. |
| Agent fails to query memories | M | Skill prompts explicitly instruct agents to call `search_memories` at the start of each phase. Hooks capture memories regardless of whether agents query them. |
| Supermemory lacks native scope filtering | L | Content-prefix convention (`[feature:X]`, `[phase:Y]`) provides soft scoping via semantic search. Less precise than Mem0's metadata filters, but sufficient for v1 memory volumes. |

## 9. Traceability

| Intent | HLD Section | Notes |
|--------|-------------|-------|
| G-1: Cross-phase retrieval | S4.1 (On-Demand Retrieval), S4.3 (MCP Access) | Dual access: on-demand MCP tool calls + `src/memory.ts` programmatic API |
| G-2: Automatic capture | S4.2 (Phase-Completion Capture), S4.4 (Post-Review Capture) | Captures at lifecycle points via hooks using `addMemory()` per FR-2 |
| G-3: Scoped retrieval | S6 D-6, S4.1 step 2 | Content-prefix scoping: `[feature:X]`, `[phase:Y]`, `[user-preference]` |
| G-4: All execution within Claude Code | S5 (MCP server + memory.ts), S6 D-2 | Dual access. No external orchestrator. |
| G-5: < 2s latency | S4.1 (MCP tool call), S8 row 3 | MCP timeout handling + `searchMemories()` 1500ms default timeout |
| FR-1: Memory persistence | S5 (Supermemory cloud) | Managed persistent storage |
| FR-2: Automatic capture | S4.2, S4.4 | Phase-completion and post-review capture via hooks |
| FR-3: Scoped retrieval | S6 D-6 | Content-prefix convention with semantic search |
| FR-4: MCP integration | S5 (Supermemory MCP plugin), S4.3 | Added to `.mcp.json`, available to all agents |
| FR-5: On-demand retrieval | S4.1 | Agents call `search_memories` MCP tool during execution |
| FR-6: Memory lifecycle | S5 (Supermemory API supports CRUD), S8 row 2 | Create, search, delete via MCP tools and `src/memory.ts` |
| NFC-1: Dual memory access | S6 D-2 | MCP for agents, `src/memory.ts` for scripts |
| NFC-2: Latency | S4.1 (MCP timeout), S4.2 (capture) | Bounded timeouts enforced |
| NFC-3: Cost | S6 D-1 | Supermemory free tier. Upgrade path if needed. |
| NFC-4: Data locality | S6 D-7 | Partially relaxed — summaries sent to cloud, not raw code. Migration path documented. |
| NFC-5: Resilience | S8 row 1 | Graceful degradation: `searchMemories()` returns `[]`, `addMemory()` never throws |
| NFC-6: Plugin architecture | S5 (MCP + memory.ts), S3 (Component Diagram) | Native Claude Code plugin model. MCP is the stable contract. |
