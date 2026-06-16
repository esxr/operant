<!-- #core -->
# Architecture Decisions: Shared Context Layer

**Last Updated:** 2026-06-06

---

## ADR-001: Supermemory Cloud over Self-Hosted Mem0

**Status:** Accepted

**Context:**  
The context layer needs a persistent memory backend with semantic search. Two viable options exist: Mem0 (self-hosted via Docker with Qdrant + Ollama) or Supermemory (managed cloud with zero-config MCP plugin). The pipeline currently has zero infrastructure dependencies beyond cloudflared (managed by `scripts/tunnel.sh`) — adding Docker containers changes the operational profile.

**Decision:**  
Use Supermemory's managed cloud service as the memory backend.

**Alternatives Considered:**

| Option | Pros | Cons |
|--------|------|------|
| **Supermemory cloud** | Zero config, one-command install, no Docker/Qdrant/Ollama, purpose-built for Claude Code, MCP plugin ready | Data leaves local machine, no native scope filtering, vendor dependency |
| **Mem0 self-hosted** | Data stays local (NFC-4), multi-scope tagging, hybrid vector+graph store, 48k GitHub stars | Docker + Qdrant + Ollama = ~3GB RAM, operational overhead, complex setup |
| **Mem0 cloud** | Managed like Supermemory but with native scope fields, lifecycle hooks | Per-query pricing may conflict with zero-marginal-cost model (NFC-3), more complex setup than Supermemory |

**Rationale:**  
NFC-3 (cost) and G-5 (latency) favor a managed service. Between managed options, Supermemory's zero-config Claude Code plugin eliminates all setup friction. The pipeline doesn't yet have enough memory volume to justify Mem0's richer scoping features. NFC-4 (data locality) is partially relaxed — only structured summaries are sent to cloud, never raw code. Migration to Mem0 self-hosted is straightforward if data locality becomes critical: swap the HTTP endpoint in `src/memory.ts` and MCP server entry in `.mcp.json`.

**Consequences:**
- No infrastructure to manage — no Docker, no local embedding model
- Memory content (summaries, decisions, preferences) is stored in Supermemory's cloud
- Scoping is done via content prefixes rather than native metadata fields (less precise)
- Vendor lock-in is minimal — integration surface is HTTP POST (`src/memory.ts`) + MCP tools, both swappable

**Resolves:** HLD Open Question Q-1 (hosting model)

---

## ADR-002: Dual Access — MCP for Agents, `src/memory.ts` for Scripts

**Status:** Accepted (revised — previously "MCP-Only Access")

**Context:**  
In the Claude Code plugin model, agents access tools via MCP. However, TypeScript modules and hook scripts (registered in `hooks/hooks.json`) may also need programmatic memory access for capture and retrieval. The question is whether all access should go through MCP tool calls, or whether a direct HTTP client should also be available.

**Decision:**  
Dual access. Agents use MCP tool calls (`search_memories`, `add_memories`). TypeScript modules and hook scripts use `src/memory.ts` which provides `searchMemories()` and `addMemory()` functions via direct HTTP to the Supermemory Cloud API. Both paths target the same backend.

**Alternatives Considered:**

| Option | Pros | Cons |
|--------|------|------|
| **Dual access (chosen)** | Agents get native MCP interface; scripts get fast programmatic access; both paths independent | Two integration points to maintain; `SUPERMEMORY_API_KEY` needed in both `.mcp.json` env and process env |
| **MCP-only** | Single integration point, vendor-swappable by changing `.mcp.json` entry | MCP tool calls from scripts are awkward; adds latency for programmatic capture |
| **HTTP-only** | Simple, no MCP dependency for memory | Agents lose the natural MCP tool interface; breaks Claude Code's native tool model |

**Rationale:**  
The `src/memory.ts` module follows the same `node:https` pattern as `src/retell.ts` — lightweight, zero-dependency HTTP client. Having it available for scripts means capture hooks can call `addMemory()` directly without going through MCP, which is faster and more natural for programmatic code. Agents still use MCP, which is the native Claude Code mechanism for tool access. The Supermemory API key is the same for both paths.

**Consequences:**
- `src/memory.ts` provides `searchMemories()` and `addMemory()` using `node:https`
- `SUPERMEMORY_API_KEY` env var consumed by both `.mcp.json` (MCP server) and `src/memory.ts` (direct HTTP)
- If migrating to a different backend, update both the `.mcp.json` entry and the API host in `src/memory.ts`
- Both paths have independent graceful degradation

**Resolves:** HLD Decision D-2 (access pattern)

---

## ADR-003: MCP-Only Retrieval for Agents (No Spawn-Time Injection)

**Status:** Accepted (revised — previously "Dual Access: Spawn Injection + In-Session MCP")

**Context:**  
In the Claude Code plugin model, there is no `spawnClaudeP()` function to inject memories into prompts. Agents run within Claude Code, triggered by hooks and skills. The question is how agents receive memory context: via prompt manipulation before they run, or via on-demand MCP tool calls during execution.

**Decision:**  
MCP-only for agents. Agents call `search_memories` on-demand during execution. No spawn-time prompt injection. The cold-start problem is solved by agent prompts (in `agents/*.md`) that instruct agents to query memory tools at the start of each phase.

