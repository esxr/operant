# Implementation Spec: WhatsApp Group Notifications via Conversations API

**Version:** 1.0
**Date:** 2026-06-18
**Status:** Draft
**Parents:** [Intent](intent-and-constraints.md) | [HLD](high-level-design.md) | [ADR](adr-lite.md)

---

## 1. File-by-File Changes

### 1.1 `src/config.ts` (MODIFY)

**Change 1: Add `renameSync` to `node:fs` import** (line 8)

The existing import on line 8 is:
```typescript
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
```

Replace with:
```typescript
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
```

**Change 2: Add three new exported functions** (after `getGitHubToken()`, after line 197 — append to end of file)

```typescript
/**
 * Get the WhatsApp participants list for group notifications.
 * Reads OPERANT_WHATSAPP_PARTICIPANTS env var (comma-separated +<number> values).
 * Returns [] when the variable is absent or empty — triggers 1:1 fallback (FR-5).
 */
export function getWhatsAppParticipants(): string[] {
  const raw = process.env.OPERANT_WHATSAPP_PARTICIPANTS ?? "";
  if (!raw.trim()) return [];
  return raw.split(",").map((n) => n.trim()).filter(Boolean);
}

/**
 * Read the stored Twilio Conversation SID from conversation-sid.txt.
 * Returns null if the file is absent or empty (triggers conversation creation on first use).
 */
export function getConversationSid(): string | null {
  const path = join(getDataDir(), "conversation-sid.txt");
  try {
    const raw = readFileSync(path, "utf-8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Atomically write a Twilio Conversation SID to conversation-sid.txt.
 * Uses write-tmp-then-rename pattern (NFC-4) matching github-cursor.txt.
 */
export function writeConversationSid(sid: string): void {
  const dataDir = getDataDir();
  mkdirSync(dataDir, { recursive: true });
  const tmpPath = join(dataDir, "conversation-sid.txt.tmp");
  const finalPath = join(dataDir, "conversation-sid.txt");
  writeFileSync(tmpPath, sid + "\n");
  renameSync(tmpPath, finalPath);
}
```

No other lines in `config.ts` are modified.

---

### 1.2 `src/whatsapp.ts` (MODIFY)

**Change 1: Extend the import from `config.js`** (line 15)

Current line 15:
```typescript
import { getMode, getOperantApiKey, getOperantApiUrl } from './config.js';
```

Replace with:
```typescript
import {
  getMode,
  getOperantApiKey,
  getOperantApiUrl,
  getWhatsAppParticipants,
  getConversationSid,
  writeConversationSid,
} from './config.js';
```

**Change 2: Add three new module-private functions** (insert after `cloudSendWhatsApp()`, before the `// WhatsAppChannel` comment block — after line 237)

Insert the following block in full:

