/**
 * @module cli/poll-triggers
 *
 * Background poller for cloud mode. Fetches triggers from operant-api
 * and writes them to local pending/ directory.
 *
 * Usage: node lib/cli/poll-triggers.js
 * Started by startup.sh in cloud mode. PID written to $DATA_DIR/poller.pid.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import https from 'node:https';
import { getDataDir, ensureDataDir, getOperantApiKey, getOperantApiUrl } from '../config.js';
const POLL_INTERVAL = 5000; // 5 seconds
let lastTimestamp = new Date(Date.now() - 60000).toISOString(); // start 1 min ago
function httpGet(url, apiKey) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const req = https.request({
            hostname: parsed.hostname,
            port: parsed.port ? Number(parsed.port) : 443,
            path: parsed.pathname + parsed.search,
            method: 'GET',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                Accept: 'application/json',
            },
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 400) {
                    reject(new Error(`Poll error ${res.statusCode}: ${data}`));
                    return;
                }
                resolve(data);
            });
        });
        req.on('error', (err) => reject(new Error(`Poll request failed: ${err.message}`)));
        req.end();
    });
}
async function poll() {
    const apiUrl = getOperantApiUrl();
    const apiKey = getOperantApiKey();
    if (!apiKey) {
        process.exit(0); // no key = local mode, shouldn't be running
    }
    const url = `${apiUrl}/api/triggers/poll?since=${encodeURIComponent(lastTimestamp)}&limit=10`;
    try {
        const data = await httpGet(url, apiKey);
        const parsed = JSON.parse(data);
        const triggers = parsed.triggers ?? [];
        if (triggers.length > 0) {
            const pendingDir = join(getDataDir(), 'pending');
            mkdirSync(pendingDir, { recursive: true });
            for (const trigger of triggers) {
                const filename = `${trigger.id}.json`;
                writeFileSync(join(pendingDir, filename), JSON.stringify(trigger.payload, null, 2));
                lastTimestamp = trigger.created_at;
            }
            process.stderr.write(`[poller] Fetched ${triggers.length} trigger(s)\n`);
        }
    }
    catch (err) {
        process.stderr.write(`[poller] Error: ${err.message}\n`);
    }
}
// Main
ensureDataDir();
writeFileSync(join(getDataDir(), 'poller.pid'), String(process.pid));
setInterval(poll, POLL_INTERVAL);
poll(); // immediate first poll
