#!/usr/bin/env node
/**
 * @module cli/status
 *
 * Usage: node lib/cli/status.js
 *
 * Reads state files from data dir, lists specs, reads whitelist,
 * and prints formatted pipeline status.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { listSpecs, stateToPhase } from "../state-machine.js";
import { getDataDir, getSpecsRoot, readState, readActiveSpec } from "../config.js";
function loadWhitelist(dataDir) {
    const whitelistPath = join(dataDir, "whitelist.json");
    try {
        return JSON.parse(readFileSync(whitelistPath, "utf-8"));
    }
    catch {
        return { callers: [], default_blocker_target: "" };
    }
}
function countJsonFiles(dirPath) {
    try {
        return readdirSync(dirPath).filter((f) => f.endsWith(".json")).length;
    }
    catch {
        return 0;
    }
}
function checkPid(pidFile, dataDir) {
    const pidPath = join(dataDir, pidFile);
    if (!existsSync(pidPath))
        return "not running";
    try {
        const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
        process.kill(pid, 0); // existence check only
        return `PID ${pid}`;
    }
    catch {
        return "not running (stale PID)";
    }
}
function readTunnelUrl(dataDir) {
    const urlPath = join(dataDir, "tunnel_url.txt");
    try {
        const url = readFileSync(urlPath, "utf-8").trim();
        return url.length > 0 ? url : "not running";
    }
    catch {
        return "not running";
    }
}
function main() {
    const dataDir = getDataDir();
    const specsRoot = getSpecsRoot();
    const currentState = readState();
    const activeSpec = readActiveSpec() ?? "none";
    const phase = stateToPhase(currentState);
    const wl = loadWhitelist(dataDir);
    const specs = listSpecs(specsRoot);
    const activeSpecs = specs.filter((s) => !s.complete);
    const completeSpecs = specs.filter((s) => s.complete);
    const pendingCount = countJsonFiles(join(dataDir, "pending"));
    const callCount = countJsonFiles(join(dataDir, "calls"));
    const serverStatus = checkPid("server.pid", dataDir);
    const tunnelUrl = readTunnelUrl(dataDir);
    const lines = [
        `SecondAxis Voice Pipeline`,
        `  Phase: ${phase} (${currentState})`,
        `  Active spec: ${activeSpec}`,
        `  Server: ${serverStatus}`,
        `  Tunnel: ${tunnelUrl}`,
        `  Pending calls: ${pendingCount}`,
        `  Total calls: ${callCount}`,
        `  Specs: ${activeSpecs.length} active, ${completeSpecs.length} complete`,
        `  Whitelisted: ${wl.callers.length} callers`,
    ];
    // Print spec details if any exist
    if (specs.length > 0) {
        lines.push(`  ---`);
        for (const spec of specs) {
            const status = spec.complete ? "complete" : "active";
            const artifacts = [];
            if (spec.artifacts.intent)
                artifacts.push("intent");
            if (spec.artifacts.hld)
                artifacts.push("hld");
            if (spec.artifacts.adr)
                artifacts.push("adr");
            if (spec.artifacts.eis)
                artifacts.push("eis");
            lines.push(`  ${spec.name} [${status}] artifacts=[${artifacts.join(",")}] blockers=${spec.blockerCount} revisions=${spec.revisionCount}`);
        }
    }
    process.stdout.write(lines.join("\n") + "\n");
}
main();