```typescript
// ---------------------------------------------------------------------------
// Conversations API (group notifications — ADR-001, ADR-002)
// ---------------------------------------------------------------------------

interface ConversationsApiResponse {
  status: number;
  data: Record<string, unknown>;
}

/**
 * Low-level HTTPS helper for conversations.twilio.com.
 * Structurally identical to sendTwilioMessage() but targets a different hostname
 * and returns { status, data } so callers can inspect HTTP status codes (e.g.,
 * 409 = participant already exists, 404 = conversation deleted).
 *
 * POST requests encode the body as application/x-www-form-urlencoded (ADR-002).
 * GET requests send no body.
 *
 * @param accountSid  TWILIO_ACCOUNT_SID — used as Basic auth username
 * @param authToken   TWILIO_AUTH_TOKEN  — used as Basic auth password
 * @param method      "GET" | "POST"
 * @param path        Path relative to https://conversations.twilio.com (e.g. "/v1/Conversations")
 * @param body        Key-value pairs for POST body (omit for GET)
 * @param httpClient  Optional injected https module (for unit tests)
 */
function callConversationsApi(
  accountSid: string,
  authToken: string,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, string>,
  httpClient: typeof https = https,
): Promise<ConversationsApiResponse> {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
    const payload = body ? new URLSearchParams(body).toString() : "";

    const options: import("node:https").RequestOptions = {
      hostname: "conversations.twilio.com",
      port: 443,
      path,
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        ...(method === "POST"
          ? {
              "Content-Type": "application/x-www-form-urlencoded",
              "Content-Length": String(Buffer.byteLength(payload)),
            }
          : {}),
      },
    };

    const req = httpClient.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk: Buffer) => { raw += chunk; });
      res.on("end", () => {
        let data: Record<string, unknown>;
        try { data = JSON.parse(raw); }
        catch { data = { raw }; }
        resolve({ status: res.statusCode ?? 0, data });
      });
    });

    req.on("error", (err) => reject(new Error(`Conversations API request failed: ${err.message}`)));

    if (method === "POST" && payload) {
      req.write(payload);
    }
    req.end();
  });
}

/**
 * Ensure a Twilio Conversation exists and return its SID (ADR-004: lazy creation).
 *
 * Lifecycle:
 *  1. Read stored SID from conversation-sid.txt via getSid().
 *  2. If SID found: GET /v1/Conversations/{sid}. 200 -> reuse. 404 -> recreate.
 *  3. POST /v1/Conversations to create. Throws on 4xx/5xx.
 *  4. Atomic-write new SID via writeSid().
 *  5. For each participant: POST /v1/Conversations/{sid}/Participants.
 *     409 -> log and skip. Other 4xx/5xx -> log warning and skip (ADR-012).
 *
 * FriendlyName uses the project directory basename (ADR-007).
 * MessagingServiceSid is included only when TWILIO_MESSAGING_SERVICE_SID is set (ADR-008).
 *
 * @param accountSid      TWILIO_ACCOUNT_SID
 * @param authToken       TWILIO_AUTH_TOKEN
 * @param whatsappNumber  TWILIO_WHATSAPP_NUMBER (with or without "whatsapp:" prefix)
 * @param participants    Array of E.164 phone numbers (e.g. ["+14155550001"])
 * @param getSid          Injectable getter for unit tests (defaults to getConversationSid)
 * @param writeSid        Injectable writer for unit tests (defaults to writeConversationSid)
 * @param httpClient      Injectable https module for unit tests
 */
async function ensureConversation(
  accountSid: string,
  authToken: string,
  whatsappNumber: string,
  participants: string[],
  getSid: () => string | null = getConversationSid,
  writeSid: (sid: string) => void = writeConversationSid,
  httpClient: typeof https = https,
): Promise<string> {
  // Step 1: Check for a cached SID
  let sid = getSid();

  if (sid) {
    // Step 2: Validate the stored SID
    const checkResult = await callConversationsApi(
      accountSid,
      authToken,
      "GET",
      `/v1/Conversations/${sid}`,
      undefined,
      httpClient,
    );

    if (checkResult.status === 200) {
      // Fast path: conversation still exists, reuse it
      return sid;
    }

    if (checkResult.status === 404) {
      process.stderr.write(`[whatsapp] Conversation ${sid} not found, recreating\n`);
      sid = null;
    } else {
      // Unexpected status — throw so caller falls back to 1:1
      throw new Error(
        `Conversations API error ${checkResult.status} validating SID ${sid}: ` +
        JSON.stringify(checkResult.data).slice(0, 200),
      );
    }
  }

  // Step 3: Create a new Conversation
  const projectBasename = process.cwd().split("/").pop() ?? "project";
  const createBody: Record<string, string> = {
    FriendlyName: `Operant Pipeline - ${projectBasename}`,
  };

  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  if (!messagingServiceSid) {
    process.stderr.write(
      "[whatsapp] TWILIO_MESSAGING_SERVICE_SID not set; Conversation creation may fail outside sandbox.\n",
    );
  } else {
    createBody.MessagingServiceSid = messagingServiceSid;
  }

  const createResult = await callConversationsApi(
    accountSid,
    authToken,
    "POST",
    "/v1/Conversations",
    createBody,
    httpClient,
  );

  if (createResult.status < 200 || createResult.status >= 300) {
    throw new Error(
      `Conversations API error ${createResult.status} creating conversation: ` +
      JSON.stringify(createResult.data).slice(0, 200),
    );
  }

  const newSid = createResult.data.sid as string;

  // Step 4: Persist the SID atomically
  writeSid(newSid);

  // Step 5: Add participants
  const proxyAddress = whatsappNumber.startsWith("whatsapp:")
    ? whatsappNumber
    : `whatsapp:${whatsappNumber}`;

  for (const number of participants) {
    const participantBody: Record<string, string> = {
      "MessagingBinding.Address": `whatsapp:${number}`,
      "MessagingBinding.ProxyAddress": proxyAddress,
    };

    const addResult = await callConversationsApi(
      accountSid,
      authToken,
      "POST",
      `/v1/Conversations/${newSid}/Participants`,
      participantBody,
      httpClient,
    );

    if (addResult.status === 409) {
      process.stderr.write(
        `[whatsapp] Participant ${number} already in conversation, skipping\n`,
      );
    } else if (addResult.status < 200 || addResult.status >= 300) {
      process.stderr.write(
        `[whatsapp] Failed to add participant ${number} to conversation ${newSid}: ` +
        `HTTP ${addResult.status} — skipping\n`,
      );
    }
    // 2xx: participant added successfully, no log needed
  }

  return newSid;
}

/**
 * Send a message to a Twilio Conversation.
 * Throws if the Conversations API returns a 4xx/5xx — caller is responsible
 * for catch + fallback to 1:1 (FR-5).
 *
 * @param accountSid      TWILIO_ACCOUNT_SID
 * @param authToken       TWILIO_AUTH_TOKEN
 * @param conversationSid Active SID returned by ensureConversation()
 * @param body            Plain-text message body (same string as today's Messages API body)
 * @param httpClient      Injectable https module for unit tests
 */
async function sendConversationMessage(
  accountSid: string,
  authToken: string,
  conversationSid: string,
  body: string,
  httpClient: typeof https = https,
): Promise<void> {
  const result = await callConversationsApi(
    accountSid,
    authToken,
    "POST",
    `/v1/Conversations/${conversationSid}/Messages`,
    { Body: body, Author: "operant" },
    httpClient,
  );

  if (result.status < 200 || result.status >= 300) {
    throw new Error(
      `Conversations API error ${result.status} sending message: ` +
      JSON.stringify(result.data).slice(0, 200),
    );
  }
}

/**
 * Send a WhatsApp notification using the best available path:
 *   - Group (Conversations API): when OPERANT_WHATSAPP_PARTICIPANTS is set and mode is local
 *   - Cloud proxy: when OPERANT_API_KEY is set (cloud mode)
 *   - 1:1 Messages API: fallback when participants list is empty OR Conversations API throws
 *
 * Called by process-trigger.ts for trigger-received notifications (ADR-011).
 * All errors are caught and logged — never thrown (FR-5 AC-FR5-2).
 *
 * @param message  Plain-text message to deliver
 */
export async function sendGroupNotification(message: string): Promise<void> {
  try {
    const participants = getWhatsAppParticipants();

    // Cloud mode: continue via existing proxy regardless of participants (ADR-009)
    if (getMode() === "cloud") {
      const recipient = process.env.TWILIO_WHATSAPP_RECIPIENT ?? "";
      const to = recipient.replace("whatsapp:", "");
      await cloudSendWhatsApp(to, message);
      return;
    }

    // Local mode with participants: use Conversations API
    if (participants.length > 0) {
      const accountSid = process.env.TWILIO_ACCOUNT_SID;
      const authToken = process.env.TWILIO_AUTH_TOKEN;
      const whatsappNumber = process.env.TWILIO_WHATSAPP_NUMBER;

      if (!accountSid || !authToken || !whatsappNumber) {
        process.stderr.write(
          "[whatsapp] Missing Twilio config for Conversations API, falling back to 1:1\n",
        );
        // fall through to 1:1 path below
      } else {
        try {
          const sid = await ensureConversation(
            accountSid,
            authToken,
            whatsappNumber,
            participants,
          );
          await sendConversationMessage(accountSid, authToken, sid, message);
          process.stderr.write(
            `[whatsapp] Sent to conversation ${sid} (${participants.length} participants)\n`,
          );
          return;
        } catch (err) {
          process.stderr.write(
            `[whatsapp] Conversations API error: ${(err as Error).message}, falling back to 1:1\n`,
          );
          // fall through to 1:1 path below
        }
      }
    }

    // Local 1:1 fallback (original path: empty participants OR Conversations error)
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const whatsappFrom = process.env.TWILIO_WHATSAPP_NUMBER;
    const whatsappTo = process.env.TWILIO_WHATSAPP_RECIPIENT;

    if (!accountSid || !authToken || !whatsappFrom || !whatsappTo) {
      process.stderr.write("[whatsapp] WhatsApp not configured, skipping notification\n");
      return;
    }

    const config: TwilioConfig = {
      accountSid,
      authToken,
      whatsappNumber: whatsappFrom.startsWith("whatsapp:")
        ? whatsappFrom
        : `whatsapp:${whatsappFrom}`,
      recipientNumber: whatsappTo.startsWith("whatsapp:")
        ? whatsappTo
        : `whatsapp:${whatsappTo}`,
      sandbox: process.env.TWILIO_WHATSAPP_SANDBOX === "1",
    };

    await sendTwilioMessage(config, message);
    process.stderr.write("[whatsapp] Sent 1:1 WhatsApp notification\n");
  } catch (err) {
    process.stderr.write(
      `[whatsapp] Notification failed: ${(err as Error).message}\n`,
    );
  }
}
```

