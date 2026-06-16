#!/usr/bin/env node
/**
 * @module cli/trigger-gate
 *
 * Usage: node lib/cli/trigger-gate.js <mode> [artifactType] [specDir]
 *
 * Triggers an outbound call or WhatsApp message for a human gate
 * (review, blocker, confirmation). Blocks until a reply arrives
 * via filesystem polling, then runs the appropriate FSM transition.
 *
 * Cross-process communication: The webhook server writes reply trigger
 * files to $DATA_DIR/pending/. This script polls that directory for
 * new files, parses the reply, and transitions the FSM.
 *
 * Exit 0 on success, 1 on error, 2 on usage error.
 */

import { existsSync, readFileSync, readdirSync, renameSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";

import {
  transition,
  InvalidTransitionError,
  type TransitionResult,
} from "../state-machine.js";

import {
  getDataDir,
  getSpecsRoot,
  readState,
  writeState,
  readActiveSpec,
  ensureDataDir,
} from "../config.js";

import {
  classifyComplexity,
  getTimeout,
  type GateContext,
  type GateReply,
} from "../channel.js";

import type { CallMode } from "../retell.js";
import { buildDynamicVars, makeOutboundCall, getAgentId, getPhoneNumber } from "../retell.js";
import { formatGateMessage, parseReply } from "../whatsapp.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type GateMode = "review" | "blocker" | "confirmation";

interface GateResult {
  mode: GateMode;
  channel: "voice" | "whatsapp";
  reply: GateReply | null;
  transitions: TransitionResult[];
  timedOut: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runTransition(
  event: string,
  context: Record<string, string>,
): TransitionResult {
  const currentState = readState();
  const result = transition(currentState, event as import("../state-machine.js").FSMEvent, context);
  writeState(result.to);
  return result;
}

function safeReadFile(filePath: string): string {
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

function loadWhitelistTarget(dataDir: string): string {
  const whitelistPath = join(dataDir, "whitelist.json");
  try {
    const wl = JSON.parse(readFileSync(whitelistPath, "utf-8"));
    return wl.default_blocker_target ?? "";
  } catch {
    return "";
  }
}

/**
 * Send a WhatsApp message via Twilio.
 * Uses the Twilio REST API directly (same as whatsapp.ts).
 */
async function sendWhatsAppMessage(body: string): Promise<void> {
  const https = await import("node:https");

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const whatsappNumber = process.env.TWILIO_WHATSAPP_NUMBER;
  const recipientNumber = process.env.TWILIO_WHATSAPP_RECIPIENT;

  if (!accountSid || !authToken || !whatsappNumber || !recipientNumber) {
    throw new Error(
      "Missing Twilio config. Required: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, " +
      "TWILIO_WHATSAPP_NUMBER, TWILIO_WHATSAPP_RECIPIENT",
    );
  }

  const from = whatsappNumber.startsWith("whatsapp:") ? whatsappNumber : `whatsapp:${whatsappNumber}`;
  const to = recipientNumber.startsWith("whatsapp:") ? recipientNumber : `whatsapp:${recipientNumber}`;

  const params = new URLSearchParams();
  params.append("From", from);
  params.append("To", to);
  params.append("Body", body);

  const payload = params.toString();
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

  return new Promise((resolve, reject) => {
    const req = https.default.request(
      {
        hostname: "api.twilio.com",
        port: 443,
        path: `/2010-04-01/Accounts/${accountSid}/Messages.json`,
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": String(Buffer.byteLength(payload)),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk; });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`Twilio API error ${res.statusCode}: ${data}`));
            return;
          }
          resolve();
        });
      },
    );
    req.on("error", (err) => reject(new Error(`Twilio request failed: ${err.message}`)));
    req.write(payload);
    req.end();
  });
}

/**
 * Send a voice call via Retell.
 */
async function sendVoiceCall(context: GateContext): Promise<void> {
  const dynVars = buildDynamicVars(context.mode, {
    artifact_type: context.artifactType ?? "",
    artifact_summary: context.artifactSummary ?? "",
    spec_name: context.specName,
    blocker_id: context.blockerId ?? "",
    blocker_feature: context.specName,
    blocker_summary: context.blockerSummary ?? "",
    blocker_options: context.blockerOptions ?? "",
    feature_summary: context.featureSummary ?? "",
    test_results: context.testResults ?? "",
  });

  const agentId = getAgentId();
  const fromNumber = getPhoneNumber();
  const dataDir = getDataDir();
  const toNumber = loadWhitelistTarget(dataDir);

  if (!toNumber) {
    throw new Error("No default_blocker_target in whitelist.json");
  }

  await makeOutboundCall(fromNumber, toNumber, agentId, {
    spec_name: context.specName,
  }, dynVars);
}

