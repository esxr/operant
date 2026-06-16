---
description: Activate paid cloud mode by entering your Operant API key
argument-hint: [api-key]
allowed-tools: Bash, Read, Write
---

Activate paid cloud mode for the Operant plugin.

Steps:
1. If an API key was provided as the argument, use it. Otherwise, ask the user for their API key.
2. Verify the key against the server:
   ```bash
   curl -s -w "\n%{http_code}" -H "Authorization: Bearer $KEY" https://api.operantlabs.com/api/auth/verify
   ```
3. If valid (HTTP 200):
   - Parse the response to get the user's phone number and email
   - Append `OPERANT_API_KEY=<key>` to the `.env` file in the plugin root (`${CLAUDE_PLUGIN_ROOT}/.env`)
   - Report: "Cloud mode activated. Your dedicated phone number is <number>. Restart the session to apply."
4. If invalid (HTTP 401):
   - Report: "Invalid API key. Get one at https://operantlabs.com"
5. If server unreachable:
   - Report: "Could not reach api.operantlabs.com. The plugin will continue in local/mock mode."