**Change 3: Add group send branch to `sendGate()`** (inside `WhatsAppChannel.sendGate()`, insert after the `// Local mode: existing code` comment on line 290, before line 291 `const config = getConfig();`)

Insert the following block between line 290 (`// Local mode: existing code`) and line 291 (`const config = getConfig();`):

```typescript
    // Group send path (local mode, participants configured — ADR-001, ADR-009)
    const participants = getWhatsAppParticipants();
    if (participants.length > 0) {
      const accountSid = process.env.TWILIO_ACCOUNT_SID;
      const authToken = process.env.TWILIO_AUTH_TOKEN;
      const whatsappNumber = process.env.TWILIO_WHATSAPP_NUMBER;

      if (accountSid && authToken && whatsappNumber) {
        try {
          this.log(
            `[whatsapp] Sending ${context.mode} gate to conversation (${participants.length} participants)`,
          );
          // Register reply listener BEFORE sending to avoid race condition (ADR-010)
          const replyPromise = new Promise<GateReply>((resolve) => {
            const handler = (reply: {
              fromNumber: string;
              body: string;
              callerName: string;
              interactionId: string;
            }) => {
              const parsed = parseReply(reply.body);
              resolve({
                interactionId: reply.interactionId,
                source: "whatsapp",
                decision: parsed.decision,
                rawText: reply.body,
                feedback: parsed.feedback,
                callerName: reply.callerName,
                fromNumber: reply.fromNumber,
              });
            };
            whatsappEvents.once("whatsapp:reply", handler);
          });

          const sid = await ensureConversation(
            accountSid,
            authToken,
            whatsappNumber,
            participants,
          );
          await sendConversationMessage(accountSid, authToken, sid, body);
          return replyPromise;
        } catch (err) {
          this.log(
            `[whatsapp] Conversations API error: ${(err as Error).message}, falling back to 1:1`,
          );
          // Fall through to existing 1:1 local path below
        }
      }
    }
```

