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

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  transition,
  InvalidTransitionError,
  type FSMEvent,
  type State,
} from "../state-machine.js";

import {
  getDataDir,
  readState,
  writeState,
  readActiveSpec,
} from "../config.js";

function main(): void {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    process.stderr.write(
      "Usage: node lib/cli/transition.js <EVENT> [key=value...]\n" +
      "\n" +
      "Events: CALL_RECEIVED, CALL_COMPLETED, NEW_REQUIREMENTS,\n" +
      "  CONFIRMATION_RECEIVED, REJECTED, ARTIFACT_PRODUCED,\n" +
      "  REVIEW_APPROVED, REVIEW_REJECTED, DEV_COMPLETE,\n" +
      "  BLOCKER_DETECTED, BLOCKER_RESOLVED, AUDIT_PASSED,\n" +
      "  AUDIT_FAILED, REVISION_READY, USER_CONFIRMED,\n" +
      "  USER_REJECTED, RESET, DEMO_READY, USER_JOINED_MEET,\n" +
      "  WALKTHROUGH_COMPLETE, DEMO_APPROVED, DEMO_REJECTED,\n" +
      "  DEMO_SKIPPED, DEMO_FAILED\n",
    );
    process.exit(2);
  }

  const event = args[0] as FSMEvent;

  // Parse key=value context pairs
  const context: Record<string, string> = {};
  for (const arg of args.slice(1)) {
    const eqIdx = arg.indexOf("=");
    if (eqIdx > 0) {
      context[arg.substring(0, eqIdx)] = arg.substring(eqIdx + 1);
    }
  }

  // Auto-inject specDir from active-spec.txt if not provided
  if (!context.specDir) {
    const activeSpec = readActiveSpec();
    if (activeSpec) {
      context.specDir = activeSpec;
    }
  }

  const currentState = readState();

  try {
    const result = transition(currentState, event, context);

    // Write new state
    writeState(result.to);

    // Write pending side effects for hook scripts to process
    const dataDir = getDataDir();
    mkdirSync(dataDir, { recursive: true });
    const effectsPath = join(dataDir, "pending-effects.json");
    writeFileSync(effectsPath, JSON.stringify(result.sideEffects, null, 2) + "\n");

    // Print result as JSON
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exit(0);
  } catch (err) {
    if (err instanceof InvalidTransitionError) {
      process.stderr.write(`${err.message}\n`);
      process.stdout.write(JSON.stringify({
        error: "InvalidTransition",
        from: err.from,
        event: err.event,
        message: err.message,
      }, null, 2) + "\n");
      process.exit(1);
    }
    throw err;
  }
}

main();
