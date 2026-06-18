# Implementation Spec: GitHub Issue Trigger Extension

**Version:** 1.1
**Date:** 2026-06-18
**Status:** Draft (Revised — tasks 7–8 added for start/stop commands, FR-8 ACs mapped)
**Parents:** [Intent](intent-and-constraints.md) | [HLD](high-level-design.md) | [ADR](adr-lite.md)

---

## 1. File-by-File Changes

### 1.1 `src/state-machine.ts` (MODIFY)

**Change 1: Extend `FSMEvent` union** (line 43-67)

Add `ISSUE_RECEIVED` as the 24th event to the union:

```typescript
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
  | "DEMO_FAILED"
  | "ISSUE_RECEIVED";  // NEW: 24th event — GitHub issue direct-to-triage
```

**Change 2: Add transition to `idle` state map** (line 180-187)

Insert `ISSUE_RECEIVED` alongside the existing `CALL_RECEIVED` entry in the `idle` state's `Map<FSMEvent, TransitionEntry>`:

```typescript
["idle", new Map<FSMEvent, TransitionEntry>([
  ["CALL_RECEIVED", {
    to: "call_active",
    sideEffects: (ctx) => [
      { type: "EMIT_EVENT", name: "log", payload: { message: "Call started", callId: ctx.callId ?? "unknown" } },
    ],
  }],
  // NEW: GitHub issue direct-to-triage (ADR-001, skips call_active)
  ["ISSUE_RECEIVED", {
    to: "triage",
    sideEffects: (ctx) => [
      { type: "EMIT_EVENT", name: "log", payload: {
        message: "GitHub issue received",
        issueNumber: ctx.issueNumber ?? "unknown",
        author: ctx.author ?? "unknown",
      }},
    ],
  }],
])],
```

No other state maps are modified. The FSM module remains pure -- no new imports.

---

### 1.2 `scripts/server.ts` (MODIFY)

**Change 1: Add `node:crypto` import** (after line 6)

```typescript
import { createHmac, timingSafeEqual } from "node:crypto";
```

**Change 2: Add `readdirSync` to `node:fs` import** (line 3)

Extend the existing destructured import to include `readdirSync`:

```typescript
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
  mkdirSync,
  existsSync,
} from "node:fs";
```

**Change 3: Add `verifyGitHubSignature` helper** (after `readRawBody`, ~line 104)

```typescript
function verifyGitHubSignature(
  rawBody: string,
  signature: string,
  secret: string,
): boolean {
  const expected =
    "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
```

**Change 4: Add `handleGitHubWebhook` route handler** (after `handleWhatsAppWebhook`, ~line 319)

```typescript
async function handleGitHubWebhook(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // 1. Read raw body (needed for HMAC)
  const rawBody = await readRawBody(req);

  // 2. HMAC validation
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    log("[webhook/github] Webhook secret not configured");
    json(res, 500, { error: "Webhook secret not configured" });
    return;
  }

  const signature = req.headers["x-hub-signature-256"] as string | undefined;
  if (!signature) {
    log("[webhook/github] Missing signature header");
    json(res, 401, { error: "Missing signature" });
    return;
  }

  if (!verifyGitHubSignature(rawBody, signature, secret)) {
    log("[webhook/github] HMAC validation failed");
    json(res, 401, { error: "Invalid signature" });
    return;
  }

  // 3. Event type filter
  const event = req.headers["x-github-event"] as string | undefined;
  if (event !== "issues") {
    log(`[webhook/github] Ignored event type: ${event}`);
    json(res, 200, { ignored: true });
    return;
  }

  // 4. Parse payload and filter action
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    json(res, 400, { error: "Invalid JSON" });
    return;
  }

  if (payload.action !== "opened") {
    log(`[webhook/github] Ignored action: ${payload.action}`);
    json(res, 200, { ignored: true });
    return;
  }

  // 5. Extract issue fields
  const issue = payload.issue as Record<string, unknown> | undefined;
  if (!issue) {
    json(res, 400, { error: "Missing issue object" });
    return;
  }

  const issueNumber = issue.number as number;
  const issueTitle = (issue.title as string) ?? "";
  const issueBody = (issue.body as string) ?? "";
  const issueAuthor = ((issue.user as Record<string, unknown>)?.login as string) ?? "unknown";
  const issueUrl = (issue.html_url as string) ?? "";
  const issueLabels = ((issue.labels as Array<{ name: string }>) ?? []).map((l) => l.name);
  const issueCreatedAt = (issue.created_at as string) ?? new Date().toISOString();

  // 6. Write trigger file
  const ts = Date.now();
  const triggerFile = `github-${issueNumber}-${ts}.json`;
  const triggerPath = join(PENDING_DIR, triggerFile);
  const triggerData = {
    source: "github",
    github_issue: {
      number: issueNumber,
      title: issueTitle,
      body: issueBody,
      author: issueAuthor,
      url: issueUrl,
      labels: issueLabels,
      created_at: issueCreatedAt,
    },
    created_at: new Date().toISOString(),
  };

  writeFileSync(triggerPath, JSON.stringify(triggerData, null, 2));
  log(`[webhook/github] Wrote trigger: ${triggerFile} (issue #${issueNumber})`);

  notifyTrigger(triggerFile);

  json(res, 200, { processed: true, issue: issueNumber });
}
```

**Change 5: Register route in the router** (in `createServer` callback, after WhatsApp route ~line 389)

```typescript
if (method === "POST" && url === "/webhook/github") {
  await handleGitHubWebhook(req, res);
  return;
}
```

**Change 6: Log the new endpoint on startup** (in `server.listen` callback, ~line 459)

Add to the endpoint list:

```typescript
log(`  POST /webhook/github`);
```

---

### 1.3 `src/cli/poll-github.ts` (NEW)

Full module. Follows the `poll-triggers.ts` pattern (line-for-line structural analog).

```typescript
#!/usr/bin/env node
/**
 * @module cli/poll-github
 *
 * Background poller for GitHub issues labeled "feedback".
 * Writes trigger files to pending/ for any new issues above the cursor.
 *
 * Usage:
 *   node lib/cli/poll-github.js          # continuous polling
 *   node lib/cli/poll-github.js --once   # single cycle, then exit
 */

