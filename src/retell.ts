/**
 * @module retell
 *
 * Retell.ai API client and RetellChannel implementation.
 * Manages voice calls for human-in-the-loop gates.
 */

import https from "node:https";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { Channel, GateContext, GateReply } from "./channel.js";
import { getMode, getOperantApiKey, getOperantApiUrl } from './config.js';

const BASE_HOST = "api.retellai.com";

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

interface EnvConfig {
  RETELL_API_KEY: string;
  RETELL_LLM_ID: string;
  RETELL_AGENT_ID: string;
  RETELL_PHONE_NUMBER: string;
}

function getApiKey(): string {
  if (process.env.RETELL_API_KEY) {
    return process.env.RETELL_API_KEY;
  }

  throw new Error(
    "RETELL_API_KEY not found. Set it as an environment variable or in the project .env file."
  );
}

function getEnvValue(key: keyof EnvConfig): string {
  const envVal = process.env[key];
  if (envVal) return envVal;

  throw new Error(
    `${key} not found. Set it as an environment variable or in the project .env file.`
  );
}

export function getAgentId(): string {
  return getEnvValue("RETELL_AGENT_ID");
}

export function getPhoneNumber(): string {
  return getEnvValue("RETELL_PHONE_NUMBER");
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

function request(
  method: string,
  path: string,
  body: Record<string, unknown> | null = null
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const apiKey = getApiKey();
    const payload = body ? JSON.stringify(body) : null;

    const options: https.RequestOptions = {
      hostname: BASE_HOST,
      port: 443,
      path,
      method,
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
              `Retell API error ${res.statusCode} ${method} ${path}: ${JSON.stringify(parsed)}`
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
// Dynamic Variables
// ---------------------------------------------------------------------------

export type CallMode = "requirements" | "blocker" | "review" | "confirmation" | "demo_invite";

export interface DynamicVariables {
  // Common to all modes
  call_mode: CallMode;

  // Blocker mode (call_mode = "blocker")
  blocker_id?: string;
  blocker_feature?: string;
  blocker_summary?: string;
  blocker_options?: string;

  // Review mode (call_mode = "review")
  artifact_type?: string;      // "intent" | "hld" | "adr" | "eis"
  artifact_summary?: string;   // 2-minute TL;DR of the artifact
  spec_name?: string;          // human-readable spec name

  // Confirmation mode (call_mode = "confirmation")
  feature_summary?: string;    // what was built
  test_results?: string;       // audit pass/fail summary

  // Demo invite mode (call_mode = "demo_invite")
  meet_url?: string;           // https://meet.google.com/abc-defg-hij
  meet_code?: string;          // abc-defg-hij

  // Index signature for extensibility
  [key: string]: string | undefined;
}

/**
 * Build a DynamicVariables object for a given call mode.
 * Pulls the relevant fields from `context` and sets `call_mode`.
 */
export function buildDynamicVars(
  mode: string,
  context: Record<string, string>
): DynamicVariables {
  const callMode = mode as CallMode;

  switch (callMode) {
    case "requirements":
      return { call_mode: "requirements" };

    case "blocker":
      return {
        call_mode: "blocker",
        blocker_id: context.blocker_id,
        blocker_feature: context.blocker_feature,
        blocker_summary: context.blocker_summary,
        blocker_options: context.blocker_options,
      };

    case "review":
      return {
        call_mode: "review",
        artifact_type: context.artifact_type,
        artifact_summary: context.artifact_summary,
        spec_name: context.spec_name,
      };

    case "confirmation":
      return {
        call_mode: "confirmation",
        feature_summary: context.feature_summary,
        test_results: context.test_results,
        spec_name: context.spec_name,
      };

    case "demo_invite":
      return {
        call_mode: "demo_invite",
        meet_url: context.meet_url,
        meet_code: context.meet_code,
        spec_name: context.spec_name,
        feature_summary: context.feature_summary,
      };

    default:
      return { call_mode: callMode, ...context };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CreateAgentConfig {
  agent_name: string;
  llm_websocket_url?: string;
  response_engine?: Record<string, unknown>;
  voice_id?: string;
  webhook_url?: string;
}

export function createAgent(
  config: CreateAgentConfig
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {};
  if (config.agent_name) body.agent_name = config.agent_name;
  if (config.llm_websocket_url)
    body.llm_websocket_url = config.llm_websocket_url;
  if (config.response_engine) body.response_engine = config.response_engine;
  if (config.voice_id) body.voice_id = config.voice_id;
  if (config.webhook_url) body.webhook_url = config.webhook_url;

  return request("POST", "/create-agent", body);
}

export function updateAgentWebhook(
  agentId: string,
  webhookUrl: string
): Promise<Record<string, unknown>> {
  return request("PATCH", `/update-agent/${agentId}`, {
    webhook_url: webhookUrl,
  });
}

export function createPhoneNumber(
  agentId: string,
  areaCode: number = 650
): Promise<Record<string, unknown>> {
  return request("POST", "/create-phone-number", {
    inbound_agents: [{ agent_id: agentId, weight: 1 }],
    area_code: areaCode,
    number_provider: "twilio",
  });
}

export interface OutboundCallMetadata {
  blocker_id?: string;
  spec_name?: string;
  blocker_summary?: string;
  [key: string]: unknown;
}

function cloudOutboundCall(
  toNumber: string,
  metadata: OutboundCallMetadata,
  dynamicVariables?: DynamicVariables
): Promise<Record<string, unknown>> {
  const apiUrl = getOperantApiUrl();
  const apiKey = getOperantApiKey();
  const payload = JSON.stringify({
    to_number: toNumber,
    dynamic_variables: dynamicVariables ?? {},
    metadata: metadata ?? {},
  });

  return new Promise((resolve, reject) => {
    const url = new URL(`${apiUrl}/api/calls/outbound`);
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

export function makeOutboundCall(
  fromNumber: string,
  toNumber: string,
  agentId: string,
  metadata: OutboundCallMetadata = {},
  dynamicVariables?: DynamicVariables
): Promise<Record<string, unknown>> {
  // Cloud mode: proxy through operant-api
  if (getMode() === 'cloud') {
    return cloudOutboundCall(toNumber, metadata, dynamicVariables);
  }
  // Existing local mode code below (unchanged)
  const body: Record<string, unknown> = {
    from_number: fromNumber,
    to_number: toNumber,
    override_agent_id: agentId,
  };

  if (metadata && Object.keys(metadata).length > 0) {
    body.metadata = metadata;
  }

  if (dynamicVariables && Object.keys(dynamicVariables).length > 0) {
    // Retell requires all values to be strings
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(dynamicVariables)) {
      if (v !== undefined) cleaned[k] = String(v);
    }
    body.retell_llm_dynamic_variables = cleaned;
  }

  return request("POST", "/v2/create-phone-call", body);
}

export function listPhoneNumbers(): Promise<Record<string, unknown>> {
  return request("GET", "/list-phone-numbers");
}

export function getCallDetails(
  callId: string
): Promise<Record<string, unknown>> {
  return request("GET", `/get-call/${callId}`);
}

// ---------------------------------------------------------------------------
// Channel Interface Implementation (ADR-001)
// ---------------------------------------------------------------------------

/**
 * Event bus for voice call completions.
 * The server emits "voice:reply" when a call_completed webhook arrives
 * during a pending voice gate.
 */
export const voiceEvents = new EventEmitter();

export class RetellChannel implements Channel {
  readonly name = "voice" as const;
  private log: (msg: string) => void;
  private dataDir: string;

  constructor(log: (msg: string) => void, dataDir: string) {
    this.log = log;
    this.dataDir = dataDir;
  }

  async sendGate(context: GateContext): Promise<GateReply> {
    // Real outbound call
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
      meet_url: context.meetUrl ?? "",
      meet_code: context.meetCode ?? "",
    });

    const agentId = getAgentId();
    const fromNumber = getPhoneNumber();
    const toNumber = this.loadDefaultTarget();

    await makeOutboundCall(fromNumber, toNumber, agentId, {
      spec_name: context.specName,
    }, dynVars);

    this.log(`[voice] Call triggered for ${context.mode}: ${context.specName}`);

    // Wait for call completion via event bus
    return new Promise<GateReply>((resolve) => {
      voiceEvents.once("voice:reply", (reply: GateReply) => {
        resolve(reply);
      });
    });
  }

  private loadDefaultTarget(): string {
    const dataDir = process.env.OPERANT_PI_DATA_DIR ?? this.dataDir;
    const whitelistPath = join(dataDir, "whitelist.json");
    try {
      const wl = JSON.parse(readFileSync(whitelistPath, "utf-8"));
      return wl.default_blocker_target ?? "";
    } catch {
      return "";
    }
  }
}