**Alternatives Considered:**

| Option | Pros | Cons |
|--------|------|------|
| **MCP-only for agents (chosen)** | Single integration point for agents, dynamic queries, no prompt manipulation, agents query when they actually need context | Agent must be told to check memory — solved by agent prompt instructions |
| **Agent prompt preamble injection** | Agent starts with context embedded in its prompt | Requires dynamic prompt generation, breaks the static-agent model, added complexity |
| **Dual: injection + MCP** | Baseline context guaranteed, dynamic queries for edge cases | Requires prompt manipulation machinery, two integration points |

**Rationale:**  
The Claude Code plugin model has no subprocess spawning — there is no prompt to inject into. Agents are static markdown files loaded by the plugin system. Rather than building dynamic prompt generation to replicate injection, we lean into MCP as the native communication channel. The cold-start concern is addressed simply: each agent's markdown definition includes an instruction like "Before beginning work, call `search_memories` to retrieve relevant context from prior phases." This is reliable because Claude Code agents consistently follow their instructions. Intent reference: G-1 (cross-phase retrieval), FR-4 (MCP integration), FR-5 (on-demand retrieval).

**Consequences:**
- No prompt manipulation or dynamic agent generation needed
- Agents call `search_memories` and `add_memories` MCP tools during execution
- The MCP server entry in `.mcp.json` is required (already present)
- Cold-start is handled by agent prompt instructions, not by pre-loading context
- Slight behavioral difference: agent explicitly decides when to query, giving it agency over which context to retrieve

**Resolves:** Access pattern design — MCP is the sole mechanism for agent retrieval

---

## ADR-004: Content-Prefix Scoping

**Status:** Accepted

**Context:**  
FR-3 requires scoped retrieval: feature scope (highest priority), project scope, and user scope. Supermemory doesn't have native multi-scope metadata fields like Mem0. We need a scoping mechanism that works within Supermemory's semantic search model.

**Decision:**  
Encode scope as structured content prefixes. Every memory is stored with prefix tags like `[feature:login-page]`, `[phase:dev]`, `[user-preference]`, `[project]`. Retrieval queries include relevant prefixes to bias semantic search.

**Alternatives Considered:**

| Option | Pros | Cons |
|--------|------|------|
| **Content prefixes** | Works with any semantic search backend, no vendor-specific features needed, self-documenting | Less precise than metadata filtering — relies on embedding similarity including prefix tokens |
| **Separate memory spaces per scope** | True isolation, no cross-contamination | Requires managing multiple Supermemory accounts/spaces, complicates retrieval that spans scopes |
| **No scoping (flat memory)** | Simplest — just search everything | Noise from irrelevant features, degrades as memory volume grows |

**Rationale:**  
Content prefixes are the pragmatic middle ground. Semantic search naturally weights prefix tokens when they appear in the query, giving soft scoping without requiring vendor-specific metadata APIs. The memory volume in v1 will be low enough (~10-50 memories per feature, ~100-500 total) that semantic search with prefix hints provides sufficient precision. If memory volume grows and precision degrades, migration to Mem0's native scope fields is the documented upgrade path.

**Consequences:**
- Every stored memory includes structured prefix tags in its content
- Retrieval queries are constructed with matching prefixes: `"[feature:${specName}] [phase:${state}] context for..."`
- Cross-scope retrieval works by omitting scope prefixes from the query (returns by pure semantic relevance)
- Less precise than metadata filtering — acceptable at current memory volumes

**Resolves:** HLD Open Question Q-3 (partially — scoping mechanism), addresses FR-3

---

## ADR-005: Fire-and-Forget Capture via `src/memory.ts`

**Status:** Accepted (revised — previously "Synchronous MCP Capture in Hooks")

**Context:**  
FR-2 requires automatic capture at lifecycle boundaries. In the Claude Code plugin model, capture happens in phase-completion hooks. The question is whether capture calls should be synchronous (blocking until stored) or fire-and-forget.

**Decision:**  
Capture calls are fire-and-forget via `src/memory.ts` `addMemory()`. The function has a 5-second timeout internally. Failures are logged via `console.log` but never throw. This ensures memory capture never blocks the pipeline.

**Alternatives Considered:**

| Option | Pros | Cons |
|--------|------|------|
| **Fire-and-forget via `src/memory.ts` (chosen)** | Zero added latency to pipeline, capture never blocks, simple error handling | Race condition — next phase may query before memory is stored |
| **Synchronous MCP with timeout** | Guarantees memories stored before next phase begins | Adds latency to phase transitions (~1-3s per memory), hook blocks during capture |
| **Queued with local buffer** | Reliable delivery via local write-ahead log, async drain | Complexity — need queue persistence, drain logic, failure handling |

