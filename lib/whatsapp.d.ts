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
import { EventEmitter } from "node:events";
import type { Channel, GateContext, GateReply } from "./channel.js";
export declare function formatGateMessage(context: GateContext): string;
export interface ParsedReply {
    decision: "approved" | "rejected";
    feedback?: string;
}
export declare function parseReply(text: string): ParsedReply;
/**
 * Event bus for WhatsApp inbound replies.
 * server.ts emits "whatsapp:reply" when a Twilio webhook arrives.
 */
export declare const whatsappEvents: EventEmitter<[never]>;
export declare class WhatsAppChannel implements Channel {
    readonly name: "whatsapp";
    private log;
    private tunnelUrl;
    constructor(log: (msg: string) => void, tunnelUrl: string | null);
    setTunnelUrl(url: string): void;
    sendGate(context: GateContext): Promise<GateReply>;
}
