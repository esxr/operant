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
export type Complexity = "simple" | "complex";
/**
 * Classify gate complexity. Checks env overrides first
 * (CHANNEL_OVERRIDE_<mode>=voice|whatsapp), then falls back to defaults.
 */
export declare function classifyComplexity(mode: CallMode): Complexity;
export declare function getTimeout(mode: CallMode): number;
export interface ChannelRouterConfig {
    voiceChannel: Channel;
    whatsappChannel: Channel;
    log: (msg: string) => void;
}
export declare class ChannelRouter {
    private voice;
    private whatsapp;
    private log;
    private pendingTimeout;
    constructor(config: ChannelRouterConfig);
    sendGate(context: GateContext): Promise<GateReply>;
    cancel(): void;
}