/**
 * Poll $DATA_DIR/pending/ for new trigger files.
 * Returns the first new trigger file contents as a parsed reply,
 * or null on timeout.
 */
async function pollForReply(
  mode: GateMode,
  timeoutMs: number,
): Promise<GateReply | null> {
  const dataDir = getDataDir();
  const pendingDir = join(dataDir, "pending");
  mkdirSync(pendingDir, { recursive: true });

  // Snapshot existing files so we only react to NEW ones
  const knownFiles = new Set<string>();
  try {
    for (const f of readdirSync(pendingDir)) {
      knownFiles.add(f);
    }
  } catch { /* empty dir */ }

  const pollInterval = 3000; // 3 seconds
  const startTime = Date.now();

  return new Promise<GateReply | null>((resolve) => {
    const timer = setInterval(() => {
      // Check timeout
      if (Date.now() - startTime > timeoutMs) {
        clearInterval(timer);
        resolve(null);
        return;
      }

      // Scan for new files
      let files: string[];
      try {
        files = readdirSync(pendingDir).filter((f) => f.endsWith(".json"));
      } catch {
        return; // dir gone, keep polling
      }

      for (const file of files) {
        if (knownFiles.has(file)) continue;

        // New file found — read and parse it
        const filePath = join(pendingDir, file);
        let content: string;
        try {
          content = readFileSync(filePath, "utf-8");
        } catch {
          continue; // file may be partially written
        }

        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(content);
        } catch {
          knownFiles.add(file); // malformed, skip
          continue;
        }

        // Move to processed
        const processedDir = join(dataDir, "processed");
        mkdirSync(processedDir, { recursive: true });
        try {
          renameSync(filePath, join(processedDir, file));
        } catch { /* best effort */ }

        // Parse the reply text
        const replyText = (payload.body ?? payload.raw_transcript ?? payload.reply ?? "") as string;
        const parsed = parseReply(replyText);

        clearInterval(timer);
        resolve({
          interactionId: (payload.call_id ?? payload.message_sid ?? file) as string,
          source: (payload.source as "voice" | "whatsapp") ?? "whatsapp",
          decision: parsed.decision,
          rawText: replyText,
          feedback: parsed.feedback,
          callerName: (payload.caller_name ?? "unknown") as string,
          fromNumber: (payload.from_number ?? "") as string,
        });
        return;
      }
    }, pollInterval);
  });
}

// ---------------------------------------------------------------------------
// Gate context builders
// ---------------------------------------------------------------------------

function buildReviewContext(
  specDir: string,
  specName: string,
  artifactType: string,
): GateContext {
  // Read the artifact file for a summary
  const ARTIFACT_FILES: Record<string, string> = {
    intent: "intent-and-constraints.md",
    hld: "high-level-design.md",
    adr: "adr-lite.md",
    eis: "implementation-spec.md",
  };

  const artifactFile = ARTIFACT_FILES[artifactType] ?? `${artifactType}.md`;
  const artifactPath = join(specDir, artifactFile);
  const content = safeReadFile(artifactPath);
  const summary = content.substring(0, 500).trim() || "(artifact not found)";

  return {
    mode: "review" as CallMode,
    specDir,
    specName,
    artifactType,
    artifactSummary: summary,
    artifactPath,
  };
}

