# Implementation Specification: WhatsApp Communication Channel

**Version:** 2.0 (Revised for Claude Code plugin architecture)  
**Date:** 2026-06-07  
**Based on:** HLD v2.0, ADR-Lite v1.0

---

## 1. Module Interfaces

### Module: `src/channel.ts` (IMPLEMENTED)

**Responsibility:** Define the `Channel` interface, implement `ChannelRouter` for complexity-based channel selection, timeout escalation, and gate lifecycle management.

```typescript
// ---------------------------------------------------------------------------
// Channel Interface
// ---------------------------------------------------------------------------

/** Result of a gate interaction, regardless of channel. */
export interface GateReply {
  /** Unique ID for this interaction (call_id or "wa-<timestamp>") */
  interactionId: string;
  /** Which channel delivered the reply */
  source: "voice" | "whatsapp";
  /** Parsed decision */
  decision: "approved" | "rejected";
  /** Raw text from the user (transcript for voice, message body for WhatsApp) */
  rawText: string;
  /** Structured feedback/revision notes (if any) */
  feedback?: string;
  /** Caller/sender name from whitelist */
  callerName: string;
  /** Phone number of the respondent */
  fromNumber: string;
}

/** Context passed to a channel for sending a gate message. */
export interface GateContext {
  mode: CallMode;               // "review" | "blocker" | "confirmation" | "demo_invite" | "requirements"
  specDir: string;              // absolute path to spec directory
  specName: string;             // human-readable spec name (basename of specDir)
  
  // Review-specific
  artifactType?: string;        // "intent" | "hld" | "adr" | "eis"
  artifactSummary?: string;     // 2-minute TL;DR
  artifactPath?: string;        // absolute path to the artifact markdown file
  
  // Blocker-specific
  blockerId?: string;
  blockerSummary?: string;
  blockerOptions?: string;
  
  // Confirmation-specific
  featureSummary?: string;
  testResults?: string;
  
  // Demo invite-specific
  meetUrl?: string;
  meetCode?: string;
}

/** A communication channel that can send gate messages and receive replies. */
export interface Channel {
  readonly name: "voice" | "whatsapp";
  
  /**
   * Send a gate message and return a promise that resolves when the user replies.
   * For voice: makes outbound call, resolves when call_completed webhook arrives.
   * For WhatsApp: sends message, resolves when inbound reply webhook arrives.
   */
  sendGate(context: GateContext): Promise<GateReply>;
}

// ---------------------------------------------------------------------------
// Complexity Classification
// ---------------------------------------------------------------------------

export type Complexity = "simple" | "complex";

/** Default complexity map. See ADR-002. */
const DEFAULT_COMPLEXITY: Record<CallMode, Complexity> = {
  confirmation: "simple",
  review: "simple",
  demo_invite: "simple",
  blocker: "complex",
  requirements: "complex",
};

/**
 * Classify gate complexity. Checks env overrides first (CHANNEL_OVERRIDE_<mode>=voice|whatsapp),
 * then falls back to DEFAULT_COMPLEXITY.
 */
export function classifyComplexity(mode: CallMode): Complexity {
  const override = process.env[`CHANNEL_OVERRIDE_${mode}`];
  if (override === "voice") return "complex";
  if (override === "whatsapp") return "simple";
  return DEFAULT_COMPLEXITY[mode] ?? "complex";
}

// ---------------------------------------------------------------------------
// Timeout Configuration
// ---------------------------------------------------------------------------

/** Default timeout per mode in milliseconds. See ADR-006. */
const DEFAULT_TIMEOUTS: Record<CallMode, number> = {
  confirmation: 5 * 60 * 1000,    // 5 minutes
  review: 10 * 60 * 1000,         // 10 minutes
  demo_invite: 10 * 60 * 1000,    // 10 minutes
  blocker: 10 * 60 * 1000,        // 10 minutes (unused — blocker goes to voice)
  requirements: 10 * 60 * 1000,   // 10 minutes (unused — requirements goes to voice)
};

export function getTimeout(mode: CallMode): number {
  const envKey = `CHANNEL_TIMEOUT_${mode}`;
  const envVal = process.env[envKey];
  if (envVal) return parseInt(envVal, 10) * 1000; // env is in seconds
  return DEFAULT_TIMEOUTS[mode] ?? 10 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// ChannelRouter
// ---------------------------------------------------------------------------

export interface ChannelRouterConfig {
  voiceChannel: Channel;
  whatsappChannel: Channel;
  /** Callback for logging */
  log: (msg: string) => void;
}

/**
 * Routes gate interactions to the appropriate channel based on complexity.
 * Manages timeout escalation from WhatsApp to voice. See ADR-001, ADR-006.
 *
 * Usage:
 *   const reply = await router.sendGate(context);
 *   // reply is a GateReply regardless of which channel handled it
 */
export class ChannelRouter {
  private voice: Channel;
  private whatsapp: Channel;
  private log: (msg: string) => void;
  private pendingTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(config: ChannelRouterConfig) {
    this.voice = config.voiceChannel;
    this.whatsapp = config.whatsappChannel;
    this.log = config.log;
  }

  async sendGate(context: GateContext): Promise<GateReply> {
    const complexity = classifyComplexity(context.mode);
    
    if (complexity === "complex") {
      this.log(`[channel] ${context.mode} -> voice (complex)`);
      return this.voice.sendGate(context);
    }
    
    // Simple -> try WhatsApp with timeout escalation
    this.log(`[channel] ${context.mode} -> whatsapp (simple, timeout ${getTimeout(context.mode) / 1000}s)`);
    
    const timeout = getTimeout(context.mode);
    
    return new Promise<GateReply>((resolve, reject) => {
      let resolved = false;
      
      // Start WhatsApp send
      const whatsappPromise = this.whatsapp.sendGate(context);
      
      // Start timeout
      this.pendingTimeout = setTimeout(async () => {
        if (resolved) return;
        this.log(`[channel] WhatsApp timeout for ${context.mode} — escalating to voice`);
        try {
          const voiceReply = await this.voice.sendGate(context);
          if (!resolved) {
            resolved = true;
            resolve(voiceReply);
          }
        } catch (err) {
          if (!resolved) {
            resolved = true;
            reject(err);
          }
        }
      }, timeout);
      
      // Wait for WhatsApp reply
      whatsappPromise.then((reply) => {
        if (!resolved) {
          resolved = true;
          if (this.pendingTimeout) clearTimeout(this.pendingTimeout);
          this.pendingTimeout = null;
          resolve(reply);
        }
      }).catch((err) => {
        // WhatsApp send failed — fall back to voice immediately
        if (!resolved) {
          this.log(`[channel] WhatsApp failed: ${(err as Error).message} — falling back to voice`);
          if (this.pendingTimeout) clearTimeout(this.pendingTimeout);
          this.pendingTimeout = null;
          this.voice.sendGate(context).then(resolve).catch(reject);
        }
      });
    });
  }

  /** Cancel any pending timeout (e.g., on shutdown). */
  cancel(): void {
    if (this.pendingTimeout) {
      clearTimeout(this.pendingTimeout);
      this.pendingTimeout = null;
    }
  }
}
```

