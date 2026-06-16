#!/usr/bin/env node
/**
 * @module cli/process-trigger
 *
 * Usage: node lib/cli/process-trigger.js <trigger-file-path>
 *
 * Processes a call/WhatsApp trigger file and runs FSM transitions.
 * This is the core pipeline entry point: reads trigger JSON, classifies
 * the transcript, and drives the state machine forward.
 *
 * Exit 0 on success, 1 on error, 2 on usage error.
 */
export {};