The remainder of `sendGate()` from `const config = getConfig();` onward is **unchanged**.

---

### 1.3 `src/cli/process-trigger.ts` (MODIFY)

**Change 1: Add `sendGroupNotification` to the imports** (after line 33 `} from "../config.js";`)

Current import block (lines 18-33):
```typescript
import {
  getDataDir,
  getSpecsOutputDir,
  readState,
  writeState,
  writeActiveSpec,
  ensureDataDir,
} from "../config.js";
```

Add a new import statement immediately after:
```typescript
import { sendGroupNotification } from "../whatsapp.js";
```

**Change 2: Replace the entire `sendGitHubNotification()` function** (lines 108-168)

Delete lines 108-168 (the `sendGitHubNotification` async function). Replace the entire function with a one-liner delegating to `sendGroupNotification`:

```typescript
// ---------------------------------------------------------------------------
// GitHub notification helper (delegates to whatsapp.ts — ADR-011)
// ---------------------------------------------------------------------------

async function sendGitHubNotification(
  issue: NonNullable<TriggerPayload["github_issue"]>,
): Promise<void> {
  const msg = [
    `New feedback from @${issue.author}: "${issue.title}"`,
    `Issue #${issue.number}: ${issue.url}`,
    `Starting pipeline.`,
  ].join("\n");
  await sendGroupNotification(msg);
}
```

**No other lines in `process-trigger.ts` are changed.** The call site at line 313 (`await sendGitHubNotification(ghIssue);`) and all FSM logic remain identical to the current file.

Note: `import https from "node:https"` on line 129 inside `sendGitHubNotification` (dynamic import) is removed as part of deleting that function. Verify no other reference to `https` exists in the file after deletion; if the top-level imports at line 14 include `https`, remove it. The current file uses a dynamic `await import("node:https")` only inside the deleted function — no top-level `https` import exists on line 14, so no additional cleanup is needed.

---

## 2. API Contract: Twilio Conversations API

### Base URL

`https://conversations.twilio.com`