**Dependencies:** `src/retell.ts` (RetellChannel), `src/whatsapp.ts` (WhatsAppChannel)

---

### Module: `src/whatsapp.ts` (IMPLEMENTED)

**Responsibility:** Implement the `Channel` interface for Twilio WhatsApp. Send outbound messages (text + media), wait for inbound reply via event listener.

```typescript
import https from "node:https";
import { EventEmitter } from "node:events";
import type { Channel, GateContext, GateReply } from "./channel.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface TwilioConfig {
  accountSid: string;
  authToken: string;
  whatsappNumber: string;   // "whatsapp:+1XXXXXXXXXX"
  recipientNumber: string;  // "whatsapp:+1YYYYYYYYYY" (from whitelist)
  sandbox: boolean;         // TWILIO_WHATSAPP_SANDBOX=1
}

function getConfig(): TwilioConfig {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const whatsappNumber = process.env.TWILIO_WHATSAPP_NUMBER;
  const recipientNumber = process.env.TWILIO_WHATSAPP_RECIPIENT;
  
  if (!accountSid || !authToken || !whatsappNumber || !recipientNumber) {
    throw new Error(
      "Missing Twilio config. Required env vars: TWILIO_ACCOUNT_SID, " +
      "TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_NUMBER, TWILIO_WHATSAPP_RECIPIENT"
    );
  }
  
  return {
    accountSid,
    authToken,
    whatsappNumber: whatsappNumber.startsWith("whatsapp:") ? whatsappNumber : `whatsapp:${whatsappNumber}`,
    recipientNumber: recipientNumber.startsWith("whatsapp:") ? recipientNumber : `whatsapp:${recipientNumber}`,
    sandbox: process.env.TWILIO_WHATSAPP_SANDBOX === "1",
  };
}

// ---------------------------------------------------------------------------
// Message Formatting (ADR-005)
// ---------------------------------------------------------------------------

/** Build the outbound WhatsApp message body for a gate. */
export function formatGateMessage(context: GateContext): string {
  switch (context.mode) {
    case "review":
      return [
        `*REVIEW: ${context.specName}*`,
        `Artifact: ${context.artifactType?.toUpperCase() || "unknown"}`,
        ``,
        context.artifactSummary || "(no summary)",
        ``,
        `---`,
        `Reply *1* to APPROVE`,
        `Reply *2* to REJECT (include feedback)`,
        `Or type your detailed feedback`,
      ].join("\n");

    case "confirmation":
      return [
        `*CONFIRMATION: ${context.specName}*`,
        ``,
        context.featureSummary || "Feature has been built and verified.",
        ``,
        `Test results: ${context.testResults || "All passed"}`,
        ``,
        `---`,
        `Reply *1* to APPROVE and ship`,
        `Reply *2* to REJECT (include what needs fixing)`,
      ].join("\n");

    case "demo_invite":
      return [
        `*DEMO READY: ${context.specName}*`,
        ``,
        context.featureSummary || "Your feature is ready for demo.",
        ``,
        `Join the live demo:`,
        context.meetUrl || "(no URL)",
        `Code: ${context.meetCode || "N/A"}`,
        ``,
        `Reply *1* to join now`,
        `Reply *2* to skip demo`,
      ].join("\n");

    default:
      return [
        `*${context.mode.toUpperCase()}: ${context.specName}*`,
        ``,
        context.artifactSummary || context.featureSummary || context.blockerSummary || "",
        ``,
        `Reply with your feedback.`,
      ].join("\n");
  }
}

// ---------------------------------------------------------------------------
// Reply Parsing (ADR-005)
// ---------------------------------------------------------------------------

export interface ParsedReply {
  decision: "approved" | "rejected";
  feedback?: string;
}

/**
 * Parse a WhatsApp reply text into a decision.
 * Order: exact match ("1"/"2") -> keyword match -> default to rejected-with-notes.
 */
export function parseReply(text: string): ParsedReply {
  const trimmed = text.trim();
  
  // Exact match
  if (trimmed === "1") return { decision: "approved" };
  if (trimmed === "2") return { decision: "rejected" };
  
  // Keyword match
  const lower = trimmed.toLowerCase();
  const approveKeywords = ["approve", "approved", "lgtm", "ship it", "yes", "looks good", "go ahead"];
  const rejectKeywords = ["reject", "rejected", "no", "changes needed", "fix", "redo"];
  
  for (const kw of approveKeywords) {
    if (lower.includes(kw)) return { decision: "approved" };
  }
  for (const kw of rejectKeywords) {
    if (lower.includes(kw)) return { decision: "rejected", feedback: trimmed };
  }
  
  // Default: treat as rejection with feedback (conservative — see ADR-005)
  return { decision: "rejected", feedback: trimmed };
}

// ---------------------------------------------------------------------------
// Twilio HTTP Client
// ---------------------------------------------------------------------------

/** Send a WhatsApp message via Twilio REST API. */
function sendTwilioMessage(
  config: TwilioConfig,
  body: string,
  mediaUrl?: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams();
    params.append("From", config.whatsappNumber);
    params.append("To", config.recipientNumber);
    params.append("Body", body);
    if (mediaUrl) params.append("MediaUrl", mediaUrl);
    
    const payload = params.toString();
    const auth = Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64");
    
    const options: https.RequestOptions = {
      hostname: "api.twilio.com",
      port: 443,
      path: `/2010-04-01/Accounts/${config.accountSid}/Messages.json`,
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": String(Buffer.byteLength(payload)),
      },
    };
    
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Twilio API error ${res.statusCode}: ${data}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch { resolve({ raw: data }); }
      });
    });
    req.on("error", (err) => reject(new Error(`Twilio request failed: ${err.message}`)));
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// WhatsAppChannel (implements Channel)
// ---------------------------------------------------------------------------

/**
 * Event bus for WhatsApp inbound messages.
 * scripts/server.ts emits "whatsapp:reply" when a Twilio webhook arrives.
 * WhatsAppChannel listens for it to resolve the pending gate promise.
 */
export const whatsappEvents = new EventEmitter();

export class WhatsAppChannel implements Channel {
  readonly name = "whatsapp" as const;
  private log: (msg: string) => void;
  private tunnelUrl: string | null;

  constructor(log: (msg: string) => void, tunnelUrl: string | null) {
    this.log = log;
    this.tunnelUrl = tunnelUrl;
  }

  /** Update tunnel URL (changes on restart). */
  setTunnelUrl(url: string): void {
    this.tunnelUrl = url;
  }

  async sendGate(context: GateContext): Promise<GateReply> {
    const config = getConfig();
    const body = formatGateMessage(context);
    
    // Build media URL for review artifacts (ADR-004)
    let mediaUrl: string | undefined;
    if (context.artifactPath && this.tunnelUrl && context.mode === "review") {
      const filename = context.artifactType ? `${context.artifactType}.pdf` : "artifact.pdf";
      mediaUrl = `${this.tunnelUrl}/media/${context.specName}/${filename}`;
    }
    
    this.log(`[whatsapp] Sending ${context.mode} gate to ${config.recipientNumber}`);
    await sendTwilioMessage(config, body, mediaUrl);
    
    // Wait for inbound reply via event bus
    return new Promise<GateReply>((resolve) => {
      const handler = (reply: { fromNumber: string; body: string; callerName: string; interactionId: string }) => {
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
  }
}
```

