#!/usr/bin/env node
/**
 * @module cli/whitelist
 *
 * Usage: node lib/cli/whitelist.js <list|add|remove> [phone] [name...]
 *
 * Manages the whitelist.json file in the data directory.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "../config.js";
function loadWhitelist(dataDir) {
    const whitelistPath = join(dataDir, "whitelist.json");
    try {
        return JSON.parse(readFileSync(whitelistPath, "utf-8"));
    }
    catch {
        return { callers: [], default_blocker_target: "" };
    }
}
function saveWhitelist(dataDir, wl) {
    mkdirSync(dataDir, { recursive: true });
    const whitelistPath = join(dataDir, "whitelist.json");
    writeFileSync(whitelistPath, JSON.stringify(wl, null, 2) + "\n");
}
function main() {
    const args = process.argv.slice(2);
    const action = args[0];
    const rest = args.slice(1);
    const dataDir = getDataDir();
    switch (action) {
        case "list": {
            const wl = loadWhitelist(dataDir);
            if (wl.callers.length === 0) {
                process.stdout.write("No callers whitelisted.\n");
                return;
            }
            const lines = wl.callers.map((c) => `  ${c.phone} - ${c.name} (${c.role})${c.note ? ` [${c.note}]` : ""}`);
            process.stdout.write([
                `Whitelisted callers (${wl.callers.length}):`,
                ...lines,
                `Default blocker target: ${wl.default_blocker_target}`,
            ].join("\n") + "\n");
            return;
        }
        case "add": {
            const [phone, ...nameParts] = rest;
            if (!phone) {
                process.stderr.write("Usage: node lib/cli/whitelist.js add <phone> <name>\n");
                process.exit(2);
            }
            const name = nameParts.length > 0 ? nameParts.join(" ") : "Unknown";
            const wl = loadWhitelist(dataDir);
            if (wl.callers.some((c) => c.phone === phone)) {
                process.stdout.write(`${phone} is already whitelisted.\n`);
                return;
            }
            wl.callers.push({
                phone,
                name,
                role: "caller",
                added: new Date().toISOString().slice(0, 10),
            });
            saveWhitelist(dataDir, wl);
            process.stdout.write(`Added ${phone} (${name}) to whitelist.\n`);
            return;
        }
        case "remove": {
            const phone = rest[0];
            if (!phone) {
                process.stderr.write("Usage: node lib/cli/whitelist.js remove <phone>\n");
                process.exit(2);
            }
            const wl = loadWhitelist(dataDir);
            const before = wl.callers.length;
            wl.callers = wl.callers.filter((c) => c.phone !== phone);
            if (wl.callers.length === before) {
                process.stdout.write(`${phone} was not in the whitelist.\n`);
                return;
            }
            saveWhitelist(dataDir, wl);
            process.stdout.write(`Removed ${phone} from whitelist.\n`);
            return;
        }
        default:
            process.stderr.write("Usage: node lib/cli/whitelist.js <list|add|remove> [phone] [name...]\n");
            process.exit(2);
    }
}
main();
