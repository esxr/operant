#!/usr/bin/env node
/**
 * @module cli/register-webhook
 *
 * Usage: node lib/cli/register-webhook.js [tunnel-url]
 *
 * Registers the webhook URL with Retell.ai for call completion events.
 * Reads the tunnel URL from the CLI argument or from $DATA_DIR/tunnel_url.txt.
 *
 * Exit 0 on success, 1 on error, 2 on usage error.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { updateAgentWebhook, getAgentId } from "../retell.js";
import { getDataDir } from "../config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadTunnelUrl(dataDir: string): string | null {
  const urlPath = join(dataDir, "tunnel_url.txt");
  try {
    const url = readFileSync(urlPath, "utf-8").trim();
    return url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Resolve tunnel URL: CLI arg > file > env
  let tunnelUrl: string | null = args[0] ?? null;

  if (!tunnelUrl) {
    const dataDir = getDataDir();
    tunnelUrl = loadTunnelUrl(dataDir);
  }

  if (!tunnelUrl) {
    tunnelUrl = process.env.OPERANT_PI_TUNNEL_URL ?? null;
  }

  if (!tunnelUrl) {
    process.stderr.write(
      "Usage: node lib/cli/register-webhook.js [tunnel-url]\n" +
      "\n" +
      "No tunnel URL provided. Either:\n" +
      "  1. Pass it as an argument\n" +
      "  2. Write it to $DATA_DIR/tunnel_url.txt\n" +
      "  3. Set OPERANT_PI_TUNNEL_URL env var\n",
    );
    process.exit(2);
  }

  // Build webhook URL
  const webhookUrl = `${tunnelUrl.replace(/\/+$/, "")}/webhook/call-completed`;

  // Get agent ID
  let agentId: string;
  try {
    agentId = getAgentId();
  } catch (err) {
    process.stderr.write(`Failed to get agent ID: ${(err as Error).message}\n`);
    process.exit(1);
    return;
  }

  process.stderr.write(`Registering webhook with Retell.ai:\n`);
  process.stderr.write(`  Agent ID: ${agentId}\n`);
  process.stderr.write(`  Webhook URL: ${webhookUrl}\n`);

  try {
    const result = await updateAgentWebhook(agentId, webhookUrl);

    process.stdout.write(JSON.stringify({
      success: true,
      agentId,
      webhookUrl,
      response: result,
    }, null, 2) + "\n");
  } catch (err) {
    process.stderr.write(`Failed to register webhook: ${(err as Error).message}\n`);
    process.stdout.write(JSON.stringify({
      success: false,
      agentId,
      webhookUrl,
      error: (err as Error).message,
    }, null, 2) + "\n");
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
