---
description: Stop the operant-pi voice pipeline (kill server, tunnel, clean PIDs)
allowed-tools: Bash(bash:*), Bash(cat:*), Bash(kill:*)
---

Stop the operant-pi pipeline by running the cleanup script:

!`bash ${CLAUDE_PLUGIN_ROOT}/scripts/cleanup.sh`

Report what was stopped (server PID, tunnel PID) and confirm the pipeline is fully shut down.