**Dependencies:** Node.js `https`, `events`; env vars for Twilio config

---

### Module: `src/retell.ts` (MODIFIED — add Channel interface)

**Responsibility:** Wrap existing Retell logic in the `Channel` interface. Existing public API unchanged.

```typescript
// ADD to existing retell.ts (do not remove existing exports):

import type { Channel, GateContext, GateReply } from "./channel.js";
import { EventEmitter } from "node:events";

/**
 * Event bus for voice call completions.
 * Hook handler emits "voice:reply" when a call_completed notification arrives
 * during a pending voice gate.
 */
export const voiceEvents = new EventEmitter();

export class RetellChannel implements Channel {
  readonly name = "voice" as const;
  private log: (msg: string) => void;

  constructor(log: (msg: string) => void) {
    this.log = log;
  }

  async sendGate(context: GateContext): Promise<GateReply> {
    // ... builds dynamic vars, makes outbound call via Retell API
    // Waits for voice:reply event from the hook handler
    return new Promise<GateReply>((resolve) => {
      voiceEvents.once("voice:reply", (reply: GateReply) => {
        resolve(reply);
      });
    });
  }
}
```

**Dependencies:** Existing `retell.ts` functions (no removal), `channel.ts` types

---

## 2. API Contracts

### Endpoint: POST /webhook/whatsapp

