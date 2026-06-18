/**
 * @module whatsapp
 *
 * Twilio WhatsApp channel implementation.
 * Sends outbound WhatsApp messages and waits for inbound replies.
 *
 * ADR-003: Twilio sandbox for dev
 * ADR-005: Structured reply options
 * ADR-007: Separate WhatsApp number
 */

import https from "node:https";
import { EventEmitter } from "node:events";
import type { Channel, GateContext, GateReply } from "./channel.js";
import {
  getMode,
  getOperantApiKey,
  getOperantApiUrl,
  getWhatsAppParticipants,
  getConversationSid,
  writeConversationSid,
} from './config.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface TwilioConfig {
  accountSid: string;
  authToken: string;
  whatsappNumber: string;
  recipientNumber: string;
  sandbox: boolean;
}

function getConfig(): TwilioConfig {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const whatsappNumber = process.env.TWILIO_WHATSAPP_NUMBER;
  const recipientNumber = process.env.TWILIO_WHATSAPP_RECIPIENT;

  if (!accountSid || !authToken || !whatsappNumber || !recipientNumber) {
    throw new Error(
      "Missing Twilio config. Required: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, " +
      "TWILIO_WHATSAPP_NUMBER, TWILIO_WHATSAPP_RECIPIENT"
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

export function parseReply(text: string): ParsedReply {
  const trimmed = text.trim();

  if (trimmed === "1") return { decision: "approved" };
  if (trimmed === "2") return { decision: "rejected" };

  const lower = trimmed.toLowerCase();
  const approveKeywords = ["approve", "approved", "lgtm", "ship it", "yes", "looks good", "go ahead"];
  const rejectKeywords = ["reject", "rejected", "no", "changes needed", "fix", "redo"];

  for (const kw of approveKeywords) {
    if (lower.includes(kw)) return { decision: "approved" };
  }
  for (const kw of rejectKeywords) {
    if (lower.includes(kw)) return { decision: "rejected", feedback: trimmed };
  }

  // Conservative default: unknown text = rejected with feedback (ADR-005)
  return { decision: "rejected", feedback: trimmed };
}

// ---------------------------------------------------------------------------
// Twilio HTTP Client
// ---------------------------------------------------------------------------

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
        Authorization: `Basic ${auth}`,
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
// Event Bus
// ---------------------------------------------------------------------------

/**
 * Event bus for WhatsApp inbound replies.
 * server.ts emits "whatsapp:reply" when a Twilio webhook arrives.
 */
export const whatsappEvents = new EventEmitter();

// ---------------------------------------------------------------------------
// Cloud Mode Helper
// ---------------------------------------------------------------------------

function cloudSendWhatsApp(to: string, body: string): Promise<Record<string, unknown>> {
  const apiUrl = getOperantApiUrl();
  const apiKey = getOperantApiKey();
  const payload = JSON.stringify({ to, body });

  return new Promise((resolve, reject) => {
    const url = new URL(`${apiUrl}/api/whatsapp/send`);
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port ? Number(url.port) : 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(payload)),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`Operant API error ${res.statusCode}: ${data}`));
            return;
          }
          try { resolve(JSON.parse(data)); }
          catch { resolve({ raw: data }); }
        });
      }
    );
    req.on('error', (err) => reject(new Error(`Operant API request failed: ${err.message}`)));
    req.write(payload);
    req.end();
  });
}

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

// ---------------------------------------------------------------------------
// WhatsAppChannel
// ---------------------------------------------------------------------------

export class WhatsAppChannel implements Channel {
  readonly name = "whatsapp" as const;
  private log: (msg: string) => void;
  private tunnelUrl: string | null;

  constructor(log: (msg: string) => void, tunnelUrl: string | null) {
    this.log = log;
    this.tunnelUrl = tunnelUrl;
  }

  setTunnelUrl(url: string): void {
    this.tunnelUrl = url;
  }

  async sendGate(context: GateContext): Promise<GateReply> {
    const body = formatGateMessage(context);

    // Cloud mode: proxy through operant-api
    if (getMode() === 'cloud') {
      const recipient = process.env.TWILIO_WHATSAPP_RECIPIENT ?? '';
      const to = recipient.replace('whatsapp:', '');
      this.log(`[whatsapp] Sending ${context.mode} gate via cloud proxy`);
      await cloudSendWhatsApp(to, body);
      // Wait for inbound reply via event bus (same as local mode)
      return new Promise<GateReply>((resolve) => {
        const handler = (reply: {
          fromNumber: string;
          body: string;
          callerName: string;
          interactionId: string;
        }) => {
          const parsed = parseReply(reply.body);
          resolve({
            interactionId: reply.interactionId,
            source: 'whatsapp',
            decision: parsed.decision,
            rawText: reply.body,
            feedback: parsed.feedback,
            callerName: reply.callerName,
            fromNumber: reply.fromNumber,
          });
        };
        whatsappEvents.once('whatsapp:reply', handler);
      });
    }

    // Local mode: existing code

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

    const config = getConfig();

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
  }
}