import {
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import https from "node:https";
import {
  getDataDir,
  ensureDataDir,
  getGitHubRepo,
  getGitHubToken,
  getGitHubPollInterval,
} from "../config.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CURSOR_FILE = "github-cursor.txt";
const LABEL_FILTER = "feedback";
const LOG_PREFIX = "[poll-github]";

// ---------------------------------------------------------------------------
// Cursor I/O
// ---------------------------------------------------------------------------

function readCursor(dataDir: string): number {
  const cursorPath = join(dataDir, CURSOR_FILE);
  try {
    const raw = readFileSync(cursorPath, "utf-8").trim();
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? 0 : n;
  } catch {
    return 0;
  }
}

function writeCursorAtomic(dataDir: string, cursor: number): void {
  const cursorPath = join(dataDir, CURSOR_FILE);
  const tmpPath = cursorPath + ".tmp";
  writeFileSync(tmpPath, String(cursor) + "\n");
  renameSync(tmpPath, cursorPath);
}

// ---------------------------------------------------------------------------
// GitHub API Client
// ---------------------------------------------------------------------------

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  user: { login: string };
  html_url: string;
  labels: Array<{ name: string }>;
  created_at: string;
}

interface GitHubResponse {
  issues: GitHubIssue[];
  rateLimitRemaining: number;
}

function fetchIssues(
  owner: string,
  repo: string,
  token: string,
): Promise<GitHubResponse> {
  return new Promise((resolve, reject) => {
    const path = `/repos/${owner}/${repo}/issues?labels=${LABEL_FILTER}&state=open&sort=created&direction=asc&per_page=100`;

    const req = https.request(
      {
        hostname: "api.github.com",
        port: 443,
        path,
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "operant-poll-github/1.0",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk; });
        res.on("end", () => {
          const rateLimitRemaining = parseInt(
            (res.headers["x-ratelimit-remaining"] as string) ?? "5000",
            10,
          );

          if (res.statusCode === 403 || res.statusCode === 429) {
            reject(new Error(`Rate limited (${res.statusCode}). Retry next cycle.`));
            return;
          }
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`GitHub API error ${res.statusCode}: ${data.slice(0, 200)}`));
            return;
          }

          try {
            const issues = JSON.parse(data) as GitHubIssue[];
            resolve({ issues, rateLimitRemaining });
          } catch {
            reject(new Error("Failed to parse GitHub API response"));
          }
        });
      },
    );
    req.on("error", (err) => reject(new Error(`GitHub API request failed: ${err.message}`)));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Idempotency Check
// ---------------------------------------------------------------------------

