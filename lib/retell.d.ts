/**
 * @module retell
 *
 * Retell.ai API client and RetellChannel implementation.
 * Manages voice calls for human-in-the-loop gates.
 */
import { EventEmitter } from "node:events";
import type { Channel, GateContext, GateReply } from "./channel.js";
export declare function getAgentId(): string;
export declare function getPhoneNumber(): string;
export type CallMode = "requirements" | "blocker" | "review" | "confirmation" | "demo_invite";
export interface DynamicVariables {
    call_mode: CallMode;
    blocker_id?: string;
    blocker_feature?: string;
    blocker_summary?: string;
    blocker_options?: string;
    artifact_type?: string;
    artifact_summary?: string;
    spec_name?: string;
    feature_summary?: string;
    test_results?: string;
    meet_url?: string;
    meet_code?: string;
    [key: string]: string | undefined;
}
/**
 * Build a DynamicVariables object for a given call mode.
 * Pulls the relevant fields from `context` and sets `call_mode`.
 */
export declare function buildDynamicVars(mode: string, context: Record<string, string>): DynamicVariables;
export interface CreateAgentConfig {
    agent_name: string;
    llm_websocket_url?: string;
    response_engine?: Record<string, unknown>;
    voice_id?: string;
    webhook_url?: string;
}
export declare function createAgent(config: CreateAgentConfig): Promise<Record<string, unknown>>;
export declare function updateAgentWebhook(agentId: string, webhookUrl: string): Promise<Record<string, unknown>>;
export declare function createPhoneNumber(agentId: string, areaCode?: number): Promise<Record<string, unknown>>;
export interface OutboundCallMetadata {
    blocker_id?: string;
    spec_name?: string;
    blocker_summary?: string;
    [key: string]: unknown;
}
export declare function makeOutboundCall(fromNumber: string, toNumber: string, agentId: string, metadata?: OutboundCallMetadata, dynamicVariables?: DynamicVariables): Promise<Record<string, unknown>>;
export declare function listPhoneNumbers(): Promise<Record<string, unknown>>;
export declare function getCallDetails(callId: string): Promise<Record<string, unknown>>;
/**
 * Event bus for voice call completions.
 * The server emits "voice:reply" when a call_completed webhook arrives
 * during a pending voice gate.
 */
export declare const voiceEvents: EventEmitter<[never]>;
export declare class RetellChannel implements Channel {
    readonly name: "voice";
    private log;
    private dataDir;
    constructor(log: (msg: string) => void, dataDir: string);
    sendGate(context: GateContext): Promise<GateReply>;
    private loadDefaultTarget;
}
