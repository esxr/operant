---
description: Show current operant-pi pipeline status
allowed-tools: Bash(node:*), Bash(cat:*), Bash(ls:*)
---

Show pipeline status:
!`node ${CLAUDE_PLUGIN_ROOT}/lib/cli/status.js`

Display:
- Running: yes/no
- Server PID
- Tunnel URL
- FSM state and phase
- Active spec
- Pending calls count
- Blocker/revision counts
- Whitelisted callers
