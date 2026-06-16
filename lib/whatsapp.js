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
import { getMode, getOperantApiKey, getOperantApiUrl } from './config.js';
function getConfig() {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const whatsappNumber = process.env.TWILIO_WHATSAPP_NUMBER;
    const recipientNumber = process.env.TWILIO_WHATSAPP_RECIPIENT;
    if (!accountSid || !authToken || !whatsappNumber || !recipientNumber) {
        throw new Error("Missing Twilio config. Required: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, " +
            "TWILIO_WHATSAPP_NUMBER, TWILIO_WHATSAPP_RECIPIENT");
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
export function formatGateMessage(context) {
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
export function parseReply(text) {
    const trimmed = text.trim();
    if (trimmed === "1")
        return { decision: "approved" };
    if (trimmed === "2")
        return { decision: "rejected" };
    const lower = trimmed.toLowerCase();
    const approveKeywords = ["approve", "approved", "lgtm", "ship it", "yes", "looks good", "go ahead"];
    const rejectKeywords = ["reject", "rejected", "no", "changes needed", "fix", "redo"];
    for (const kw of approveKeywords) {
        if (lower.includes(kw))
            return { decision: "approved" };
    }
    for (const kw of rejectKeywords) {
        if (lower.includes(kw))
            return { decision: "rejected", feedback: trimmed };
    }
    // Conservative default: unknown text = rejected with feedback (ADR-005)
    return { decision: "rejected", feedback: trimmed };
}
// ---------------------------------------------------------------------------
// Twilio HTTP Client
// ---------------------------------------------------------------------------
function sendTwilioMessage(config, body, mediaUrl) {
    return new Promise((resolve, reject) => {
        const params = new URLSearchParams();
        params.append("From", config.whatsappNumber);
        params.append("To", config.recipientNumber);
        params.append("Body", body);
        if (mediaUrl)
            params.append("MediaUrl", mediaUrl);
        const payload = params.toString();
        const auth = Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64");
        const options = {
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
            res.on("data", (chunk) => { data += chunk; });
            res.on("end", () => {
                if (res.statusCode && res.statusCode >= 400) {
                    reject(new Error(`Twilio API error ${res.statusCode}: ${data}`));
                    return;
                }
                try {
                    resolve(JSON.parse(data));
                }
                catch {
                    resolve({ raw: data });
                }
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
function cloudSendWhatsApp(to, body) {
    const apiUrl = getOperantApiUrl();
    const apiKey = getOperantApiKey();
    const payload = JSON.stringify({ to, body });
    return new Promise((resolve, reject) => {
        const url = new URL(`${apiUrl}/api/whatsapp/send`);
        const req = https.request({
            hostname: url.hostname,
            port: url.port ? Number(url.port) : 443,
            path: url.pathname,
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Content-Length': String(Buffer.byteLength(payload)),
            },
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 400) {
                    reject(new Error(`Operant API error ${res.statusCode}: ${data}`));
                    return;
                }
                try {
                    resolve(JSON.parse(data));
                }
                catch {
                    resolve({ raw: data });
                }
            });
        });
        req.on('error', (err) => reject(new Error(`Operant API request failed: ${err.message}`)));
        req.write(payload);
        req.end();
    });
}
// ---------------------------------------------------------------------------
// WhatsAppChannel
// ---------------------------------------------------------------------------
export class WhatsAppChannel {
    name = "whatsapp";
    log;
    tunnelUrl;
    constructor(log, tunnelUrl) {
        this.log = log;
        this.tunnelUrl = tunnelUrl;
    }
    setTunnelUrl(url) {
        this.tunnelUrl = url;
    }
    async sendGate(context) {
        const body = formatGateMessage(context);
        // Cloud mode: proxy through operant-api
        if (getMode() === 'cloud') {
            const recipient = process.env.TWILIO_WHATSAPP_RECIPIENT ?? '';
            const to = recipient.replace('whatsapp:', '');
            this.log(`[whatsapp] Sending ${context.mode} gate via cloud proxy`);
            await cloudSendWhatsApp(to, body);
            // Wait for inbound reply via event bus (same as local mode)
            return new Promise((resolve) => {
                const handler = (reply) => {
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
        const config = getConfig();
        // Build media URL for review artifacts (ADR-004)
        let mediaUrl;
        if (context.artifactPath && this.tunnelUrl && context.mode === "review") {
            const filename = context.artifactType ? `${context.artifactType}.pdf` : "artifact.pdf";
            mediaUrl = `${this.tunnelUrl}/media/${context.specName}/${filename}`;
        }
        this.log(`[whatsapp] Sending ${context.mode} gate to ${config.recipientNumber}`);
        await sendTwilioMessage(config, body, mediaUrl);
        // Wait for inbound reply via event bus
        return new Promise((resolve) => {
            const handler = (reply) => {
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