function buildBlockerContext(
  specDir: string,
  specName: string,
): GateContext {
  // Find the most recent blocker file
  const blockersDir = join(specDir, "blockers");
  let blockerSummary = "";
  let blockerOptions = "";
  let blockerId = "";

  try {
    const files = readdirSync(blockersDir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .reverse();

    if (files.length > 0) {
      blockerId = files[0].replace(/\.md$/, "");
      const content = safeReadFile(join(blockersDir, files[0]));
      // Extract summary from first 500 chars
      blockerSummary = content.substring(0, 500).trim();
      // Look for options section
      const optionsMatch = content.match(/## Options\n([\s\S]*?)(?:\n## |$)/i);
      if (optionsMatch) {
        blockerOptions = optionsMatch[1].trim();
      }
    }
  } catch { /* no blockers dir */ }

  return {
    mode: "blocker" as CallMode,
    specDir,
    specName,
    blockerId,
    blockerSummary: blockerSummary || "A blocker has been detected during development.",
    blockerOptions,
  };
}

function buildConfirmationContext(
  specDir: string,
  specName: string,
): GateContext {
  // Build a feature summary from available artifacts
  const summaryParts: string[] = [];

  const reqContent = safeReadFile(join(specDir, "REQUIREMENTS.md"));
  if (reqContent) {
    const firstLine = reqContent.split("\n").find((l) => l.trim().length > 0 && !l.startsWith("#"));
    if (firstLine) summaryParts.push(firstLine.trim());
  }

  const eisContent = safeReadFile(join(specDir, "implementation-spec.md"));
  if (eisContent) {
    const heading = eisContent.split("\n").find((l) => l.startsWith("# "));
    if (heading) summaryParts.push(heading.replace(/^# /, ""));
  }

  return {
    mode: "confirmation" as CallMode,
    specDir,
    specName,
    featureSummary: summaryParts.join(" - ") || `Feature "${specName}" has been built and verified.`,
    testResults: "All checks passed",
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Check for --poll-only flag (skip sending, just poll for reply)
  const pollOnly = args.includes("--poll-only");
  const filteredArgs = args.filter(a => a !== "--poll-only");

  if (filteredArgs.length < 1) {
    process.stderr.write(
      "Usage: node lib/cli/trigger-gate.js [--poll-only] <mode> [artifactType] [specDir]\n" +
      "\n" +
      "Modes: review, blocker, confirmation\n" +
      "Flags: --poll-only  Skip sending message, just poll for reply in pending/\n" +
      "\n" +
      "  review <artifactType> [specDir]  - Trigger a review gate\n" +
      "  blocker [specDir]                - Trigger a blocker gate\n" +
      "  confirmation [specDir]           - Trigger a confirmation gate\n",
    );
    process.exit(2);
  }

  const mode = filteredArgs[0] as GateMode;
  if (!["review", "blocker", "confirmation"].includes(mode)) {
    process.stderr.write(`Invalid mode: ${mode}. Must be review, blocker, or confirmation.\n`);
    process.exit(2);
  }

  ensureDataDir();
  const dataDir = getDataDir();
  const specsRoot = getSpecsRoot();

  // Resolve spec directory
  let specDir: string;
  let artifactType = "";

  if (mode === "review") {
    artifactType = filteredArgs[1] ?? "";
    if (!artifactType) {
      process.stderr.write("Review mode requires an artifact type (intent, hld, adr, eis).\n");
      process.exit(2);
    }
    specDir = filteredArgs[2] ?? readActiveSpec() ?? "";
  } else if (mode === "blocker") {
    specDir = filteredArgs[1] ?? readActiveSpec() ?? "";
  } else {
    specDir = filteredArgs[1] ?? readActiveSpec() ?? "";
  }

  if (!specDir) {
    process.stderr.write("No active spec found. Pass specDir as argument or set active-spec.txt.\n");
    process.exit(1);
    return;
  }

  const specName = basename(specDir);

  // Build gate context
  let context: GateContext;
  switch (mode) {
    case "review":
      context = buildReviewContext(specDir, specName, artifactType);
      break;
    case "blocker":
      context = buildBlockerContext(specDir, specName);
      break;
    case "confirmation":
      context = buildConfirmationContext(specDir, specName);
      break;
  }

  // Determine channel
  const complexity = classifyComplexity(mode as CallMode);
  const channel: "voice" | "whatsapp" = complexity === "complex" ? "voice" : "whatsapp";
  const timeoutMs = getTimeout(mode as CallMode);

  const result: GateResult = {
    mode,
    channel,
    reply: null,
    transitions: [],
    timedOut: false,
  };

  // Check for mock mode: SECONDAXIS_MOCK=1 or no API credentials
  const isMock = process.env.SECONDAXIS_MOCK === "1"
    || (!process.env.TWILIO_ACCOUNT_SID && !process.env.RETELL_API_KEY);

  process.stderr.write(`[trigger-gate] ${mode} via ${pollOnly ? "poll-only" : isMock ? "mock" : channel} (timeout: ${timeoutMs / 1000}s)\n`);

  if (pollOnly) {
    // Skip sending — Claude already sent the message via browser MCP.
    // Just poll for the reply.
    process.stderr.write(`[trigger-gate] POLL-ONLY: Waiting for reply in pending/\n`);
  } else if (isMock) {
    // Mock mode: schedule a mock reply AFTER polling starts (avoid race condition)
    process.stderr.write(`[trigger-gate] MOCK: Simulating ${mode} gate (reply in 3s)\n`);
    setTimeout(() => {
      const mockReplyFile = `${Date.now()}-mock-${mode}.json`;
      const mockReplyPath = join(dataDir, "pending", mockReplyFile);
      const mockReply = {
        call_id: `mock-${mode}-${Date.now()}`,
        caller_name: "Mock User",
        from_number: "+0000000000",
        source: "mock",
        body: mode === "confirmation" ? "Yes, looks good. Confirmed." : "Approved. Looks good, proceed.",
        created_at: new Date().toISOString(),
      };
      writeFileSync(mockReplyPath, JSON.stringify(mockReply, null, 2), "utf-8");
      process.stderr.write(`[trigger-gate] MOCK: Wrote mock reply to ${mockReplyFile}\n`);
    }, 3000);
  } else {
    // Real mode: send the outbound message/call
    try {
      if (channel === "whatsapp") {
        const body = formatGateMessage(context);
        await sendWhatsAppMessage(body);
        process.stderr.write(`[trigger-gate] WhatsApp message sent\n`);
      } else {
        await sendVoiceCall(context);
        process.stderr.write(`[trigger-gate] Voice call triggered\n`);
      }
    } catch (err) {
      // If WhatsApp fails, escalate to voice
      if (channel === "whatsapp") {
        process.stderr.write(`[trigger-gate] WhatsApp failed: ${(err as Error).message}, escalating to voice\n`);
        try {
          await sendVoiceCall(context);
          result.channel = "voice";
          process.stderr.write(`[trigger-gate] Voice call triggered (fallback)\n`);
        } catch (voiceErr) {
          process.stderr.write(`[trigger-gate] Voice also failed: ${(voiceErr as Error).message}\n`);
          process.exit(1);
        }
      } else {
        process.stderr.write(`[trigger-gate] Voice call failed: ${(err as Error).message}\n`);
        process.exit(1);
      }
    }
  }

  // Poll for reply via filesystem
  const reply = await pollForReply(mode, timeoutMs);

  if (!reply) {
    // Timeout — if we started with WhatsApp, escalate to voice
    if (!isMock && channel === "whatsapp") {
      process.stderr.write(`[trigger-gate] WhatsApp timeout, escalating to voice\n`);
      try {
        await sendVoiceCall(context);
        result.channel = "voice";
        // Poll again with voice timeout (use remaining time or 10 min)
        const voiceTimeout = getTimeout("blocker" as CallMode); // voice gets full timeout
        const voiceReply = await pollForReply(mode, voiceTimeout);
        if (voiceReply) {
          result.reply = voiceReply;
        } else {
          result.timedOut = true;
          process.stderr.write(`[trigger-gate] Voice timeout — no reply received\n`);
        }
      } catch (err) {
        result.timedOut = true;
        process.stderr.write(`[trigger-gate] Voice escalation failed: ${(err as Error).message}\n`);
      }
    } else {
      result.timedOut = true;
      process.stderr.write(`[trigger-gate] Timeout — no reply received\n`);
    }
  } else {
    result.reply = reply;
  }

  // Clear gate-pending file now that we have a reply
  const gatePendingPath = join(dataDir, "gate-pending.json");
  try { unlinkSync(gatePendingPath); } catch { /* may not exist */ }

  // Run FSM transitions based on reply decision
  if (result.reply) {
    try {
      const decision = result.reply.decision;
      const feedback = result.reply.feedback ?? "";

      switch (mode) {
        case "review": {
          if (decision === "approved") {
            const t = runTransition("REVIEW_APPROVED", {
              specDir,
              reviewedArtifact: `sdlc_${artifactType}`,
            });
            result.transitions.push(t);
          } else {
            const t = runTransition("REVIEW_REJECTED", {
              specDir,
              reviewedArtifact: `sdlc_${artifactType}`,
              revisionNotes: feedback,
            });
            result.transitions.push(t);
          }
          break;
        }

        case "blocker": {
          const t = runTransition("BLOCKER_RESOLVED", {
            specDir,
            resolution: result.reply.rawText,
          });
          result.transitions.push(t);
          break;
        }

        case "confirmation": {
          if (decision === "approved") {
            const t1 = runTransition("USER_CONFIRMED", { specDir });
            result.transitions.push(t1);
            const t2 = runTransition("RESET", {});
            result.transitions.push(t2);
          } else {
            const t = runTransition("USER_REJECTED", {
              specDir,
              painPoints: feedback,
            });
            result.transitions.push(t);
          }
          break;
        }
      }
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        process.stderr.write(`[trigger-gate] FSM transition failed: ${err.message}\n`);
      } else {
        throw err;
      }
    }
  }

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

main().catch((err) => {
  process.stderr.write(`[trigger-gate] Fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