### Authentication

All requests use HTTP Basic Auth with `TWILIO_ACCOUNT_SID` as username and `TWILIO_AUTH_TOKEN` as password. The `Authorization` header value is `Basic <base64(accountSid:authToken)>`.

### Endpoint 1: Validate Conversation

**`GET /v1/Conversations/{ConversationSid}`**

Used by `ensureConversation()` to check whether a stored SID is still valid.

Request: No body. Authorization header only.

Response codes handled:
| Status | Meaning | Handler Action |
|--------|---------|----------------|
| `200 OK` | Conversation exists | Return the stored SID (fast path) |
| `404 Not Found` | Conversation was deleted | Log warning, clear SID, proceed to create |
| Other 4xx/5xx | Unexpected error | Throw `Error("Conversations API error <status> validating SID ...")` |

### Endpoint 2: Create Conversation

**`POST /v1/Conversations`**

Called when no stored SID exists or the stored SID returned 404.

Request body (`application/x-www-form-urlencoded`):

| Field | Required | Value |
|-------|----------|-------|
| `FriendlyName` | Yes | `"Operant Pipeline - <cwd-basename>"` (ADR-007) |
| `MessagingServiceSid` | No | Value of `TWILIO_MESSAGING_SERVICE_SID` if set (ADR-008) |

Response codes handled:
| Status | Meaning | Handler Action |
|--------|---------|----------------|
| `201 Created` | Conversation created | Extract `response.sid`, write to `conversation-sid.txt` |
| Other 4xx/5xx | Creation failed | Throw `Error("Conversations API error <status> creating conversation ...")` |

Response body field used: `sid` (string, e.g., `"CH1234abcd..."`)

### Endpoint 3: Add Participant

**`POST /v1/Conversations/{ConversationSid}/Participants`**

Called once per entry in `getWhatsAppParticipants()` after conversation creation.

Request body (`application/x-www-form-urlencoded`):

| Field | Required | Value |
|-------|----------|-------|
| `MessagingBinding.Address` | Yes | `"whatsapp:+<number>"` — the participant's WhatsApp number |
| `MessagingBinding.ProxyAddress` | Yes | `"whatsapp:<TWILIO_WHATSAPP_NUMBER>"` — the Twilio sender number |

Note: The dot notation in field names (`MessagingBinding.Address`) maps to `MessagingBinding[Address]` in Twilio's API. Use the literal dot form in the `URLSearchParams` body.

Response codes handled:
| Status | Meaning | Handler Action |
|--------|---------|----------------|
| `201 Created` | Participant added | Continue to next participant |
| `409 Conflict` | Participant already in conversation | Log `"[whatsapp] Participant <number> already in conversation, skipping"`, continue |
| Other 4xx/5xx | Add failed (e.g., invalid number) | Log `"[whatsapp] Failed to add participant <number> to conversation <sid>: HTTP <status> — skipping"`, continue (ADR-012) |

### Endpoint 4: Send Message to Conversation

**`POST /v1/Conversations/{ConversationSid}/Messages`**

Request body (`application/x-www-form-urlencoded`):

| Field | Required | Value |
|-------|----------|-------|
| `Body` | Yes | The plain-text message string |
| `Author` | Yes | `"operant"` — identifies the sender in the conversation thread |

Response codes handled:
| Status | Meaning | Handler Action |
|--------|---------|----------------|
| `201 Created` | Message sent to all participants | Return (no log needed — caller logs) |
| Other 4xx/5xx | Send failed | Throw `Error("Conversations API error <status> sending message ...")` |

