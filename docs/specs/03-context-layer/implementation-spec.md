<!-- #core -->
# Implementation Specification: Shared Context Layer

**Version:** 2.0 (Revised for Claude Code plugin architecture)  
**Date:** 2026-06-06  
**Based on:** HLD v3.0, ADR-Lite v1.0

---

## 1. Memory Access: Dual Path (MCP + HTTP Client)

**Responsibility:** Memory operations are accessible via two paths: (1) MCP tool calls by agents during execution, and (2) `src/memory.ts` HTTP client for programmatic access by TypeScript modules and hook scripts.

### 1.1 MCP Tool Interface

The Supermemory MCP server (registered in `.mcp.json`) exposes two tools available to all agents:

```
search_memories(query: string, limit?: number) → MemoryResult[]
  - Semantic search for relevant memories
  - Returns empty array if service unavailable (graceful degradation)
  - Agents call this on-demand during phase execution (ADR-003)

add_memories(content: string) → { success: boolean }
  - Store a new memory with content-prefix scope tags
  - Hooks can use this or src/memory.ts addMemory() (ADR-005)
```

### 1.2 `src/memory.ts` HTTP Client (IMPLEMENTED)

The `src/memory.ts` module provides a lightweight HTTP client for programmatic memory access. It follows the same `node:https` pattern as `src/retell.ts` (ADR-002).

```typescript
import https from "node:https";

const API_HOST = "api.supermemory.ai";

export interface MemoryResult {
  content: string;
  createdAt: string; // ISO8601
}

/**
 * Search Supermemory for relevant memories.
 * Returns empty array on timeout or error (graceful degradation).
 */
export async function searchMemories(
  query: string,
  limit = 10,
  timeoutMs = 1500,
): Promise<MemoryResult[]>;

/**
 * Store a memory. Fire-and-forget — never throws, never blocks.
 */
export function addMemory(content: string): void;
```

**Key behaviors:**
- `searchMemories()` returns `[]` on any error (timeout, network failure, API error) — graceful degradation built in
- `addMemory()` is fire-and-forget with a 5-second timeout — failures are logged via `console.log` but never throw
- Both read `SUPERMEMORY_API_KEY` from environment
- HTTP requests use `node:https` with `Bearer` auth header

### 1.3 How Agents Access Memory

Agents call MCP tools directly during execution. No wrapper module needed:

```
Agent (during dev phase):
  → search_memories({ query: "[feature:login] [phase:dev] state management conventions" })
  ← [{ content: "[feature:login] [phase:spec] Use Zustand for state...", createdAt: "..." }]

Agent uses result to inform implementation decisions.
```

### 1.4 How Hooks/Scripts Access Memory

Hook scripts and TypeScript modules use `src/memory.ts` for programmatic access:

```typescript
import { addMemory, searchMemories } from "./memory.js";

// Store a memory (fire-and-forget)
addMemory("[feature:login] [phase:dev] Implemented auth with JWT, refresh tokens in httpOnly cookies");

// Search memories (with graceful degradation)
const memories = await searchMemories("[feature:login] coding conventions", 5);
// Returns [] if service unavailable
```

### 1.5 Error Handling

| Scenario | Behavior | Rationale |
|----------|----------|-----------|
| `SUPERMEMORY_API_KEY` not set | `searchMemories()` throws, `addMemory()` logs error. Pipeline continues without memory. | Graceful degradation (NFC-5). |
| `searchMemories()` timeout (default 1500ms) | Returns `[]`. | Bounded timeout per NFC-2. |
| `addMemory()` timeout (5s) | Logs failure, does not throw. | Fire-and-forget — capture failures must not block pipeline. |
| Supermemory API 4xx/5xx | `searchMemories()` returns `[]`. `addMemory()` logs error. | Memories are supplementary, not authoritative (ADR-005). |
| MCP server not running | MCP tools not available in agent's tool list. Agent proceeds without memory. `src/memory.ts` still works independently. | Two independent access paths provide redundancy. |

---

## 2. Integration: Skill Prompts — On-Demand Memory Retrieval

**Files:** Agent definitions in `agents/*.md`  
**Pattern:** Each phase agent includes an instruction block telling the agent to query memories at the start of execution. (See ADR-003)

### Skill Prompt Addition

Each phase agent (spec, dev, audit) includes a memory retrieval instruction. Example for the dev agent:

```markdown
<!-- In agents/dev-builder.md -->

## Memory Context

Before beginning implementation work, query prior context:

1. Call `search_memories` with query: "[feature:{feature_name}] [phase:dev] conventions and decisions"
2. Call `search_memories` with query: "[project] coding conventions and architecture patterns"
3. Review returned memories and apply relevant context to your implementation decisions.

If `search_memories` is not available (MCP server not configured), proceed without memory context.
```

### Phase-Specific Query Patterns