function triggerExists(dataDir: string, issueNumber: number): boolean {
  const pendingDir = join(dataDir, "pending");
  const processedDir = join(dataDir, "processed");

  for (const dir of [pendingDir, processedDir]) {
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir);
    if (files.some((f) => f.startsWith(`github-${issueNumber}-`))) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Trigger File Writer
// ---------------------------------------------------------------------------

function writeTriggerFile(issue: GitHubIssue, dataDir: string): string {
  const pendingDir = join(dataDir, "pending");
  mkdirSync(pendingDir, { recursive: true });

  const ts = Date.now();
  const filename = `github-${issue.number}-${ts}.json`;
  const triggerPath = join(pendingDir, filename);

  const triggerData = {
    source: "github",
    github_issue: {
      number: issue.number,
      title: issue.title,
      body: issue.body ?? "",
      author: issue.user.login,
      url: issue.html_url,
      labels: issue.labels.map((l) => l.name),
      created_at: issue.created_at,
    },
    created_at: new Date().toISOString(),
  };

  writeFileSync(triggerPath, JSON.stringify(triggerData, null, 2));
  return filename;
}

// ---------------------------------------------------------------------------
// Poll Cycle
// ---------------------------------------------------------------------------

async function pollOnce(): Promise<number> {
  const dataDir = getDataDir();
  const { owner, name } = getGitHubRepo();
  const token = getGitHubToken();

  if (!token) {
    process.stderr.write(`${LOG_PREFIX} GITHUB_TOKEN not set. Cannot poll.\n`);
    process.exit(1);
  }

  let cursor = readCursor(dataDir);
  let newCount = 0;

  try {
    const { issues, rateLimitRemaining } = await fetchIssues(owner, name, token);

    if (rateLimitRemaining < 100) {
      process.stderr.write(
        `${LOG_PREFIX} WARNING: GitHub API rate limit low (${rateLimitRemaining} remaining)\n`,
      );
    }

    for (const issue of issues) {
      if (issue.number <= cursor) continue;
      if (triggerExists(dataDir, issue.number)) {
        process.stderr.write(`${LOG_PREFIX} Skipped #${issue.number} (trigger exists)\n`);
        cursor = Math.max(cursor, issue.number);
        continue;
      }

      const filename = writeTriggerFile(issue, dataDir);
      process.stderr.write(`${LOG_PREFIX} Wrote trigger: ${filename}\n`);
      cursor = Math.max(cursor, issue.number);
      newCount++;
    }

    writeCursorAtomic(dataDir, cursor);
  } catch (err) {
    process.stderr.write(`${LOG_PREFIX} Error: ${(err as Error).message}\n`);
  }

  process.stderr.write(
    `${LOG_PREFIX} Checked at ${new Date().toISOString()}. Found ${newCount} new issue(s).\n`,
  );
  return newCount;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const once = process.argv.includes("--once");

ensureDataDir();
await pollOnce();

if (!once) {
  const interval = getGitHubPollInterval();
  process.stderr.write(`${LOG_PREFIX} Polling every ${interval}ms\n`);
  setInterval(pollOnce, interval);
}
```

---

### 1.4 `src/cli/process-trigger.ts` (MODIFY)

**Change 1: Extend `TriggerPayload` interface** (line 39-54)

```typescript
interface TriggerPayload {
  call_id?: string;
  caller_name?: string;
  from_number?: string;
  raw_transcript?: string;
  call_analysis?: Record<string, unknown>;
  spec?: {
    raw_transcript?: string;
    call_analysis?: Record<string, unknown>;
    feature_name?: string;
    call_summary?: string;
  };
  body?: string;
  source?: "voice" | "whatsapp" | "github";
  github_issue?: {
    number: number;
    title: string;
    body: string;
    author: string;
    url: string;
    labels: string[];
    created_at: string;
  };
}
```

**Change 2: Add `sendNotification` helper** (after `moveToProcessed`, ~line 93)

```typescript
async function sendGitHubNotification(issue: NonNullable<TriggerPayload["github_issue"]>): Promise<void> {
  try {
    const msg = [
      `New feedback from @${issue.author}: "${issue.title}"`,
      `Issue #${issue.number}: ${issue.url}`,
      `Starting pipeline.`,
    ].join("\n");

    // Reuse Twilio WhatsApp -- same approach as voice-call notifications
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const whatsappFrom = process.env.TWILIO_WHATSAPP_NUMBER;
    const whatsappTo = process.env.TWILIO_WHATSAPP_RECIPIENT;

    if (!accountSid || !authToken || !whatsappFrom || !whatsappTo) {
      process.stderr.write("[process-trigger] WhatsApp not configured, skipping notification\n");
      return;
    }

    const from = whatsappFrom.startsWith("whatsapp:") ? whatsappFrom : `whatsapp:${whatsappFrom}`;
    const to = whatsappTo.startsWith("whatsapp:") ? whatsappTo : `whatsapp:${whatsappTo}`;

    const { default: https } = await import("node:https");
    const params = new URLSearchParams();
    params.append("From", from);
    params.append("To", to);
    params.append("Body", msg);
    const payload = params.toString();
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

    await new Promise<void>((resolve, reject) => {
      const req = https.request({
        hostname: "api.twilio.com",
        port: 443,
        path: `/2010-04-01/Accounts/${accountSid}/Messages.json`,
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": String(Buffer.byteLength(payload)),
        },
      }, (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk; });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`Twilio error ${res.statusCode}: ${data.slice(0, 200)}`));
          } else {
            resolve();
          }
        });
      });
      req.on("error", reject);
      req.write(payload);
      req.end();
    });

    process.stderr.write("[process-trigger] WhatsApp notification sent\n");
  } catch (err) {
    process.stderr.write(`[process-trigger] WhatsApp notification failed: ${(err as Error).message}\n`);
  }
}
```

**Change 3: Add GitHub source branch in `main()`** (replace the block at lines 143-248)

Replace the entire `try { ... }` block inside `main()` after payload parsing with:

```typescript
try {
  const currentState = readState();
  const source = (payload.source ?? "voice") as "voice" | "whatsapp" | "github";

  if (source === "github") {
    // ── GitHub entry path ──────────────────────────────────────────
    const ghIssue = payload.github_issue;
    if (!ghIssue) {
      process.stderr.write("GitHub trigger missing github_issue field\n");
      process.exit(1);
      return;
    }

    // Determine transcript: prefer body, fall back to title if body is too short
    const issueBody = ghIssue.body ?? "";
    const transcript = issueBody.length >= 20 ? issueBody : ghIssue.title;
    const featureName = ghIssue.title;

    // Step 1: Fire ISSUE_RECEIVED (idle -> triage directly, skip call_active)
    if (currentState === "idle") {
      const t = runTransition("ISSUE_RECEIVED", {
        issueNumber: String(ghIssue.number),
        author: ghIssue.author,
      });
      result.transitions.push(t);
    }

    // Step 2: If triage, classify and transition
    const stateAfterIssue = readState();
    if (stateAfterIssue === "triage") {
      const classification = classifyTranscript(transcript);
      result.classification = classification;

      switch (classification) {
        case "requirements": {
          const specName = deriveSpecName(featureName);
          result.specName = specName;
          const specDir = join(getSpecsOutputDir(), specName);
          writeActiveSpec(specDir);

          // Build REQUIREMENTS.md content with source reference
          const requirementsContent = [
            `> Source: GitHub Issue #${ghIssue.number} -- ${ghIssue.url}`,
            ``,
            transcript,
          ].join("\n");

          const t = runTransition("NEW_REQUIREMENTS", {
            specName,
            specDir,
            requirements: requirementsContent,
          });
          result.transitions.push(t);

          // Write source-metadata.json alongside REQUIREMENTS.md (OQ-5 default)
          const metadataPath = join(specDir, "source-metadata.json");
          if (!existsSync(specDir)) {
            mkdirSync(specDir, { recursive: true });
          }
          writeFileSync(metadataPath, JSON.stringify({
            source: "github",
            issue_number: ghIssue.number,
            issue_url: ghIssue.url,
            author: ghIssue.author,
            created_at: ghIssue.created_at,
          }, null, 2));

          break;
        }
        case "confirmation": {
          const t1 = runTransition("CONFIRMATION_RECEIVED", { specDir: "" });
          result.transitions.push(t1);
          const t2 = runTransition("RESET", {});
          result.transitions.push(t2);
          break;
        }
        case "unknown": {
          const t = runTransition("REJECTED", {
            reason: "GitHub issue content could not be classified",
          });
          result.transitions.push(t);
          break;
        }
      }
    }

    // Execute filesystem side effects
    for (const t of result.transitions) {
      for (const effect of t.sideEffects) {
        if (effect.type === "CREATE_SPEC_DIR") {
          const specDir = join(getSpecsOutputDir(), effect.name);
          if (!existsSync(specDir)) mkdirSync(specDir, { recursive: true });
        } else if (effect.type === "WRITE_REQUIREMENTS") {
          const reqPath = join(effect.specDir, "REQUIREMENTS.md");
          if (!existsSync(effect.specDir)) mkdirSync(effect.specDir, { recursive: true });
          writeFileSync(reqPath, effect.content, "utf-8");
        }
      }
    }

    // Best-effort WhatsApp notification (FR-7)
    await sendGitHubNotification(ghIssue);

  } else {
    // ── Existing voice/WhatsApp path (unchanged) ───────────────────
    if (currentState === "idle") {
      const t = runTransition("CALL_RECEIVED", { callId });
      result.transitions.push(t);
    }

    const stateAfterStep1 = readState();
    if (stateAfterStep1 === "call_active") {
      const t = runTransition("CALL_COMPLETED", {
        callId,
        callerName,
        fromNumber,
        triggerFile: basename(triggerPath),
        triggerPath,
      });
      result.transitions.push(t);
    }

    const stateAfterStep2 = readState();
    if (stateAfterStep2 === "triage") {
      const classification = classifyTranscript(transcript, callAnalysis);
      result.classification = classification;

      switch (classification) {
        case "requirements": {
          const specName = deriveSpecName(
            featureName || payload.spec?.call_summary || transcript.substring(0, 80),
          );
          result.specName = specName;
          const specDir = join(getSpecsOutputDir(), specName);
          writeActiveSpec(specDir);
          const t = runTransition("NEW_REQUIREMENTS", {
            specName, specDir, requirements: transcript,
          });
          result.transitions.push(t);
          break;
        }
        case "confirmation": {
          const t1 = runTransition("CONFIRMATION_RECEIVED", { specDir: "" });
          result.transitions.push(t1);
          const t2 = runTransition("RESET", {});
          result.transitions.push(t2);
          break;
        }
        case "unknown": {
          const t = runTransition("REJECTED", {
            reason: "Transcript could not be classified",
          });
          result.transitions.push(t);
          break;
        }
      }
    }

    // Execute filesystem side effects
    for (const t of result.transitions) {
      for (const effect of t.sideEffects) {
        if (effect.type === "CREATE_SPEC_DIR") {
          const specDir = join(getSpecsOutputDir(), effect.name);
          if (!existsSync(specDir)) mkdirSync(specDir, { recursive: true });
        } else if (effect.type === "WRITE_REQUIREMENTS") {
          const reqPath = join(effect.specDir, "REQUIREMENTS.md");
          if (!existsSync(effect.specDir)) mkdirSync(effect.specDir, { recursive: true });
          writeFileSync(reqPath, effect.content, "utf-8");
        }
      }
    }
  }

  // Move trigger to processed (both paths)
  result.movedTo = moveToProcessed(triggerPath);

} catch (err) {
  if (err instanceof InvalidTransitionError) {
    process.stderr.write(`Invalid transition: ${err.message}\n`);
    try { result.movedTo = moveToProcessed(triggerPath); } catch { /* ignore */ }
    result.transitions.push({
      from: err.from,
      to: err.from,
      event: err.event,
      sideEffects: [],
    });
  } else {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
```

**Note:** The `main()` function signature must change from `function main(): void` to `async function main(): Promise<void>` to support the `await sendGitHubNotification()` call. The final `main()` call at the bottom of the file becomes `main().catch(...)` or remains `main()` (top-level await is supported via the `#!/usr/bin/env node` ESM entry).

---

### 1.5 `src/config.ts` (MODIFY)

**Add four getter functions** (after `getMode()`, ~line 159)

```typescript
/**
 * Get the GitHub repo in { owner, name } form.
 * Reads GITHUB_REPO env var (must be "owner/repo" format).
 */
export function getGitHubRepo(): { owner: string; name: string } {
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
export function getGitHubPollInterval(): number {
  return parseInt(process.env.GITHUB_POLL_INTERVAL_MS ?? "60000", 10);
}

/**
 * Get the GitHub webhook secret for HMAC validation.
 * Returns null if not configured.
 */
export function getGitHubWebhookSecret(): string | null {
  return process.env.GITHUB_WEBHOOK_SECRET ?? null;
}

/**
 * Get the GitHub personal access token for API calls.
 * Returns null if not configured.
 */
export function getGitHubToken(): string | null {
  return process.env.GITHUB_TOKEN ?? null;
}
```

---

### 1.6 `scripts/startup.sh` (MODIFY)

**Add session-start GitHub check** (after the cloud-mode poller block, before "Clean stale PID files", ~line 56)

Insert:

```bash
# ── Session-start GitHub issue check (FR-3) ────────────────────────
if [ -f "$PLUGIN_ROOT/lib/cli/poll-github.js" ] && [ -n "${GITHUB_TOKEN:-}" ]; then
  echo "[startup/github] Checking for unprocessed GitHub issues..."
  OPERANT_PI_DATA_DIR="$DATA_DIR" node "$PLUGIN_ROOT/lib/cli/poll-github.js" --once 2>&1 || true
  echo "[startup/github] Session-start check complete"
fi
```

This runs a single poll cycle via the `--once` flag. The `|| true` ensures a GitHub API failure does not block session startup (the `set -euo pipefail` at the top would otherwise abort).

---

### 1.7 `commands/start.md` (MODIFY)

**Change: Append GitHub poller startup steps after existing step 4**

Replace the full file content with:

```markdown
---
description: Start the operant-pi voice pipeline (webhook server + tunnel + Retell registration)
allowed-tools: Bash(node:*), Bash(bash:*), Bash(cat:*), Bash(echo:*)
---

Start the operant-pi pipeline by running the startup sequence:

1. Start the webhook server:
!`npx tsx ${CLAUDE_PLUGIN_ROOT}/scripts/server.ts &`

2. Start the cloudflare tunnel:
!`bash ${CLAUDE_PLUGIN_ROOT}/scripts/tunnel.sh start`

3. Register the webhook URL with Retell:
!`node ${CLAUDE_PLUGIN_ROOT}/lib/cli/register-webhook.js $(cat ${OPERANT_PI_DATA_DIR:-spec/.operant}/tunnel_url.txt)`

4. Show the tunnel URL, server PID, and current pipeline state:
!`node ${CLAUDE_PLUGIN_ROOT}/lib/cli/status.js`

5. Start GitHub issue poller (if configured):
!`bash -c 'DATA_DIR="${OPERANT_PI_DATA_DIR:-spec/.operant}"; if [ -n "${GITHUB_REPO:-}" ] && [ -n "${GITHUB_TOKEN:-}" ] && [ -n "${TWILIO_WHATSAPP_RECIPIENT:-}" ]; then node ${CLAUDE_PLUGIN_ROOT}/lib/cli/poll-github.js & echo $! > "$DATA_DIR/github-poller.pid"; echo "[start] GitHub poller started (PID: $!, repo: $GITHUB_REPO)"; else echo "[start] GitHub poller skipped (GITHUB_REPO, GITHUB_TOKEN, or TWILIO_WHATSAPP_RECIPIENT not set)"; fi'`
```

---

### 1.8 `commands/stop.md` (MODIFY)

**Change: Add GitHub poller cleanup before existing cleanup**

Replace the full file content with:

```markdown
---
description: Stop the operant-pi voice pipeline (kill server, tunnel, clean PIDs)
allowed-tools: Bash(bash:*), Bash(cat:*), Bash(kill:*)
---

Stop the operant-pi pipeline:

1. Stop GitHub poller (if running):
!`bash -c 'DATA_DIR="${OPERANT_PI_DATA_DIR:-spec/.operant}"; PID_FILE="$DATA_DIR/github-poller.pid"; if [ -f "$PID_FILE" ]; then PID=$(cat "$PID_FILE"); kill "$PID" 2>/dev/null && echo "[stop] GitHub poller stopped (PID: $PID)" || echo "[stop] GitHub poller already dead"; rm -f "$PID_FILE"; else echo "[stop] No GitHub poller PID file"; fi'`

2. Stop server and tunnel:
!`bash ${CLAUDE_PLUGIN_ROOT}/scripts/cleanup.sh`

Report what was stopped (server PID, tunnel PID, poller PID) and confirm the pipeline is fully shut down.
```

---

## 2. API Contract: POST /webhook/github

### Request Headers

| Header | Required | Description |
|--------|----------|-------------|
| `X-Hub-Signature-256` | Yes | `sha256=<hex>` HMAC of raw body using `GITHUB_WEBHOOK_SECRET` |
| `X-GitHub-Event` | Yes | Event type string (e.g., `issues`, `push`, `ping`) |
| `Content-Type` | Yes | `application/json` |

### Request Body Schema (for `issues.opened`)

```typescript
{
  action: "opened";
  issue: {
    number: number;
    title: string;
    body: string | null;
    user: { login: string };
    html_url: string;
    labels: Array<{ name: string }>;
    created_at: string;  // ISO 8601
  };
  repository: { full_name: string };  // ignored
  sender: { login: string };          // ignored (use issue.user.login)
}
```

### Response Schemas

| Scenario | Status | Body |
|----------|--------|------|
| Valid `issues.opened` | `200` | `{ "processed": true, "issue": <number> }` |
| Non-`issues` event (e.g., `push`, `ping`) | `200` | `{ "ignored": true }` |
| `issues` event but action is not `opened` | `200` | `{ "ignored": true }` |
| HMAC mismatch | `401` | `{ "error": "Invalid signature" }` |
| Missing `X-Hub-Signature-256` header | `401` | `{ "error": "Missing signature" }` |
| `GITHUB_WEBHOOK_SECRET` not set | `500` | `{ "error": "Webhook secret not configured" }` |
| Invalid JSON body | `400` | `{ "error": "Invalid JSON" }` |
| Missing `issue` object in payload | `400` | `{ "error": "Missing issue object" }` |

### HMAC Validation Algorithm

1. Read raw request body as UTF-8 string (via `readRawBody()`).
2. Compute: `"sha256=" + HMAC-SHA256(GITHUB_WEBHOOK_SECRET, rawBody).hex()`.
3. Compare to `X-Hub-Signature-256` header using `crypto.timingSafeEqual`.
4. Reject with `401` if lengths differ or bytes mismatch.

---

## 3. FSM Changes

### Updated FSMEvent Type (full union)

```typescript
export type FSMEvent =
  | "CALL_RECEIVED"      | "CALL_COMPLETED"
  | "NEW_REQUIREMENTS"   | "CONFIRMATION_RECEIVED"
  | "REJECTED"           | "ARTIFACT_PRODUCED"
  | "REVIEW_APPROVED"    | "REVIEW_REJECTED"
  | "DEV_COMPLETE"       | "BLOCKER_DETECTED"
  | "BLOCKER_RESOLVED"   | "AUDIT_PASSED"
  | "AUDIT_FAILED"       | "REVISION_READY"
  | "USER_CONFIRMED"     | "USER_REJECTED"
  | "RESET"              | "DEMO_READY"
  | "USER_JOINED_MEET"   | "WALKTHROUGH_COMPLETE"
  | "DEMO_APPROVED"      | "DEMO_REJECTED"
  | "DEMO_SKIPPED"       | "DEMO_FAILED"
  | "ISSUE_RECEIVED";    // 24th event
```

### New Transition Entry

| # | From | Event | To | Side Effects |
|---|------|-------|----|-------------|
| T-NEW | `idle` | `ISSUE_RECEIVED` | `triage` | `EMIT_EVENT("log", { message: "GitHub issue received", issueNumber, author })` |

Total transition count after change: existing transitions + 1.

---

## 4. Data Formats

### Trigger File Schema

```typescript
interface GitHubTriggerFile {
  source: "github";
  github_issue: {
    number: number;       // e.g., 42
    title: string;        // e.g., "Login button misaligned on mobile"
    body: string;         // issue body text, "" if null
    author: string;       // e.g., "jane-doe"
    url: string;          // e.g., "https://github.com/owner/repo/issues/42"
    labels: string[];     // e.g., ["feedback", "bug"]
    created_at: string;   // ISO 8601
  };
  created_at: string;     // ISO 8601 timestamp of trigger file creation
}
```

Example:

```json
{
  "source": "github",
  "github_issue": {
    "number": 42,
    "title": "Login button misaligned on mobile",
    "body": "When viewing on iPhone 14, the login button overlaps the footer...",
    "author": "jane-doe",
    "url": "https://github.com/owner/repo/issues/42",
    "labels": ["feedback", "bug"],
    "created_at": "2026-06-18T10:30:00Z"
  },
  "created_at": "2026-06-18T10:30:05Z"
}
```

Filename convention: `github-<issue_number>-<Date.now()>.json`
Location: `spec/.operant/pending/`

### Cursor File Format

- **Path:** `spec/.operant/github-cursor.txt`
- **Content:** A single line containing an integer (highest processed issue number), followed by a newline.
- **Example:** `42\n`
- **Atomic write procedure:**
  1. `writeFileSync("github-cursor.txt.tmp", String(cursor) + "\n")`
  2. `renameSync("github-cursor.txt.tmp", "github-cursor.txt")`
- **Corruption recovery:** If `parseInt()` returns `NaN`, default to `0`. This triggers a full re-scan, which is safe due to the idempotency guard.

### REQUIREMENTS.md Template (GitHub-sourced)

```markdown
> Source: GitHub Issue #42 -- https://github.com/owner/repo/issues/42

<issue body text here>
```

### source-metadata.json (alongside REQUIREMENTS.md)

```json
{
  "source": "github",
  "issue_number": 42,
  "issue_url": "https://github.com/owner/repo/issues/42",
  "author": "jane-doe",
  "created_at": "2026-06-18T10:30:00Z"
}
```

---

## 5. Helper Functions

### `verifyGitHubSignature(rawBody, signature, secret)`

- **Location:** `scripts/server.ts` (module-private)
- **Signature:** `(rawBody: string, signature: string, secret: string) => boolean`
- **Algorithm:** HMAC-SHA256 using `node:crypto`. Computes `"sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex")`. Compares lengths first (fast reject), then uses `timingSafeEqual` on `Buffer` representations.
- **Edge cases:** Returns `false` if `signature` or `secret` is empty. Length mismatch returns `false` before `timingSafeEqual` to avoid the `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` error.

### `writeTriggerFile(issue, dataDir)`

- **Location:** `src/cli/poll-github.ts` (module-private, also inlined in `server.ts` as part of `handleGitHubWebhook`)
- **Signature:** `(issue: GitHubIssue, dataDir: string) => string` (returns filename)
- **Filename convention:** `github-<issue.number>-<Date.now()>.json`
- **Content:** JSON matching `GitHubTriggerFile` interface.
- **Idempotency:** The caller (`pollOnce`) checks `triggerExists()` before calling. The webhook handler writes unconditionally (ADR-006).

### `triggerExists(dataDir, issueNumber)`

- **Location:** `src/cli/poll-github.ts` (module-private)
- **Signature:** `(dataDir: string, issueNumber: number) => boolean`
- **Logic:** Checks both `pending/` and `processed/` directories (OQ-7 default B) for files matching `github-<issueNumber>-*.json` via `readdirSync` + `String.startsWith`.

### `readCursor(dataDir)` / `writeCursorAtomic(dataDir, cursor)`

- **Location:** `src/cli/poll-github.ts` (module-private)
- **Read:** `parseInt(readFileSync(...).trim(), 10)`, defaults to `0` on `NaN` or missing file.
- **Write:** `writeFileSync` to `.tmp`, then `renameSync` to final path (NFC-5).

### `sendGitHubNotification(issue)`

- **Location:** `src/cli/process-trigger.ts` (module-private)
- **Signature:** `(issue: NonNullable<TriggerPayload["github_issue"]>) => Promise<void>`
- **Best-effort:** Entire function wrapped in `try/catch`. Failures are logged, never thrown (FR-7, AC-FR7-2).

---

## 6. Environment Variables

| Variable | Required | Default | Description | Where Used |
|----------|----------|---------|-------------|------------|
| `GITHUB_WEBHOOK_SECRET` | Yes (webhook) | -- | Shared secret for HMAC-SHA256 webhook validation | `scripts/server.ts` `handleGitHubWebhook` |
| `GITHUB_TOKEN` | Yes (poller) | -- | PAT or fine-grained token with `issues:read` scope | `src/cli/poll-github.ts` `fetchIssues` |
| `GITHUB_REPO` | Yes (poller) | -- | Target repo in `owner/repo` format (e.g., `pegg-app/pegg.app`) | `src/cli/poll-github.ts`, `src/config.ts` |
| `GITHUB_POLL_INTERVAL_MS` | No | `60000` | Poll interval in milliseconds | `src/cli/poll-github.ts` main loop |
| `TWILIO_ACCOUNT_SID` | No | -- | Required for WhatsApp notification (existing var) | `process-trigger.ts` `sendGitHubNotification` |
| `TWILIO_AUTH_TOKEN` | No | -- | Required for WhatsApp notification (existing var) | `process-trigger.ts` `sendGitHubNotification` |
| `TWILIO_WHATSAPP_NUMBER` | No | -- | From number for WhatsApp (existing var) | `process-trigger.ts` `sendGitHubNotification` |
| `TWILIO_WHATSAPP_RECIPIENT` | No | -- | Notification target number (existing var) | `process-trigger.ts` `sendGitHubNotification` |

---

## 7. Ordered Implementation Tasks

1. **`src/config.ts`** -- Add four getter functions (`getGitHubRepo`, `getGitHubPollInterval`, `getGitHubWebhookSecret`, `getGitHubToken`). No dependencies on other changes.

2. **`src/state-machine.ts`** -- Add `ISSUE_RECEIVED` to `FSMEvent` union. Add transition entry to `idle` state map. Verify: `transition("idle", "ISSUE_RECEIVED", { issueNumber: "1", author: "test" })` returns `{ to: "triage", ... }`.

3. **`scripts/server.ts`** -- Add `node:crypto` import, `readdirSync` to fs import, `verifyGitHubSignature` helper, `handleGitHubWebhook` handler, route registration, startup log line.

4. **`src/cli/poll-github.ts`** -- Create new file with cursor I/O, GitHub API client, idempotency check, trigger writer, `pollOnce()`, and main loop with `--once` support. Depends on task 1 (config getters).

5. **`src/cli/process-trigger.ts`** -- Extend `TriggerPayload`, add `sendGitHubNotification`, add source discrimination branch. Depends on task 2 (FSM event).

6. **`scripts/startup.sh`** -- Add session-start GitHub check block. Depends on task 4 (poll-github.ts exists).

7. **`commands/start.md`** -- Append GitHub poller startup step (step 5): verify env vars, start `poll-github.js` background process, write PID file. Depends on task 4 (poll-github.ts exists).

8. **`commands/stop.md`** -- Prepend GitHub poller cleanup step: read PID file, kill process, remove PID file. No code dependencies.

9. **Build and verify** -- Run `tsc` to compile. Verify `lib/cli/poll-github.js` is emitted. Verify existing tests still pass.

---

## 8. Acceptance Criteria Mapping

| AC ID | Criterion | Implementation |
|-------|-----------|----------------|
| AC-FR1-1 | Valid `issues.opened` writes trigger file | `handleGitHubWebhook` in `server.ts`: HMAC passes, event=issues, action=opened, writes to `PENDING_DIR` |
| AC-FR1-2 | Invalid HMAC returns 401, no file | `verifyGitHubSignature` returns false, handler returns 401 before any `writeFileSync` |
| AC-FR1-3 | `push` event returns 200 ignored | Event filter: `event !== "issues"` returns `{ ignored: true }` |
| AC-FR1-4 | `issues.closed` returns 200 ignored | Action filter: `payload.action !== "opened"` returns `{ ignored: true }` |
| AC-FR1-5 | Null body defaults to empty string | `(issue.body as string) ?? ""` in extraction step |
| AC-FR2-1 | First run processes all feedback issues | `readCursor` returns 0, all issues pass `number > 0` filter |
| AC-FR2-2 | Subsequent runs skip processed issues | Cursor persisted via `writeCursorAtomic`, only `number > cursor` processed |
| AC-FR2-3 | Existing trigger not re-created | `triggerExists()` checks `pending/` and `processed/` before `writeTriggerFile` |
| AC-FR2-4 | API error logged, no crash | `try/catch` around `fetchIssues` in `pollOnce`, logs error, continues |
| AC-FR2-5 | Interval configurable | `getGitHubPollInterval()` reads `GITHUB_POLL_INTERVAL_MS`, used in `setInterval` |
| AC-FR3-1 | Session-start catches offline issues | `startup.sh` runs `poll-github.js --once` before main loop |
| AC-FR3-2 | `--once` runs single cycle and exits | `if (!once) setInterval(...)` -- without flag, exits after `pollOnce()` |
| AC-FR4-1 | Backward compat for voice/WhatsApp | `source` field is optional, defaults to `"voice"` via `payload.source ?? "voice"` |
| AC-FR4-2 | GitHub trigger has source + github_issue | Trigger file writer sets both fields in `triggerData` object |
| AC-FR5-1 | GitHub fires ISSUE_RECEIVED not CALL_RECEIVED | `source === "github"` branch calls `runTransition("ISSUE_RECEIVED", ...)` |
| AC-FR5-2 | REQUIREMENTS.md has body + source ref | Content built as `> Source: GitHub Issue #N -- URL\n\n<body>` |
| AC-FR5-3 | deriveSpecName gets issue title | `deriveSpecName(featureName)` where `featureName = ghIssue.title` |
| AC-FR5-4 | Empty body uses title | `issueBody.length >= 20 ? issueBody : ghIssue.title` |
| AC-FR5-5 | Voice triggers unaffected | `else` branch preserves exact existing code path |
| AC-FR6-1 | `transition("idle", "ISSUE_RECEIVED")` returns triage | New entry in TRANSITIONS map: `idle + ISSUE_RECEIVED -> triage` |
| AC-FR6-2 | `transition("call_active", "ISSUE_RECEIVED")` errors | No entry for `ISSUE_RECEIVED` in `call_active` map, throws `InvalidTransitionError` |
| AC-FR6-3 | FSM module stays pure | No new `fs`/`path`/network imports added to `state-machine.ts` |
| AC-FR6-4 | 23 existing events unchanged | Only additive change: one new union member + one new map entry |
| AC-FR7-1 | GitHub trigger sends WhatsApp notification | `sendGitHubNotification()` called after REQUIREMENTS.md written |
| AC-FR7-2 | Notification failure does not block pipeline | Entire function in `try/catch`, logs error, returns void |
| AC-FR7-3 | Voice/WhatsApp notifications unchanged | Notification code is in the `source === "github"` branch only |
| AC-1 | E2E webhook path | Webhook writes trigger -> process-trigger reads -> ISSUE_RECEIVED -> triage -> REQUIREMENTS.md -> WhatsApp notify |
| AC-2 | E2E poller path | poll-github writes trigger -> same downstream as AC-1 |
| AC-3 | Session restart recovery | startup.sh runs `poll-github.js --once` -> catches offline issues |
| AC-4 | Deduplication | Filename convention + `triggerExists()` + cursor + FSM InvalidTransitionError |
| AC-5 | Voice regression | `source ?? "voice"` defaults to `else` branch, code is identical to pre-change |
| AC-6 | WhatsApp regression | WhatsApp triggers have `source: "whatsapp"`, which hits the `else` branch (same path as voice) |
| AC-7 | Invalid HMAC rejection | `verifyGitHubSignature` returns false -> 401, no side effects |
| AC-FR8-1 | `/operant:start` starts poller when env vars set | `commands/start.md` step 5: checks env vars, runs `poll-github.js &`, writes PID file |
| AC-FR8-2 | `/operant:start` warns but continues without env vars | `commands/start.md` step 5: `else` branch logs skip message |
| AC-FR8-3 | `/operant:stop` kills poller | `commands/stop.md` step 1: reads PID file, kills process, removes file |
| AC-FR8-4 | Stale poller PID cleaned on startup | Existing `startup.sh` stale-PID loop iterates `*.pid` files including `github-poller.pid` |