---

## 3. Data Formats

### conversation-sid.txt

**Path:** `{OPERANT_PI_DATA_DIR}/conversation-sid.txt`  
(Default: `spec/.operant/conversation-sid.txt`)

**Content:** A single Twilio Conversation SID string followed by a newline character.

```
CH1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p
```

**Atomic write procedure:**
1. `writeFileSync("{dataDir}/conversation-sid.txt.tmp", sid + "\n")`
2. `renameSync("{dataDir}/conversation-sid.txt.tmp", "{dataDir}/conversation-sid.txt")`

**Read procedure:**
- `readFileSync("{dataDir}/conversation-sid.txt", "utf-8").trim()`
- Returns `null` on `ENOENT` or empty string

**Corruption recovery:** If the file contains a non-`CH...` string, `ensureConversation()` will attempt a GET that returns 404 or an unexpected status, and will either recreate or throw, which falls back to 1:1. No special validation of the SID format is performed.

### New Environment Variables

| Variable | Required | Format | Description |
|----------|----------|--------|-------------|
| `OPERANT_WHATSAPP_PARTICIPANTS` | No | Comma-separated `+<country><number>` list | Participant phone numbers for group notifications. Example: `+14155550001,+14155550002`. When absent or empty, 1:1 fallback is used. |
| `TWILIO_MESSAGING_SERVICE_SID` | No | `MG...` | Twilio Messaging Service SID to associate with the Conversation. Required for production WhatsApp Business; omit for sandbox use. |

### Existing Environment Variables Reused

| Variable | Role in this Feature |
|----------|---------------------|
| `TWILIO_ACCOUNT_SID` | Basic auth username for Conversations API |
| `TWILIO_AUTH_TOKEN` | Basic auth password for Conversations API |
| `TWILIO_WHATSAPP_NUMBER` | `MessagingBinding.ProxyAddress` when adding participants |
| `TWILIO_WHATSAPP_RECIPIENT` | 1:1 fallback recipient when `OPERANT_WHATSAPP_PARTICIPANTS` is unset |

---

## 4. Helper Function Signatures

### `src/config.ts`

```typescript
// Returns [] when OPERANT_WHATSAPP_PARTICIPANTS is unset or empty (triggers 1:1 fallback)
export function getWhatsAppParticipants(): string[]

// Returns null when conversation-sid.txt is absent or empty (triggers conversation creation)
export function getConversationSid(): string | null

// Atomic write: write-tmp-then-rename. Creates dataDir if needed.
export function writeConversationSid(sid: string): void
```

### `src/whatsapp.ts`

```typescript
// Module-private: low-level HTTPS helper for conversations.twilio.com
// Returns { status, data } without throwing on 4xx/5xx so callers can inspect status.
// httpClient is injectable for unit tests.
function callConversationsApi(
  accountSid: string,
  authToken: string,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, string>,
  httpClient?: typeof https,
): Promise<{ status: number; data: Record<string, unknown> }>

// Module-private: lifecycle function — create-or-reuse conversation, add participants.
// getSid/writeSid/httpClient are injectable for unit tests.
// Throws on unexpected API errors; caller (sendGroupNotification, sendGate) catches and falls back to 1:1.
async function ensureConversation(
  accountSid: string,
  authToken: string,
  whatsappNumber: string,
  participants: string[],
  getSid?: () => string | null,
  writeSid?: (sid: string) => void,
  httpClient?: typeof https,
): Promise<string>  // returns active Conversation SID

// Module-private: sends a message to a Conversation. Throws on 4xx/5xx.
async function sendConversationMessage(
  accountSid: string,
  authToken: string,
  conversationSid: string,
  body: string,
  httpClient?: typeof https,
): Promise<void>

// Exported: single entry-point for all pipeline WhatsApp notifications.
// Handles routing (group vs cloud vs 1:1) and swallows all errors.
export async function sendGroupNotification(message: string): Promise<void>
```

---

## 5. Ordered Implementation Tasks

Dependencies are listed in brackets; tasks with no brackets have no prerequisites.

**Task 1: `src/config.ts` — add imports and three getters**

