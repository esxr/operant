/**
 * @module memory
 *
 * Supermemory HTTP client for the context layer.
 * Follows the same node:https pattern as retell.ts (ADR-002).
 */
import https from "node:https";
const API_HOST = "api.supermemory.ai";
function getApiKey() {
    const key = process.env.SUPERMEMORY_API_KEY;
    if (key)
        return key;
    throw new Error("SUPERMEMORY_API_KEY not set");
}
// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------
function request(method, path, body, timeoutMs) {
    return new Promise((resolve, reject) => {
        const apiKey = getApiKey();
        const payload = body ? JSON.stringify(body) : null;
        const options = {
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
            options.headers["Content-Length"] =
                String(Buffer.byteLength(payload));
        }
        const req = https.request(options, (res) => {
            let data = "";
            res.on("data", (chunk) => {
                data += chunk;
            });
            res.on("end", () => {
                if (res.statusCode && res.statusCode >= 400) {
                    let parsed;
                    try {
                        parsed = JSON.parse(data);
                    }
                    catch {
                        parsed = data;
                    }
                    reject(new Error(`Supermemory API error ${res.statusCode} ${method} ${path}: ${JSON.stringify(parsed)}`));
                    return;
                }
                if (!data.trim()) {
                    resolve({});
                    return;
                }
                try {
                    resolve(JSON.parse(data));
                }
                catch (err) {
                    reject(new Error(`Failed to parse response JSON: ${err.message}\nBody: ${data}`));
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
export async function searchMemories(query, limit = 10, timeoutMs = 1500) {
    try {
        const res = await request("POST", "/v3/search", { query, limit }, timeoutMs);
        const results = res.results;
        if (!Array.isArray(results))
            return [];
        return results.map((r) => ({
            content: String(r.content ?? ""),
            createdAt: String(r.createdAt ?? ""),
        }));
    }
    catch (err) {
        console.log(`[memory] searchMemories failed: ${err.message}`);
        return [];
    }
}
/**
 * Store a memory. Fire-and-forget — never throws, never blocks.
 */
export function addMemory(content) {
    request("POST", "/v3/memories", { content }, 5000).catch((err) => {
        console.log(`[memory] addMemory failed: ${err.message}`);
    });
}
