/**
 * @module config
 *
 * Shared configuration helpers for CLI scripts.
 * Reads paths from environment variables and provides state file I/O.
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
/**
 * Load .env file from the plugin root (same directory as config.ts's parent).
 * Only sets vars that aren't already in the environment.
 */
function loadEnvFile() {
    // Try cwd/.env first, then script directory's parent/.env
    const candidates = [
        join(process.cwd(), ".env"),
        join(dirname(new URL(import.meta.url).pathname), "..", ".env"),
    ];
    for (const envPath of candidates) {
        if (existsSync(envPath)) {
            const lines = readFileSync(envPath, "utf-8").split("\n");
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith("#"))
                    continue;
                const eqIdx = trimmed.indexOf("=");
                if (eqIdx < 0)
                    continue;
                const key = trimmed.slice(0, eqIdx).trim();
                const val = trimmed.slice(eqIdx + 1).trim();
                if (!process.env[key])
                    process.env[key] = val;
            }
            break;
        }
    }
}
// Auto-load .env on module import
loadEnvFile();
/**
 * Get the data directory path.
 * Reads OPERANT_PI_DATA_DIR env var, defaults to $PWD/spec/.operant.
 */
export function getDataDir() {
    return process.env.OPERANT_PI_DATA_DIR ?? join(process.cwd(), "spec", ".operant");
}
/**
 * Get the internal specs root directory (parent of data dir).
 * Used for pipeline state management — NOT for SDLC artifact output.
 */
export function getSpecsRoot() {
    return dirname(getDataDir());
}
/**
 * Get the specs output directory where SDLC artifacts are written.
 * Reads OPERANT_PI_SPECS_DIR env var, defaults to $PROJECT_ROOT/docs/specs.
 */
export function getSpecsOutputDir() {
    return process.env.OPERANT_PI_SPECS_DIR ?? join(getProjectRoot(), "docs", "specs");
}
/**
 * Get the project root directory.
 * Reads OPERANT_PI_PROJECT_ROOT env var, defaults to process.cwd().
 */
export function getProjectRoot() {
    return process.env.OPERANT_PI_PROJECT_ROOT ?? process.cwd();
}
/**
 * Ensure the data directory and its standard subdirectories exist.
 */
export function ensureDataDir() {
    const dataDir = getDataDir();
    for (const dir of [
        getSpecsRoot(),
        dataDir,
        join(dataDir, "calls"),
        join(dataDir, "pending"),
        join(dataDir, "processed"),
    ]) {
        mkdirSync(dir, { recursive: true });
    }
}
/**
 * Read the current FSM state from current-state.txt.
 * Returns "idle" if the file is missing or unreadable.
 */
export function readState() {
    const statePath = join(getDataDir(), "current-state.txt");
    try {
        const raw = readFileSync(statePath, "utf-8").trim();
        if (raw.length === 0)
            return "idle";
        return raw;
    }
    catch {
        return "idle";
    }
}
/**
 * Write the current FSM state to current-state.txt.
 */
export function writeState(state) {
    const dataDir = getDataDir();
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "current-state.txt"), state + "\n");
}
/**
 * Read the active spec name from active-spec.txt.
 * Returns null if the file is missing or empty.
 */
export function readActiveSpec() {
    const specPath = join(getDataDir(), "active-spec.txt");
    try {
        const raw = readFileSync(specPath, "utf-8").trim();
        return raw.length > 0 ? raw : null;
    }
    catch {
        return null;
    }
}
/**
 * Write the active spec name to active-spec.txt.
 */
export function writeActiveSpec(name) {
    const dataDir = getDataDir();
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "active-spec.txt"), name + "\n");
}
/**
 * Get the Operant API key for cloud mode.
 * Returns null if not set (local mode).
 */
export function getOperantApiKey() {
    return process.env.OPERANT_API_KEY ?? null;
}
/**
 * Get the Operant API URL.
 */
export function getOperantApiUrl() {
    return process.env.OPERANT_API_URL ?? 'https://api.operantlabs.com';
}
/**
 * Get the current operating mode.
 * 'cloud' = proxied through operant-api, 'local' = direct Retell/Twilio calls.
 */
export function getMode() {
    return getOperantApiKey() ? 'cloud' : 'local';
}
/**
 * Get the GitHub repo in { owner, name } form.
 * Reads GITHUB_REPO env var (must be "owner/repo" format).
 */
export function getGitHubRepo() {
    const repo = process.env.GITHUB_REPO ?? "";
    const [owner, name] = repo.split("/");
    if (!owner || !name) {
        throw new Error("GITHUB_REPO must be set in owner/repo format");
    }
    return { owner, name };
}
/**
 * Get the GitHub poll interval in milliseconds.
 * Reads GITHUB_POLL_INTERVAL_MS env var, defaults to 60000.
 */
export function getGitHubPollInterval() {
    return parseInt(process.env.GITHUB_POLL_INTERVAL_MS ?? "60000", 10);
}
/**
 * Get the GitHub webhook secret for HMAC validation.
 * Returns null if not configured.
 */
export function getGitHubWebhookSecret() {
    return process.env.GITHUB_WEBHOOK_SECRET ?? null;
}
/**
 * Get the GitHub personal access token for API calls.
 * Returns null if not configured.
 */
export function getGitHubToken() {
    return process.env.GITHUB_TOKEN ?? null;
}
/**
 * Get the WhatsApp participants list for group notifications.
 * Reads OPERANT_WHATSAPP_PARTICIPANTS env var (comma-separated +<number> values).
 * Returns [] when the variable is absent or empty — triggers 1:1 fallback (FR-5).
 */
export function getWhatsAppParticipants() {
    const raw = process.env.OPERANT_WHATSAPP_PARTICIPANTS ?? "";
    if (!raw.trim())
        return [];
    return raw.split(",").map((n) => n.trim()).filter(Boolean);
}
/**
 * Read the stored Twilio Conversation SID from conversation-sid.txt.
 * Returns null if the file is absent or empty (triggers conversation creation on first use).
 */
export function getConversationSid() {
    const path = join(getDataDir(), "conversation-sid.txt");
    try {
        const raw = readFileSync(path, "utf-8").trim();
        return raw.length > 0 ? raw : null;
    }
    catch {
        return null;
    }
}
/**
 * Atomically write a Twilio Conversation SID to conversation-sid.txt.
 * Uses write-tmp-then-rename pattern (NFC-4) matching github-cursor.txt.
 */
export function writeConversationSid(sid) {
    const dataDir = getDataDir();
    mkdirSync(dataDir, { recursive: true });
    const tmpPath = join(dataDir, "conversation-sid.txt.tmp");
    const finalPath = join(dataDir, "conversation-sid.txt");
    writeFileSync(tmpPath, sid + "\n");
    renameSync(tmpPath, finalPath);
}
