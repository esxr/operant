#!/usr/bin/env node
/**
 * @module cli/transition
 *
 * Usage: node lib/cli/transition.js <EVENT> [key=value...]
 *
 * Reads current state from data dir, executes an FSM transition,
 * writes new state, and outputs the result as JSON.
 *
 * Exit 0 on success, 1 on InvalidTransitionError, 2 on usage error.
 */
export {};
