// Standalone webhook HTTP server for the operant Claude Code plugin.
// Communicates via filesystem (trigger files + latest-trigger.txt) instead of IPC.
// Run: node scripts/server.js

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Paths (ADR-003: project-scoped via env var)
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR =
  process.env.OPERANT_PI_DATA_DIR || join(process.cwd(), "spec", ".operant");
const CALLS_DIR = join(DATA_DIR, "calls");
const PENDING_DIR = join(DATA_DIR, "pending");
const WHITELIST_PATH = join(DATA_DIR, "whitelist.json");
const MEDIA_DIR = join(DATA_DIR, "media");
const PID_FILE = join(DATA_DIR, "server.pid");
const LATEST_TRIGGER = join(DATA_DIR, "latest-trigger.txt");
const STATE_FILE = join(DATA_DIR, "current-state.txt");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Caller {
  phone: string;
  name: string;
  role: string;
  added: string;
  note?: string;
}

interface Whitelist {
  callers: Caller[];
  default_blocker_target: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.SECONDAXIS_PORT || "3456", 10);
const startTime = Date.now();

function log(msg: string): void {
  const ts = new Date().toISOString();
  process.stdout.write(`[${ts}] ${msg}\n`);
}

function ensureDirs(): void {
  for (const dir of [CALLS_DIR, PENDING_DIR, MEDIA_DIR]) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadWhitelist(): Whitelist {
  try {
    return JSON.parse(readFileSync(WHITELIST_PATH, "utf-8"));
  } catch (err) {
    log(`WARNING: could not read whitelist -- ${(err as Error).message}`);
    return { callers: [], default_blocker_target: "" };
  }
}

function findCaller(phone: string): Caller | null {
  const wl = loadWhitelist();
  return wl.callers.find((c) => c.phone === phone) || null;
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function json(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

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

// ---------------------------------------------------------------------------
// Filesystem notification (replaces IPC)
// ---------------------------------------------------------------------------

function notifyTrigger(triggerFile: string): void {
  writeFileSync(LATEST_TRIGGER, triggerFile, "utf-8");
  log(`Wrote latest-trigger.txt: ${triggerFile}`);
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleCallCompleted(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readBody(req);
  } catch {
    json(res, 400, { error: "Invalid JSON" });
    return;
  }

  log(`Webhook payload keys: ${Object.keys(body).join(", ")}`);
  log(`Webhook event type: ${(body.event as string) || "none"}`);

  // Silently accept call_started events -- nothing to process yet
  if (body.event === "call_started") {
    json(res, 200, { ok: true, ignored: "call_started" });
    return;
  }

  // Retell sends webhooks with an "event" wrapper -- extract the call data
  const callData =
    body.event === "call_ended" || body.event === "call_analyzed"
      ? ((body.call || body.data || body) as Record<string, unknown>)
      : body;

  const call_id = callData.call_id as string | undefined;
  const transcript = callData.transcript as string | undefined;
  const call_analysis = callData.call_analysis as
    | Record<string, unknown>
    | undefined;
  const from_number = callData.from_number as string | undefined;
  const to_number = callData.to_number as string | undefined;
  const duration_ms = callData.duration_ms as number | undefined;
  const end_timestamp = callData.end_timestamp as string | undefined;

  log(`Extracted call_id=${call_id}, from=${from_number}, event=${body.event}`);

  if (!call_id) {
    log(
      `REJECTED: no call_id in payload. Full body: ${JSON.stringify(body).slice(0, 500)}`,
    );
    json(res, 400, { error: "Missing call_id" });
    return;
  }

  // Look up caller name from whitelist if available, otherwise use phone number
  const caller = findCaller(from_number || "");
  const callerName = caller?.name || from_number || "Unknown";

  log(`ACCEPTED call ${call_id} from ${callerName} (${from_number})`);

  // Write raw transcript to calls/
  const callRecord = {
    call_id,
    from_number,
    to_number,
    caller_name: callerName,
    duration_ms,
    end_timestamp,
    transcript,
    call_analysis,
    received_at: new Date().toISOString(),
  };

  const callPath = join(CALLS_DIR, `${call_id}.json`);
  writeFileSync(callPath, JSON.stringify(callRecord, null, 2));
  log(`Wrote call record to ${callPath}`);

  // Extract spec content from call_analysis or fall back to transcript
  const specContent = call_analysis || { raw_transcript: transcript };

  // Write trigger file
  const ts = Date.now();
  const triggerFile = `${ts}-${call_id}.json`;
  const triggerPath = join(PENDING_DIR, triggerFile);
  const triggerData = {
    call_id,
    caller_name: callerName,
    from_number,
    to_number,
    duration_ms,
    end_timestamp,
    spec: specContent,
    created_at: new Date().toISOString(),
  };

  writeFileSync(triggerPath, JSON.stringify(triggerData, null, 2));
  log(`Wrote trigger file to ${triggerPath}`);

  // Notify via filesystem (replaces IPC)
  if (body.event !== "call_started") {
    notifyTrigger(triggerFile);
  }

  json(res, 200, { ok: true, call_id, trigger: triggerFile });
}

async function handleCallerCheck(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readBody(req);
  } catch {
    json(res, 400, { error: "Invalid JSON" });
    return;
  }

  const from_number = body.from_number as string | undefined;
  if (!from_number) {
    json(res, 400, { error: "Missing from_number" });
    return;
  }

  // All callers allowed -- look up name from whitelist if available
  const callerCheck = findCaller(from_number);
  const callerName = callerCheck?.name || from_number;

  log(`Caller check: ${from_number} -> ALLOWED (${callerName})`);
  json(res, 200, { allowed: true, caller_name: callerName });
}

async function handleWhatsAppWebhook(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: Record<string, string>;
  try {
    const raw = await readRawBody(req);
    body = Object.fromEntries(new URLSearchParams(raw));
  } catch {
    json(res, 400, { error: "Invalid request body" });
    return;
  }

  // Status callback — log and acknowledge
  if (body.MessageStatus) {
    log(`WhatsApp status: ${body.MessageSid} -> ${body.MessageStatus}`);
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end("<Response></Response>");
    return;
  }

  // Inbound message
  const fromNumber = (body.From || "").replace("whatsapp:", "");
  const messageBody = body.Body || "";
  const messageSid = body.MessageSid || `wa-${Date.now()}`;

  // Whitelist check
  const caller = findCaller(fromNumber);
  if (!caller) {
    log(`WhatsApp REJECTED: ${fromNumber} not in whitelist`);
    // Still accept — don't want Twilio retrying
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end("<Response></Response>");
    return;
  }

  log(`WhatsApp received from ${caller.name} (${fromNumber}): ${messageBody.slice(0, 100)}`);

  // Write trigger file (same pattern as voice — NFC-2)
  const ts = Date.now();
  const triggerFile = `${ts}-wa-${messageSid}.json`;
  const triggerPath = join(PENDING_DIR, triggerFile);
  const triggerData = {
    call_id: `wa-${ts}`,
    caller_name: caller.name,
    from_number: fromNumber,
    source: "whatsapp",
    message_sid: messageSid,
    spec: {
      raw_text: messageBody,
    },
    created_at: new Date().toISOString(),
  };

  writeFileSync(triggerPath, JSON.stringify(triggerData, null, 2));
  log(`Wrote WhatsApp trigger file to ${triggerPath}`);

  // Notify via filesystem (replaces IPC)
  notifyTrigger(triggerFile);

  res.writeHead(200, { "Content-Type": "text/xml" });
  res.end("<Response></Response>");
}

async function handleGitHubWebhook(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const rawBody = await readRawBody(req);

  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    log(`[webhook/github] ERROR: GITHUB_WEBHOOK_SECRET not configured`);
    json(res, 500, { error: "Webhook secret not configured" });
    return;
  }

  const signature = req.headers["x-hub-signature-256"] as string | undefined;
  if (!signature) {
    log(`[webhook/github] REJECTED: missing x-hub-signature-256 header`);
    json(res, 401, { error: "Missing signature" });
    return;
  }

  if (!verifyGitHubSignature(rawBody, signature, secret)) {
    log(`[webhook/github] REJECTED: invalid signature`);
    json(res, 401, { error: "Invalid signature" });
    return;
  }

  const event = req.headers["x-github-event"] as string | undefined;
  if (event !== "issues") {
    log(`[webhook/github] ignored event: ${event}`);
    json(res, 200, { ignored: true });
    return;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    json(res, 400, { error: "Invalid JSON body" });
    return;
  }

  if (payload.action !== "opened") {
    log(`[webhook/github] ignored action: ${payload.action}`);
    json(res, 200, { ignored: true });
    return;
  }

  const issue = payload.issue as Record<string, unknown>;
  const number = issue.number as number;
  const title = issue.title as string;
  const body = (issue.body ?? "") as string;
  const author = (issue.user as Record<string, unknown>).login as string;
  const url = issue.html_url as string;
  const labels = (issue.labels as Array<Record<string, unknown>>).map(
    (l) => l.name as string,
  );
  const created_at = issue.created_at as string;

  log(`[webhook/github] received issue #${number}: ${title}`);

  const triggerFile = `github-${number}-${Date.now()}.json`;
  const triggerPath = join(PENDING_DIR, triggerFile);
  const triggerData = {
    source: "github",
    github_issue: { number, title, body, author, url, labels, created_at },
    created_at: new Date().toISOString(),
  };

  writeFileSync(triggerPath, JSON.stringify(triggerData, null, 2));
  log(`[webhook/github] wrote trigger file to ${triggerPath}`);

  notifyTrigger(triggerFile);

  json(res, 200, { processed: true, issue: number });
}

function handleMediaServe(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const urlParts = (req.url || "").split("/").filter(Boolean);
  // urlParts = ["media", "<spec-name>", "<filename>.pdf"]

  if (urlParts.length < 3) {
    json(res, 404, { error: "Not found" });
    return;
  }

  const specName = decodeURIComponent(urlParts[1]);
  const filename = decodeURIComponent(urlParts[2]);
  const mediaPath = join(MEDIA_DIR, specName, filename);

  if (!existsSync(mediaPath)) {
    json(res, 404, { error: "Media not found" });
    return;
  }

  const content = readFileSync(mediaPath);
  res.writeHead(200, {
    "Content-Type": "application/pdf",
    "Content-Length": content.length,
    "Content-Disposition": `inline; filename="${filename}"`,
  });
  res.end(content);
}

function handleHealth(_req: IncomingMessage, res: ServerResponse): void {
  json(res, 200, {
    status: "ok",
    uptime: Math.floor((Date.now() - startTime) / 1000),
  });
}

function handleState(_req: IncomingMessage, res: ServerResponse): void {
  let state = "unknown";
  try {
    if (existsSync(STATE_FILE)) {
      state = readFileSync(STATE_FILE, "utf-8").trim();
    }
  } catch (err) {
    log(`WARNING: could not read state file -- ${(err as Error).message}`);
  }

  json(res, 200, { state });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  const { method, url } = req;
  log(`${method} ${url}`);

  try {
    if (method === "POST" && url === "/webhook/call-completed") {
      await handleCallCompleted(req, res);
      return;
    }
    if (method === "POST" && url === "/webhook/caller-check") {
      await handleCallerCheck(req, res);
      return;
    }
    if (method === "POST" && url === "/webhook/whatsapp") {
      await handleWhatsAppWebhook(req, res);
      return;
    }
    if (method === "POST" && url === "/webhook/github") {
      await handleGitHubWebhook(req, res);
      return;
    }
    if (method === "GET" && url === "/health") {
      handleHealth(req, res);
      return;
    }
    if (method === "GET" && url === "/state") {
      handleState(req, res);
      return;
    }
    if (method === "GET" && url?.startsWith("/media/")) {
      handleMediaServe(req, res);
      return;
    }

    json(res, 404, { error: "Not found" });
  } catch (err) {
    log(`ERROR: ${(err as Error).message}`);
    json(res, 500, { error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function removePidFile(): void {
  try {
    if (existsSync(PID_FILE)) {
      const storedPid = readFileSync(PID_FILE, "utf-8").trim();
      if (storedPid === String(process.pid)) {
        unlinkSync(PID_FILE);
      }
    }
  } catch {
    /* best effort */
  }
}

function shutdown(signal: string): void {
  log(`Received ${signal}, shutting down...`);
  removePidFile();
  server.close(() => {
    log("Server closed");
    process.exit(0);
  });
  setTimeout(() => {
    process.exit(1);
  }, 5000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

ensureDirs();

// Write PID file so hook scripts can manage the process lifecycle
writeFileSync(PID_FILE, String(process.pid), "utf-8");

server.listen(PORT, () => {
  log(`SecondAxis webhook server listening on port ${PORT}`);
  log(`  PID: ${process.pid}`);
  log(`  DATA_DIR: ${DATA_DIR}`);
  log(`  POST /webhook/call-completed`);
  log(`  POST /webhook/caller-check`);
  log(`  POST /webhook/whatsapp`);
  log(`  POST /webhook/github`);
  log(`  GET  /health`);
  log(`  GET  /state`);
  log(`  GET  /media/:spec/:file`);
});