**Description:** Receives Twilio WhatsApp callbacks (inbound messages and delivery status updates). See ADR-008. Implemented in `scripts/server.ts`.

**Authentication:** Twilio request signature validation (`X-Twilio-Signature` header)

**Inbound Message Request (from Twilio):**
```
Content-Type: application/x-www-form-urlencoded

SmsMessageSid=SMXXXXXXXX
NumMedia=0
SmsSid=SMXXXXXXXX
SmsStatus=received
Body=1
To=whatsapp:+1XXXXXXXXXX
NumSegments=1
MessageSid=SMXXXXXXXX
AccountSid=ACXXXXXXXX
From=whatsapp:+1YYYYYYYYYY
ApiVersion=2010-04-01
```

**Response (200 OK):**
```xml
<Response></Response>
```
Empty TwiML response (no auto-reply needed — reply handled by channel layer if needed).

**Status Callback Request (from Twilio):**
```
Content-Type: application/x-www-form-urlencoded

MessageSid=SMXXXXXXXX
MessageStatus=delivered|read|failed
To=whatsapp:+1XXXXXXXXXX
From=whatsapp:+1YYYYYYYYYY
AccountSid=ACXXXXXXXX
```

**Response (200 OK):**
```xml
<Response></Response>
```

**Error Responses:**

