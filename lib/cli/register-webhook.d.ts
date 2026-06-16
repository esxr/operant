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
export {};