- Add `renameSync` to the `node:fs` destructured import (line 8).
- Append `getWhatsAppParticipants()`, `getConversationSid()`, `writeConversationSid()` after `getGitHubToken()`.
- No dependencies on other tasks.
- Verify: `import { getWhatsAppParticipants, getConversationSid, writeConversationSid } from "./config.js"` compiles without error.

**Task 2: `src/whatsapp.ts` — extend config import**

[Depends on Task 1]

- Add `getWhatsAppParticipants`, `getConversationSid`, `writeConversationSid` to the import from `./config.js` (line 15).
- No logic changes yet; this makes the next task compile.

**Task 3: `src/whatsapp.ts` — add `callConversationsApi()`**

[Depends on Task 2]

- Insert `interface ConversationsApiResponse` and `callConversationsApi()` after `cloudSendWhatsApp()` (after line 237).
- Verify: TypeScript type-checks — `httpClient: typeof https = https` requires the `https` import already present on line 12.

**Task 4: `src/whatsapp.ts` — add `ensureConversation()`**

[Depends on Task 3]

- Insert `ensureConversation()` after `callConversationsApi()`.
- Verify: all three injectable parameters default correctly; the `getSid`/`writeSid` defaults reference `getConversationSid`/`writeConversationSid` imported in Task 2.

**Task 5: `src/whatsapp.ts` — add `sendConversationMessage()`**

[Depends on Task 3]

- Insert `sendConversationMessage()` after `ensureConversation()`.
- Task 4 and Task 5 can be done in either order; neither calls the other.

**Task 6: `src/whatsapp.ts` — add exported `sendGroupNotification()`**

[Depends on Tasks 4 and 5]

- Insert `sendGroupNotification()` after `sendConversationMessage()`, still before the `// WhatsAppChannel` section comment.
- This function calls `ensureConversation()`, `sendConversationMessage()`, `cloudSendWhatsApp()`, and `sendTwilioMessage()` — all must exist.

**Task 7: `src/whatsapp.ts` — add group branch to `sendGate()`**

[Depends on Tasks 4 and 5]

- Insert the group send branch in `WhatsAppChannel.sendGate()` between the `// Local mode: existing code` comment and `const config = getConfig();`.
- Critical: the `.once()` listener registration MUST appear before the `ensureConversation()` + `sendConversationMessage()` calls within the same branch. The code block in Section 1.2 Change 3 has the correct ordering (register `replyPromise` first, then call `ensureConversation`, then `sendConversationMessage`, then `return replyPromise`).

**Task 8: `src/cli/process-trigger.ts` — replace `sendGitHubNotification()` and add import**

[Depends on Task 6]

- Add `import { sendGroupNotification } from "../whatsapp.js";` after the `config.js` import block.
- Delete lines 108-168 (the inline `sendGitHubNotification` function with its embedded HTTPS code).
- Insert the new four-line `sendGitHubNotification` wrapper from Section 1.3 Change 2.
- The call site on line 313 (`await sendGitHubNotification(ghIssue);`) remains unchanged.

**Task 9: Build and verify**

[Depends on Tasks 1-8]