| Status | Description | When |
|--------|-------------|------|
| 400 | Invalid request | Missing required fields |
| 403 | Forbidden | Invalid Twilio signature or sender not whitelisted |

---

### Endpoint: GET /media/:spec/:filename

**Description:** Serves generated PDF artifacts for WhatsApp media attachments. See ADR-004. Implemented in `scripts/server.ts`.

**Authentication:** None (publicly accessible via tunnel — ephemeral URLs)

**Response (200 OK):**
```
Content-Type: application/pdf
Content-Disposition: inline; filename="high-level-design.pdf"

<binary PDF data>
```

**Error Responses:**

| Status | Description | When |
|--------|-------------|------|
| 404 | Not found | PDF not generated or spec doesn't exist |

---

## 3. Persistence

### File Layout (additions to existing structure)

```
data/
├── calls/                    # existing: Retell call records
├── pending/                  # existing: trigger files (voice + WhatsApp)
│   ├── <ts>-<call_id>.json   # existing: voice trigger
│   └── <ts>-wa-<msgid>.json  # WhatsApp trigger
├── processed/                # existing
├── media/                    # generated PDFs for WhatsApp
│   └── <spec-name>/
│       ├── intent.pdf
│       ├── hld.pdf
│       ├── adr.pdf
│       └── eis.pdf
└── whitelist.json            # existing (unchanged)
```

### WhatsApp Trigger File Format

```json
{
  "call_id": "wa-1749292800000",
  "caller_name": "Pranav Dhoolia",
  "from_number": "+1YYYYYYYYYY",
  "source": "whatsapp",
  "message_sid": "SMXXXXXXXX",
  "spec": {
    "decision": "approved",
    "raw_text": "1",
    "feedback": null
  },
  "created_at": "2026-06-07T12:00:00.000Z"
}
```

Note: The `source` field distinguishes WhatsApp triggers from voice triggers. The FSM handler does NOT branch on this field — it processes both identically (NFC-2).

---

## 4. Implementation Changes by File

### 4.1 `src/channel.ts` (IMPLEMENTED)

Exports:
- `Channel` interface
- `GateReply`, `GateContext` types
- `ChannelRouter` class
- `classifyComplexity()`, `getTimeout()` functions

### 4.2 `src/whatsapp.ts` (IMPLEMENTED)

Exports:
- `WhatsAppChannel` class
- `whatsappEvents` EventEmitter
- `parseReply()` function
- `formatGateMessage()` function (for testing)

### 4.3 `src/retell.ts` (MODIFIED)

Added:
- `RetellChannel` class implementing `Channel`
- `voiceEvents` EventEmitter
- Kept all existing exports (`makeOutboundCall`, `buildDynamicVars`, `getAgentId`, etc.)

### 4.4 `scripts/server.ts` (MODIFIED)

Added two route handlers:

- `POST /webhook/whatsapp` — Receives Twilio WhatsApp callbacks, validates signatures, writes trigger files to `pending/`, notifies Claude Code hook handler
- `GET /media/:spec/:filename` — Serves generated PDF artifacts for WhatsApp media attachments

The server communicates via filesystem (trigger files + `latest-trigger.txt`) instead of IPC, consistent with the Claude Code plugin model.

