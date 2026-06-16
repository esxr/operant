---
description: Start the operant-pi voice pipeline (webhook server + tunnel + Retell registration)
allowed-tools: Bash(node:*), Bash(bash:*), Bash(cat:*), Bash(echo:*)
---

Start the operant-pi pipeline by running the startup sequence:

1. Start the webhook server:
!`npx tsx ${CLAUDE_PLUGIN_ROOT}/scripts/server.ts &`

2. Start the cloudflare tunnel:
!`bash ${CLAUDE_PLUGIN_ROOT}/scripts/tunnel.sh start`

3. Register the webhook URL with Retell:
!`node ${CLAUDE_PLUGIN_ROOT}/lib/cli/register-webhook.js $(cat ${OPERANT_PI_DATA_DIR:-spec/.operant}/tunnel_url.txt)`

4. Show the tunnel URL, server PID, and current pipeline state:
!`node ${CLAUDE_PLUGIN_ROOT}/lib/cli/status.js`
