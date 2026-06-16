#!/usr/bin/env node
/**
 * @module cli/trigger-gate
 *
 * Usage: node lib/cli/trigger-gate.js <mode> [artifactType] [specDir]
 *
 * Triggers an outbound call or WhatsApp message for a human gate
 * (review, blocker, confirmation). Blocks until a reply arrives
 * via filesystem polling, then runs the appropriate FSM transition.
 *
 * Cross-process communication: The webhook server writes reply trigger
 * files to $DATA_DIR/pending/. This script polls that directory for
 * new files, parses the reply, and transitions the FSM.
 *
 * Exit 0 on success, 1 on error, 2 on usage error.
 */
export {};