### 4.5 Hook-Driven Side-Effect Routing (via `hooks/hooks.json`)

In the Claude Code plugin model, side-effect execution is orchestrated through hooks registered in `hooks/hooks.json`:

- **`PostToolUse` (Write|Edit)** — `scripts/detect-artifact.sh` detects when artifacts are written and can trigger the channel router
- **`PostToolUse` (Bash)** — `scripts/check-blockers.sh` detects blocker conditions
- **`Stop`** — `scripts/validate-state.sh` validates pipeline state on session end

The hook scripts invoke TypeScript modules (`src/channel.ts`, `src/whatsapp.ts`, `src/retell.ts`) as needed. The `TRIGGER_*_CALL` side effects are routed through `ChannelRouter.sendGate()` instead of calling Retell directly.

### 4.6 `src/pdf.ts` (IMPLEMENTED)

Converts markdown artifacts to PDF for WhatsApp attachments via `md-to-pdf`.

Exports:
- `markdownToPdf(markdownPath, outputDir, outputFilename)` — core conversion
- `generateArtifactPdf(artifactPath, specName, artifactType, dataDir, tunnelUrl)` — generates PDF and returns the media URL

### 4.7 `package.json` (MODIFIED)

Dependencies:
```json
{
  "dependencies": {
    "md-to-pdf": "^5.2.0",
    "twilio": "^5.0.0"
  }
}
```

Note: `twilio` package is used only for `validateRequest` webhook signature validation. The HTTP client uses raw `https` (consistent with `src/retell.ts`).

---

## 5. Environment Variables (New)

| Variable | Required | Example | Description |
|----------|----------|---------|-------------|
| `TWILIO_ACCOUNT_SID` | Yes | `ACXXXXXXXX` | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Yes | `xxxxxxxx` | Twilio auth token |
| `TWILIO_WHATSAPP_NUMBER` | Yes | `whatsapp:+14155238886` | Twilio WhatsApp sender number |
| `TWILIO_WHATSAPP_RECIPIENT` | Yes | `whatsapp:+1YYYYYYYYYY` | Default recipient (user's WhatsApp) |
| `TWILIO_WHATSAPP_SANDBOX` | No | `1` | Use sandbox mode (no templates needed) |
| `CHANNEL_OVERRIDE_<mode>` | No | `voice` or `whatsapp` | Force a specific channel for a gate mode |
| `CHANNEL_TIMEOUT_<mode>` | No | `300` (seconds) | Override default timeout for a gate mode |

---

## 6. Traceability Matrix

| Requirement | HLD Section | ADR | EIS Section | Test Category |
|-------------|-------------|-----|-------------|---------------|
| FR-1: Channel Interface | 3 | ADR-001 | 1 (channel.ts) | unit: interface conformance |
| FR-2: Twilio WhatsApp Provider | 3, 5 | ADR-003, ADR-007 | 1 (whatsapp.ts) | unit: message send, integration: Twilio sandbox |
| FR-3: Complexity Selection | 4 | ADR-002 | 1 (channel.ts classifyComplexity) | unit: classification rules |
| FR-4: WhatsApp Reply Handling | 4 | ADR-005, ADR-008 | 2 (POST /webhook/whatsapp) | unit: parsing, integration: webhook |
| FR-5: Timeout Escalation | 4 | ADR-006 | 1 (ChannelRouter.sendGate) | unit: timer mock, integration: escalation flow |
| FR-6: Rich Content | 4 | ADR-004 | 4.6 (pdf.ts), 2 (GET /media) | unit: PDF generation, integration: media serve |
| NFC-1: Preserve Voice | 6 | ADR-001 | 4.3 (retell.ts modification) | regression: existing test suite |
| NFC-2: Notification Consistency | 6 | -- | 4.4 (server.ts trigger files) | unit: trigger file format |
| NFC-4: No FSM Changes | 6 | ADR-001 | 4.5 (hook-driven routing) | regression: FSM tests pass |
| NFC-6: Security | 5, 8 | -- | 2 (webhook validation) | unit: signature validation |
