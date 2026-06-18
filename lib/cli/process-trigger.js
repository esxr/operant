#!/usr/bin/env node
/**
 * @module cli/process-trigger
 *
 * Usage: node lib/cli/process-trigger.js <trigger-file-path>
 *
 * Processes a call/WhatsApp trigger file and runs FSM transitions.
 * This is the core pipeline entry point: reads trigger JSON, classifies
 * the transcript, and drives the state machine forward.
 *
 * Exit 0 on success, 1 on error, 2 on usage error.
 */
import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { transition, classifyTranscript, deriveSpecName, InvalidTransitionError, } from "../state-machine.js";
import { getDataDir, getSpecsOutputDir, readState, writeState, writeActiveSpec, ensureDataDir, } from "../config.js";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function runTransition(event, context) {
    const currentState = readState();
    const result = transition(currentState, event, context);
    writeState(result.to);
    return result;
}
function moveToProcessed(triggerPath) {
    const dataDir = getDataDir();
    const processedDir = join(dataDir, "processed");
    mkdirSync(processedDir, { recursive: true });
    const dest = join(processedDir, basename(triggerPath));
    try {
        renameSync(triggerPath, dest);
    }
    catch {
        // Cross-device move fallback: copy then unlink
        const content = readFileSync(triggerPath);
        writeFileSync(dest, content);
        unlinkSync(triggerPath);
    }
    return dest;
}
// ---------------------------------------------------------------------------
// GitHub notification helper
// ---------------------------------------------------------------------------
async function sendGitHubNotification(issue) {
    try {
        const msg = [
            `New feedback from @${issue.author}: "${issue.title}"`,
            `Issue #${issue.number}: ${issue.url}`,
            `Starting pipeline.`,
        ].join("\n");
        const accountSid = process.env.TWILIO_ACCOUNT_SID;
        const authToken = process.env.TWILIO_AUTH_TOKEN;
        const whatsappFrom = process.env.TWILIO_WHATSAPP_NUMBER;
        const whatsappTo = process.env.TWILIO_WHATSAPP_RECIPIENT;
        if (!accountSid || !authToken || !whatsappFrom || !whatsappTo) {
            process.stderr.write("[process-trigger] WhatsApp not configured, skipping notification\n");
            return;
        }
        const from = whatsappFrom.startsWith("whatsapp:") ? whatsappFrom : `whatsapp:${whatsappFrom}`;
        const to = whatsappTo.startsWith("whatsapp:") ? whatsappTo : `whatsapp:${whatsappTo}`;
        const { default: https } = await import("node:https");
        const params = new URLSearchParams();
        params.append("From", from);
        params.append("To", to);
        params.append("Body", msg);
        const payload = params.toString();
        const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
        await new Promise((resolve, reject) => {
            const req = https.request({
                hostname: "api.twilio.com",
                port: 443,
                path: `/2010-04-01/Accounts/${accountSid}/Messages.json`,
                method: "POST",
                headers: {
                    Authorization: `Basic ${auth}`,
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Content-Length": String(Buffer.byteLength(payload)),
                },
            }, (res) => {
                let data = "";
                res.on("data", (chunk) => { data += chunk; });
                res.on("end", () => {
                    if (res.statusCode && res.statusCode >= 400) {
                        reject(new Error(`Twilio error ${res.statusCode}: ${data.slice(0, 200)}`));
                    }
                    else {
                        resolve();
                    }
                });
            });
            req.on("error", reject);
            req.write(payload);
            req.end();
        });
        // Success — no log (stdout is reserved for JSON result)
    }
    catch (err) {
        process.stderr.write(`[process-trigger] WhatsApp notification failed: ${err.message}\n`);
    }
}
// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    const args = process.argv.slice(2);
    if (args.length < 1) {
        process.stderr.write("Usage: node lib/cli/process-trigger.js <trigger-file-path>\n" +
            "\n" +
            "Processes a trigger JSON file and drives FSM transitions.\n" +
            "The trigger file is moved to processed/ after handling.\n");
        process.exit(2);
    }
    const triggerPath = args[0];
    ensureDataDir();
    let payload;
    try {
        const raw = readFileSync(triggerPath, "utf-8");
        payload = JSON.parse(raw);
    }
    catch (err) {
        process.stderr.write(`Failed to read trigger file: ${err.message}\n`);
        process.exit(1);
        return; // unreachable, satisfies TS
    }
    const callId = payload.call_id ?? "unknown";
    const callerName = payload.caller_name ?? "unknown";
    const fromNumber = payload.from_number ?? "";
    const transcript = payload.raw_transcript
        ?? payload.spec?.raw_transcript
        ?? payload.body
        ?? "";
    const callAnalysis = payload.call_analysis ?? payload.spec?.call_analysis;
    const featureName = payload.spec?.feature_name
        ?? callAnalysis?.custom_analysis_data?.feature_name
        ?? "";
    const result = {
        triggerFile: triggerPath,
        transitions: [],
        movedTo: "",
    };
    try {
        const currentState = readState();
        const source = (payload.source ?? "voice");
        if (source === "github") {
            // GitHub-specific path
            const ghIssue = payload.github_issue;
            if (!ghIssue) {
                process.stderr.write("GitHub trigger missing github_issue field\n");
                process.exit(1);
            }
            const issueBody = ghIssue.body ?? "";
            const transcript = issueBody.length >= 20 ? issueBody : ghIssue.title;
            const featureName = ghIssue.title;
            // Fire ISSUE_RECEIVED (idle -> triage directly)
            if (currentState === "idle") {
                const t = runTransition("ISSUE_RECEIVED", {
                    issueNumber: String(ghIssue.number),
                    author: ghIssue.author,
                });
                result.transitions.push(t);
            }
            // Classify and proceed
            const stateAfterIssue = readState();
            if (stateAfterIssue === "triage") {
                const classification = classifyTranscript(transcript);
                result.classification = classification;
                switch (classification) {
                    case "requirements": {
                        const specName = deriveSpecName(featureName);
                        result.specName = specName;
                        const specDir = join(getSpecsOutputDir(), specName);
                        writeActiveSpec(specDir);
                        const requirementsContent = [
                            `> Source: GitHub Issue #${ghIssue.number} -- ${ghIssue.url}`,
                            ``,
                            transcript,
                        ].join("\n");
                        const t = runTransition("NEW_REQUIREMENTS", {
                            specName,
                            specDir,
                            requirements: requirementsContent,
                        });
                        result.transitions.push(t);
                        // Write source-metadata.json
                        if (!existsSync(specDir))
                            mkdirSync(specDir, { recursive: true });
                        writeFileSync(join(specDir, "source-metadata.json"), JSON.stringify({
                            source: "github",
                            issue_number: ghIssue.number,
                            issue_url: ghIssue.url,
                            author: ghIssue.author,
                            created_at: ghIssue.created_at,
                        }, null, 2));
                        break;
                    }
                    case "confirmation": {
                        const t1 = runTransition("CONFIRMATION_RECEIVED", { specDir: "" });
                        result.transitions.push(t1);
                        const t2 = runTransition("RESET", {});
                        result.transitions.push(t2);
                        break;
                    }
                    case "unknown": {
                        const t = runTransition("REJECTED", {
                            reason: "GitHub issue content could not be classified",
                        });
                        result.transitions.push(t);
                        break;
                    }
                }
            }
            // Execute filesystem side effects (same pattern as voice path)
            for (const t of result.transitions) {
                for (const effect of t.sideEffects) {
                    if (effect.type === "CREATE_SPEC_DIR") {
                        const specDir = join(getSpecsOutputDir(), effect.name);
                        if (!existsSync(specDir))
                            mkdirSync(specDir, { recursive: true });
                    }
                    else if (effect.type === "WRITE_REQUIREMENTS") {
                        const reqPath = join(effect.specDir, "REQUIREMENTS.md");
                        if (!existsSync(effect.specDir))
                            mkdirSync(effect.specDir, { recursive: true });
                        writeFileSync(reqPath, effect.content, "utf-8");
                    }
                }
            }
            // Best-effort WhatsApp notification
            await sendGitHubNotification(ghIssue);
        }
        else {
            // Voice / WhatsApp path (unchanged)
            // Step 1: If idle, transition to call_active
            if (currentState === "idle") {
                const t = runTransition("CALL_RECEIVED", { callId });
                result.transitions.push(t);
            }
            // Step 2: If call_active, transition to triage
            const stateAfterStep1 = readState();
            if (stateAfterStep1 === "call_active") {
                const t = runTransition("CALL_COMPLETED", {
                    callId,
                    callerName,
                    fromNumber,
                    triggerFile: basename(triggerPath),
                    triggerPath,
                });
                result.transitions.push(t);
            }
            // Step 3: If triage, classify and transition
            const stateAfterStep2 = readState();
            if (stateAfterStep2 === "triage") {
                const classification = classifyTranscript(transcript, callAnalysis);
                result.classification = classification;
                switch (classification) {
                    case "requirements": {
                        const specName = deriveSpecName(featureName || payload.spec?.call_summary || transcript.substring(0, 80));
                        result.specName = specName;
                        const specDir = join(getSpecsOutputDir(), specName);
                        writeActiveSpec(specDir);
                        const t = runTransition("NEW_REQUIREMENTS", {
                            specName,
                            specDir,
                            requirements: transcript,
                        });
                        result.transitions.push(t);
                        break;
                    }
                    case "confirmation": {
                        const t1 = runTransition("CONFIRMATION_RECEIVED", {
                            specDir: "",
                        });
                        result.transitions.push(t1);
                        // Reset to idle after confirmation
                        const t2 = runTransition("RESET", {});
                        result.transitions.push(t2);
                        break;
                    }
                    case "unknown": {
                        const t = runTransition("REJECTED", {
                            reason: "Transcript could not be classified",
                        });
                        result.transitions.push(t);
                        break;
                    }
                }
            }
            // Execute filesystem side effects (CREATE_SPEC_DIR, WRITE_REQUIREMENTS)
            for (const t of result.transitions) {
                for (const effect of t.sideEffects) {
                    if (effect.type === "CREATE_SPEC_DIR") {
                        const specDir = join(getSpecsOutputDir(), effect.name);
                        if (!existsSync(specDir)) {
                            mkdirSync(specDir, { recursive: true });
                        }
                    }
                    else if (effect.type === "WRITE_REQUIREMENTS") {
                        const reqPath = join(effect.specDir, "REQUIREMENTS.md");
                        if (!existsSync(effect.specDir)) {
                            mkdirSync(effect.specDir, { recursive: true });
                        }
                        writeFileSync(reqPath, effect.content, "utf-8");
                    }
                }
            }
        }
        // Move trigger to processed (both paths)
        result.movedTo = moveToProcessed(triggerPath);
    }
    catch (err) {
        if (err instanceof InvalidTransitionError) {
            process.stderr.write(`Invalid transition: ${err.message}\n`);
            // Still move to processed to avoid re-processing
            try {
                result.movedTo = moveToProcessed(triggerPath);
            }
            catch { /* ignore */ }
            result.transitions.push({
                from: err.from,
                to: err.from,
                event: err.event,
                sideEffects: [],
            });
        }
        else {
            process.stderr.write(`Error: ${err.message}\n`);
            process.exit(1);
        }
    }
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
main().catch((err) => {
    process.stderr.write(`Fatal: ${err.message}\n`);
    process.exit(1);
});
