/**
 * @module memory
 *
 * Supermemory HTTP client for the context layer.
 * Follows the same node:https pattern as retell.ts (ADR-002).
 */

import https from "node:https";

const API_HOST = "api.supermemory.ai";

function getApiKey(): string {
  const key = process.env.SUPERMEMORY_API_KEY;
  if (key) return key;
  throw new Error("SUPERMEMORY_API_KEY not set");
}

export interface MemoryResult {
  content: string;
  createdAt: string; // ISO8601
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

function request(
  method: string,
  path: string,
  body: Record<string, unknown> | null,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const apiKey = getApiKey();
    const payload = body ? JSON.stringify(body) : null;

    const options: https.RequestOptions = {
      hostname: API_HOST,
      port: 443,
      path,
      method,
      timeout: timeoutMs,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    };

    if (payload) {
      (options.headers as Record<string, string>)["Content-Length"] =
        String(Buffer.byteLength(payload));
    }

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => {
        data += chunk;
      });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = data;
          }
          reject(
            new Error(
              `Supermemory API error ${res.statusCode} ${method} ${path}: ${JSON.stringify(parsed)}`
            )
          );
          return;
        }

        if (!data.trim()) {
          resolve({});
          return;
        }

        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(
            new Error(
              `Failed to parse response JSON: ${(err as Error).message}\nBody: ${data}`
            )
          );
        }
      });
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeoutMs}ms: ${method} ${path}`));
    });

    req.on("error", (err) => {
      reject(new Error(`Request failed: ${err.message}`));
    });

    if (payload) {
      req.write(payload);
    }

    req.end();
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Search Supermemory for relevant memories.
 * Returns empty array on timeout or error (graceful degradation).
 */
export async function searchMemories(
  query: string,
  limit = 10,
  timeoutMs = 1500,
): Promise<MemoryResult[]> {
  try {
    const res = await request("POST", "/v3/search", { query, limit }, timeoutMs);
    const results = res.results as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(results)) return [];
    return results.map((r) => ({
      content: String(r.content ?? ""),
      createdAt: String(r.createdAt ?? ""),
    }));
  } catch (err) {
    console.log(`[memory] searchMemories failed: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Store a memory. Fire-and-forget — never throws, never blocks.
 */
export function addMemory(content: string): void {
  request("POST", "/v3/memories", { content }, 5000).catch((err) => {
    console.log(`[memory] addMemory failed: ${(err as Error).message}`);
  });
}
