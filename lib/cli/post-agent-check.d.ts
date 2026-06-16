#!/usr/bin/env node
/**
 * @module cli/post-agent-check
 *
 * Usage: node lib/cli/post-agent-check.js [currentState]
 *
 * Given a state, inspects the active spec's filesystem to detect:
 * - New SDLC artifacts (for ARTIFACT_PRODUCED transitions)
 * - New blockers (for BLOCKER_DETECTED transitions)
 * - New revisions (for REVISION_READY transitions)
 * - Dev completion signals (for DEV_COMPLETE transitions)
 *
 * Prints what was found and what FSM transitions should happen.
 * Used by SubagentStop hook.
 */
export {};
