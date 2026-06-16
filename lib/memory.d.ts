/**
 * @module memory
 *
 * Supermemory HTTP client for the context layer.
 * Follows the same node:https pattern as retell.ts (ADR-002).
 */
export interface MemoryResult {
    content: string;
    createdAt: string;
}
/**
 * Search Supermemory for relevant memories.
 * Returns empty array on timeout or error (graceful degradation).
 */
export declare function searchMemories(query: string, limit?: number, timeoutMs?: number): Promise<MemoryResult[]>;
/**
 * Store a memory. Fire-and-forget — never throws, never blocks.
 */
export declare function addMemory(content: string): void;
