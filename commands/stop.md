---
description: Stop the operant-pi voice pipeline (kill server, tunnel, clean PIDs)
allowed-tools: Bash(bash:*), Bash(cat:*), Bash(kill:*)
---

Stop the operant-pi pipeline:

1. Stop GitHub poller (if running):
!`bash -c 'DATA_DIR="${OPERANT_PI_DATA_DIR:-spec/.operant}"; PID_FILE="$DATA_DIR/github-poller.pid"; if [ -f "$PID_FILE" ]; then PID=$(cat "$PID_FILE"); kill "$PID" 2>/dev/null && echo "[stop] GitHub poller stopped (PID: $PID)" || echo "[stop] GitHub poller already dead"; rm -f "$PID_FILE"; else echo "[stop] No GitHub poller PID file"; fi'`

2. Stop server and tunnel:
!`bash ${CLAUDE_PLUGIN_ROOT}/scripts/cleanup.sh`

Report what was stopped (server PID, tunnel PID, poller PID) and confirm the pipeline is fully shut down.
