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

4. Start GitHub issue poller (if configured):
!`bash -c 'DATA_DIR="${OPERANT_PI_DATA_DIR:-spec/.operant}"; if [ -n "${GITHUB_REPO:-}" ] && [ -n "${GITHUB_TOKEN:-}" ] && [ -n "${TWILIO_WHATSAPP_RECIPIENT:-}" ]; then node ${CLAUDE_PLUGIN_ROOT}/lib/cli/poll-github.js & echo $! > "$DATA_DIR/github-poller.pid"; echo "[start] GitHub poller started (PID: $!, repo: $GITHUB_REPO)"; else echo "[start] GitHub poller skipped (GITHUB_REPO, GITHUB_TOKEN, or TWILIO_WHATSAPP_RECIPIENT not set)"; fi'`

5. Show the tunnel URL, server PID, and current pipeline state:
!`node ${CLAUDE_PLUGIN_ROOT}/lib/cli/status.js`