- Run `npx tsc --noEmit` (or the project's build command) and confirm zero new errors.
- Confirm `lib/cli/process-trigger.js` and `lib/whatsapp.js` are regenerated.
- Confirm `lib/config.js` exports the three new functions.

---

## 6. Acceptance Criteria Mapping

| AC ID | Criterion | Implementation Location |
|-------|-----------|------------------------|
| AC-FR1-1 | First notification creates a Conversation and persists the SID | `ensureConversation()` step 3-4: POST `/v1/Conversations`, then `writeSid(newSid)` |
| AC-FR1-2 | Subsequent notifications reuse the stored SID | `ensureConversation()` step 1-2: `getSid()` returns non-null, GET validates, returns cached SID |
| AC-FR1-3 | Invalid/deleted SID triggers recreation | `ensureConversation()` step 2: GET returns 404, logs warning, clears `sid = null`, falls through to creation |
| AC-FR2-1 | All numbers in `OPERANT_WHATSAPP_PARTICIPANTS` are added to the Conversation | `ensureConversation()` step 5: iterates `participants` array, POST `/v1/Conversations/{sid}/Participants` for each |
| AC-FR2-2 | Re-adding an existing participant does not error | `ensureConversation()` step 5: HTTP 409 is caught, logs and continues — no throw |
| AC-FR2-3 | Each participant receives messages sent to the Conversation | Twilio platform behavior; enabled by correct `MessagingBinding.Address` and `MessagingBinding.ProxyAddress` in step 5 |
| AC-FR3-1 | A Conversations API notification is received by all participants | `sendConversationMessage()`: POST `/v1/Conversations/{sid}/Messages` with `Body` and `Author=operant` |
| AC-FR3-2 | Gate request messages include the same structured reply options | `formatGateMessage()` is unchanged; its output string is passed verbatim as `body` to `sendConversationMessage()` |
| AC-FR3-3 | The first participant to reply "1" approves the gate for everyone | `sendGate()` group branch: `whatsappEvents.once("whatsapp:reply", handler)` — `.once()` deregisters after first emission |
| AC-FR4-1 | Pranav can approve a gate by replying "1" to the group conversation | Inbound webhook path is unchanged; reply arrives on `/webhook/whatsapp`, `whatsappEvents` emits, `.once()` resolves |
| AC-FR4-2 | Praneet can also approve a gate by replying "1" — first wins | Same `.once()` path; whichever participant's reply reaches the event emitter first resolves the Promise |
| AC-FR4-3 | The second reply is ignored | `whatsappEvents.once()` semantics: listener is removed after first emission; subsequent events have no listener |
| AC-FR5-1 | A setup with only `TWILIO_WHATSAPP_RECIPIENT` (no `OPERANT_WHATSAPP_PARTICIPANTS`) works as before | `getWhatsAppParticipants()` returns `[]`; `sendGroupNotification()` falls through to 1:1 `sendTwilioMessage()` path |
| AC-FR5-2 | A Conversations API failure does not block the pipeline | `sendGroupNotification()`: entire Conversations branch is wrapped in `try/catch`; error is logged and 1:1 path is used |

---

## 7. Testing Notes

The following test hooks are built into the implementation to enable unit testing without network calls or filesystem side effects.

### Dependency-injectable parameters

`callConversationsApi()`, `ensureConversation()`, and `sendConversationMessage()` all accept an optional final `httpClient` parameter (defaults to the real `https` module). Pass a stub object with a `request` method to intercept calls.

`ensureConversation()` additionally accepts `getSid` and `writeSid` callbacks (defaulting to `getConversationSid` and `writeConversationSid`). Tests can pass in-memory closures to avoid filesystem I/O.

### Environment variable isolation

`getWhatsAppParticipants()` reads `process.env.OPERANT_WHATSAPP_PARTICIPANTS`. Set this in the test's `beforeEach` / `afterEach` to control routing without filesystem access.

### Filesystem isolation

Tests that exercise `getConversationSid()` / `writeConversationSid()` directly should set `process.env.OPERANT_PI_DATA_DIR` to a temp directory created per test.

### Key test scenarios

| Scenario | What to verify |
|----------|---------------|
| `getWhatsAppParticipants()` with `"  +1234, +5678  "` | Returns `["+1234", "+5678"]` |
| `getWhatsAppParticipants()` with `""` | Returns `[]` |
| `getConversationSid()` when file absent | Returns `null`, does not throw |
| `writeConversationSid("CHabc")` | File contains `"CHabc\n"`, tmp file removed |
| `callConversationsApi()` POST encodes body as `application/x-www-form-urlencoded` | `Content-Type` header is set; body string equals `URLSearchParams({ ... }).toString()` |
| `callConversationsApi()` returns `{ status: 409, data: ... }` without throwing | Status 409 resolves, does not reject |
| `ensureConversation()` when GET returns 200 | No POST to `/v1/Conversations`; returns stored SID |
| `ensureConversation()` when GET returns 404 | POST to `/v1/Conversations` is issued; new SID written via `writeSid` |
| `ensureConversation()` when participant POST returns 409 | No throw; loop continues; warning logged |
| `sendGroupNotification()` when `ensureConversation()` throws | `sendTwilioMessage()` (1:1 fallback) is called; function resolves (no throw) |
| `sendGroupNotification()` when participants list is empty | `ensureConversation()` is never called; 1:1 path is used |
| `sendGate()` group branch registers reply listener before calling `ensureConversation()` | `whatsappEvents.once` is called before any `callConversationsApi` invocation |