| Phase | Primary Query | Secondary Query |
|-------|--------------|-----------------|
| **SDLC Spec** | `[feature:{name}] prior spec decisions` | `[user-preference] spec preferences` |
| **Dev Loop** | `[feature:{name}] [phase:dev] conventions and decisions` | `[project] coding conventions` |
| **Audit Loop** | `[feature:{name}] [phase:dev] implementation approach` | `[feature:{name}] [phase:audit] prior findings` |
| **Review** | `[feature:{name}] user feedback and preferences` | `[user-preference] review preferences` |

### Cold-Start Handling

The cold-start problem (agent doesn't know to check memory) is solved by skill prompt instructions rather than prompt injection. This approach:

- Works natively with the Claude Code plugin model (agents are static markdown)
- Requires no dynamic prompt generation or manipulation
- Gives the agent agency over which context to retrieve (it can construct targeted queries)
- Degrades gracefully — if MCP tools aren't available, the instruction is simply not actionable

---

## 3. Integration: Phase-Completion Hooks — Context Capture

**Files:** Hook scripts registered in `hooks/hooks.json` (e.g., `scripts/detect-artifact.sh`, `scripts/validate-state.sh`)  
**Pattern:** Hook scripts fire at phase boundaries, extract structured summaries from artifacts, and store them via `src/memory.ts` `addMemory()`. (See ADR-005, ADR-006)

### Capture at Phase Completion

When a pipeline phase completes, the relevant hook script captures key learnings as memories:

```
Phase-completion hook fires:

1. Identify the artifact produced by the completed phase:
   - sdlc_intent → intent-and-constraints.md
   - sdlc_hld → high-level-design.md
   - sdlc_adr → adr-lite.md
   - sdlc_eis → implementation-spec.md
   - dev → check blockers/ directory for resolved blockers
   - audit → check revisions/ directory for revision context

2. For SDLC artifacts: extract per-heading summaries (heading + first 300 chars of body).
   Tag each memory: "[feature:{specName}] [phase:{completedPhase}] {heading}: {summary}"

3. For blocker files: extract first paragraph.
   Tag: "[feature:{specName}] [phase:dev] [blocker] {filename}: {summary}"

4. For revision files: extract first paragraph.
   Tag: "[feature:{specName}] [phase:audit] [revision] {filename}: {summary}"

5. Call addMemory() for each extracted memory. Fire-and-forget.

6. If addMemory() fails, log the failure and continue normally.
```

### Extraction Logic (Structured Text, No LLM)

The hook uses structured extraction (same pattern described in ADR-006):

```
Artifact content:
  ## Problem Statement
  The system needs to handle concurrent user sessions...

  ## Goals
  - G-1: Support 1000 concurrent users
  - G-2: Sub-second response time

Extracted memories:
  → "[feature:login] [phase:sdlc_intent] Problem Statement: The system needs to handle concurrent user sessions..."
  → "[feature:login] [phase:sdlc_intent] Goals: G-1: Support 1000 concurrent users G-2: Sub-second response time"
```

### Blocker and Revision Capture

```
Blocker file (blockers/auth-token-expired.md):
  # Auth Token Expired During OAuth Flow
  The OAuth token was expiring before the redirect completed because...

Extracted memory:
  → "[feature:login] [phase:dev] [blocker] auth-token-expired.md: The OAuth token was expiring before the redirect completed because..."
```

### Fire-and-Forget Capture

Per ADR-005 (revised), capture is fire-and-forget via `src/memory.ts`:
- `addMemory()` never throws — failures are logged internally
- Each call has a 5-second timeout
- This ensures memory capture never blocks the pipeline
- Sequential phases may not always have access to the immediately prior phase's memories, but Supermemory's eventual consistency is fast enough for typical pipeline timing

---

## 4. Integration: Post-Review Capture

**Pattern:** Hook fires when a review completes and user feedback is processed. Captures user preferences via `src/memory.ts` `addMemory()`.

### Post-Review Capture

```
Review completes → hook fires:

1. Extract the user's feedback from the call transcript or WhatsApp reply.

2. If feedback contains preference signals (length > 20 chars):
   Call addMemory() with content:
   "[feature:{specName}] [phase:review] [user-preference] User feedback during review: {feedback (first 500 chars)}"

3. addMemory() is fire-and-forget — log any failure, continue normally.
   The review feedback is still captured in the pipeline's file-based state regardless.
```

---

## 5. MCP Server Configuration

**File:** `.mcp.json`  
**Status:** Configured. The `supermemory` entry is present alongside existing servers. This is the primary integration point for agent access to the context layer.

### Current `.mcp.json`

```json
{
  "mcpServers": {
    "my-browser": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@playwright/mcp@latest",
        "--cdp-endpoint", "http://localhost:9223"
      ]
    },
    "auditor-browser": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@playwright/mcp@latest",
        "--headless",
        "--viewport-size=1280x720",
        "--output-dir=./proof-of-working/videos",
        "--caps=core,devtools"
      ]
    },
    "context7": {
      "type": "http",
      "url": "https://mcp.context7.com/mcp",
      "headers": {
        "CONTEXT7_API_KEY": "${CONTEXT7_API_KEY}"
      }
    },
    "supermemory": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "supermemory-mcp@latest"],
      "env": {
        "SUPERMEMORY_API_KEY": "${SUPERMEMORY_API_KEY}"
      }
    }
  }
}
```

**Note:** The `supermemory` MCP server is registered at the plugin level in `.mcp.json`. Claude Code automatically makes its tools (`search_memories`, `add_memories`) available to all agents within the plugin. Additionally, `src/memory.ts` provides direct programmatic access for TypeScript modules using the same `SUPERMEMORY_API_KEY` environment variable.

---

## 6. Environment Configuration

### Required Environment Variable

| Variable | Source | Required | Fallback |
|----------|--------|----------|----------|
| `SUPERMEMORY_API_KEY` | Supermemory dashboard -> API Keys | Yes (for memory features) | If missing, MCP memory tools silently disabled. `src/memory.ts` `searchMemories()` throws, `addMemory()` logs error. Pipeline runs without context layer. |

### Setup

```bash
# Add to shell profile or .env
export SUPERMEMORY_API_KEY="sm_..."
```

The API key is read by:
1. `.mcp.json` — passed to the Supermemory MCP server via the `env` configuration (for agent MCP access)
2. `src/memory.ts` — reads `process.env.SUPERMEMORY_API_KEY` directly (for programmatic access)

---

## 7. File Changes Summary

| File | Change | Status |
|------|--------|--------|
| `src/memory.ts` | HTTP client module with `searchMemories()` and `addMemory()` functions. Uses `node:https` against Supermemory Cloud API. | **Implemented** |
| `agents/dev-builder.md` | Add memory retrieval instruction block (call `search_memories` at start of dev phase). | Planned |
| `agents/sdlc-writer.md` | Add memory retrieval instruction block (call `search_memories` at start of spec phase). | Planned |
| `agents/auditor.md` | Add memory retrieval instruction block (call `search_memories` at start of audit phase). | Planned |
| `.mcp.json` | `supermemory` MCP server entry present alongside existing servers. | **Implemented** |
| `hooks/hooks.json` | Hook definitions for session lifecycle, tool guards, artifact detection, state validation. Phase-completion capture hooks use `src/memory.ts`. | **Implemented** |

**Note:** `src/memory.ts` provides the programmatic HTTP client that hooks and scripts use. Agent access goes through MCP. Both paths target the same Supermemory Cloud API.

---

## 8. Traceability Matrix

| Requirement | HLD Section | ADR | EIS Section | Test Category |
|-------------|-------------|-----|-------------|---------------|
| G-1: Cross-phase retrieval | S4.1, S4.3 | ADR-003 | S2 (skill prompts), S5 (MCP) | integration |
| G-2: Automatic capture | S4.2, S4.4 | ADR-005, ADR-006 | S3 (phase-completion hooks), S4 (review hook) | integration |
| G-3: Scoped retrieval | S6 D-6 | ADR-004 | S3 hook capture (prefix tagging), S2 skill queries | unit |
| G-4: All execution in Claude Code | S6 D-2 | ADR-002 | S1 (MCP + src/memory.ts) | unit |
| G-5: < 2s latency | S4.1 | ADR-005 | S1 (timeout handling) | unit |
| FR-1: Persistence | S5 | ADR-001 | S1 (Supermemory cloud via MCP + HTTP) | integration |
| FR-2: Automatic capture | S4.2, S4.4 | ADR-005, ADR-006 | S3, S4 | integration |
| FR-3: Scoped retrieval | S6 D-6 | ADR-004 | S2 skill query patterns (scope prefixes) | unit |
| FR-4: MCP integration | S4.3 | ADR-003 | S5 (`.mcp.json` entry) | integration |
| FR-5: On-demand retrieval | S4.1 | ADR-003 | S2 (skill prompt instructions) | integration |
| FR-6: Memory lifecycle | S5 | -- | S1 (MCP tools + `src/memory.ts` API) | unit |
| NFC-1: Dual memory access | S6 D-2 | ADR-002 | S1 (MCP for agents, src/memory.ts for scripts) | unit |
| NFC-2: Latency | S4.1 | ADR-005 | S1 (1500ms search timeout, 5s capture timeout) | unit |
| NFC-3: Cost | S6 D-1 | ADR-001 | S6 (Supermemory free tier) | manual |
| NFC-4: Data locality | S6 D-7 | ADR-001 | S3 (summaries only, no raw code) | review |
| NFC-5: Resilience | S8 | ADR-005 | S1 (error handling table) | unit |
| NFC-6: Plugin architecture | S5 | ADR-001 | S5 (MCP + src/memory.ts, native plugin model) | manual |
