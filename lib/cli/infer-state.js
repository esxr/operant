#!/usr/bin/env node
/**
 * @module cli/infer-state
 *
 * Usage: node lib/cli/infer-state.js [specsRoot]
 *
 * Infers the current FSM state from the filesystem and prints both
 * the fine-grained state and coarse phase.
 *
 * If specsRoot is not provided, uses getSpecsRoot() from config.
 */
import { inferState, stateToPhase } from "../state-machine.js";
import { getSpecsRoot } from "../config.js";
function main() {
    const specsRoot = process.argv[2] ?? getSpecsRoot();
    const state = inferState(specsRoot);
    const phase = stateToPhase(state);
    process.stdout.write(JSON.stringify({ state, phase }, null, 2) + "\n");
}
main();
