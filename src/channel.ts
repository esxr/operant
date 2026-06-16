/**
 * @module channel
 *
 * Channel abstraction layer for human-in-the-loop gates.
 * Routes gate interactions to voice (Retell) or WhatsApp (Twilio)
 * based on complexity classification. Manages timeout escalation.
 *
 * ADR-001: Abstraction in executor, not FSM
 * ADR-002: Deterministic complexity classification
 * ADR-006: Timeout escalation internal to ChannelRouter
 */

import type { CallMode } from "./retell.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a gate interaction, regardless of channel. */
export interface GateReply {
  interactionId: string;
  source: "voice" | "whatsapp";
  decision: "approved" | "rejected";
  rawText: string;
  feedback?: string;
  callerName: string;
  fromNumber: string;
}

/** Context passed to a channel for sending a gate message. */
export interface GateContext {
  mode: CallMode;
  specDir: string;
  specName: string;
  artifactType?: string;
  artifactSummary?: string;
  artifactPath?: string;
  blockerId?: string;
  blockerSummary?: string;
  blockerOptions?: string;
  featureSummary?: string;
  testResults?: string;
  meetUrl?: string;
  meetCode?: string;
}

/** A communication channel that can send gate messages and receive replies. */
export interface Channel {
  readonly name: "voice" | "whatsapp";
  sendGate(context: GateContext): Promise<GateReply>;
}

// ---------------------------------------------------------------------------
// Complexity Classification (ADR-002)
// ---------------------------------------------------------------------------

export type Complexity = "simple" | "complex";

const DEFAULT_COMPLEXITY: Record<CallMode, Complexity> = {
  confirmation: "simple",
  review: "simple",
  demo_invite: "simple",
  blocker: "complex",
  requirements: "complex",
};

/**
 * Classify gate complexity. Checks env overrides first
 * (CHANNEL_OVERRIDE_<mode>=voice|whatsapp), then falls back to defaults.
 */
export function classifyComplexity(mode: CallMode): Complexity {
  const override = process.env[`CHANNEL_OVERRIDE_${mode}`];
  if (override === "voice") return "complex";
  if (override === "whatsapp") return "simple";
  return DEFAULT_COMPLEXITY[mode] ?? "complex";
}

// ---------------------------------------------------------------------------
// Timeout Configuration (ADR-006)
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUTS: Record<CallMode, number> = {
  confirmation: 5 * 60 * 1000,
  review: 10 * 60 * 1000,
  demo_invite: 10 * 60 * 1000,
  blocker: 10 * 60 * 1000,
  requirements: 10 * 60 * 1000,
};

export function getTimeout(mode: CallMode): number {
  const envVal = process.env[`CHANNEL_TIMEOUT_${mode}`];
  if (envVal) return parseInt(envVal, 10) * 1000;
  return DEFAULT_TIMEOUTS[mode] ?? 10 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// ChannelRouter
// ---------------------------------------------------------------------------

export interface ChannelRouterConfig {
  voiceChannel: Channel;
  whatsappChannel: Channel;
  log: (msg: string) => void;
}

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

    this.log(`[channel] ${context.mode} -> whatsapp (simple, timeout ${getTimeout(context.mode) / 1000}s)`);
    const timeout = getTimeout(context.mode);

    return new Promise<GateReply>((resolve, reject) => {
      let resolved = false;

      const whatsappPromise = this.whatsapp.sendGate(context);

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

      whatsappPromise
        .then((reply) => {
          if (!resolved) {
            resolved = true;
            if (this.pendingTimeout) clearTimeout(this.pendingTimeout);
            this.pendingTimeout = null;
            resolve(reply);
          }
        })
        .catch((err) => {
          if (!resolved) {
            this.log(`[channel] WhatsApp failed: ${(err as Error).message} — falling back to voice`);
            if (this.pendingTimeout) clearTimeout(this.pendingTimeout);
            this.pendingTimeout = null;
            this.voice.sendGate(context).then(resolve).catch(reject);
          }
        });
    });
  }

  cancel(): void {
    if (this.pendingTimeout) {
      clearTimeout(this.pendingTimeout);
      this.pendingTimeout = null;
    }
  }
}