**Rationale:**  
The `addMemory()` function in `src/memory.ts` is designed as fire-and-forget: it calls the Supermemory API and `.catch()`-es any errors with a log message. This means memory capture never blocks the pipeline. The trade-off is that the next phase's agent may not find the memory immediately — but Supermemory's eventual consistency is fast enough for typical pipeline timing (phases don't transition instantaneously). Memories remain supplementary — if capture fails, the pipeline runs as it does today with file-based context.

**Consequences:**
- Capture adds zero latency to phase transitions
- `addMemory()` never throws — failures logged but not propagated
- Slight race condition: next phase may query before memory is indexed — acceptable for typical pipeline timing
- No local buffer or write-ahead log — keeps implementation simple

**Resolves:** Confirms HLD D-4, addresses NFC-2 and NFC-5

---

## ADR-006: Structured Text Extraction for Capture (No LLM)

**Status:** Accepted

**Context:**  
When capturing memories at phase completion (FR-2), we need to extract meaningful content from phase artifacts (spec docs, blocker files, revision files). Two approaches: structured text extraction (headings + first paragraph) within hooks, or instructing the agent to extract and store memories as part of its phase work.

**Decision:**  
Use structured text extraction for v1. Phase-completion hooks read artifacts and extract heading/paragraph summaries. No LLM-based summarization for memory capture.

**Alternatives Considered:**

| Option | Pros | Cons |
|--------|------|------|
| **Structured text extraction in hooks** | No LLM cost, deterministic, fast, pattern already exists in codebase | Captures structure but may miss nuanced decisions buried in prose |
| **Agent-driven extraction** | Higher quality — agent understands context, can identify implicit decisions | Adds complexity to agent prompts, capture quality depends on agent behavior, non-deterministic |
| **Hybrid: structured extraction + periodic agent consolidation** | Best of both — fast capture, periodic enrichment | Complex — two capture paths, consolidation scheduling, v2 territory |

**Rationale:**  
Structured extraction is sufficient for v1: SDLC artifacts are already well-structured with clear headings, and blocker/revision files have explicit descriptions. Hook-based extraction is deterministic and fast. If nuanced extraction proves necessary, the hybrid approach can be added in v2 where the agent is instructed to call `add_memories` with its own summaries before completing a phase.

**Consequences:**
- Captured memories are heading-level summaries, not deep semantic extractions
- Quality depends on artifact structure (well-structured specs = good memories)
- No additional LLM cost or latency for capture
- v2 upgrade path: add agent-driven memory extraction where the agent calls `add_memories` with richer context before phase completion

**Resolves:** HLD Open Question Q-3 (capture mechanism)

---

## ADR-007: Atomic Memory Granularity

**Status:** Accepted

**Context:**  
Q-4 from the intent doc asks: should each memory be a single atomic fact or a phase-level summary? This affects both storage volume and retrieval precision.

**Decision:**  
Atomic facts. One memory per decision, preference, or convention. A single phase may produce multiple memories.

**Alternatives Considered:**

| Option | Pros | Cons |
|--------|------|------|
| **Atomic facts** | Precise retrieval, easy to update/supersede individual facts, less noise per result | Higher memory count, more capture logic to split artifacts into facts |
| **Phase summaries** | Fewer memories, simpler capture (one per phase), full context per memory | Retrieval returns large chunks with mixed relevance, harder to supersede individual decisions |

**Rationale:**  
Supermemory's semantic search works best with focused, specific content. A memory like "user prefers Tailwind for styling" is more retrievable and actionable than a paragraph containing that fact among five others. Atomic facts also support FR-6 (memory lifecycle) — individual facts can be updated or expired without affecting other decisions from the same phase. The capture logic extracts multiple facts from a single artifact by splitting on headings.

**Consequences:**
- Capture logic splits artifacts into per-heading memories with appropriate prefix tags
- Memory count grows faster (~3-5 memories per phase rather than 1)
- Each memory is highly specific and independently queryable
- Superseding a decision means adding a new memory (Supermemory's recency ranking handles the rest)

**Resolves:** HLD Open Question Q-4 (memory granularity)

---

## ADR-008: Source Attribution in Retrieved Memories

**Status:** Accepted

**Context:**  
Q-5 asks whether retrieved memories should include source metadata (feature, phase, timestamp) when returned to agents. This helps agents judge reliability but adds token length.

**Decision:**  
Yes. Include compact source tags in the stored memory content. Format: `- [feature:X, phase:Y, 2h ago] Memory content here`

**Alternatives Considered:**

| Option | Pros | Cons |
|--------|------|------|
| **Include source tags** | Agent can judge recency and relevance, debuggable, transparent | Adds ~10 tokens per memory (~100 tokens for 10 memories) |
| **Content only, no metadata** | Shorter responses, simpler formatting | Agent has no way to judge if memory is stale or from an irrelevant feature |

**Rationale:**  
100 tokens of metadata across 10 memories is negligible in context. The debugging value alone justifies it — when an agent makes a questionable decision based on memory, source attribution makes it traceable. Agents are also better at weighing information when they know its provenance ("this was learned 2 hours ago during the dev phase of the login feature" vs. a bare assertion).

**Consequences:**
- Memory content includes `createdAt` timestamp (relative: "2h ago") and content-prefix tags
- Total overhead: ~600 tokens for 10 memories (content + metadata)
- Memories are self-documenting in agent execution logs

**Resolves:** HLD Open Question Q-5 (source attribution)
