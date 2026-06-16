/**
 * @module config
 *
 * Shared configuration helpers for CLI scripts.
 * Reads paths from environment variables and provides state file I/O.
 */
import type { State } from "./state-machine.js";
/**
 * Get the data directory path.
 * Reads OPERANT_PI_DATA_DIR env var, defaults to $PWD/spec/.operant.
 */
export declare function getDataDir(): string;
/**
 * Get the internal specs root directory (parent of data dir).
 * Used for pipeline state management — NOT for SDLC artifact output.
 */
export declare function getSpecsRoot(): string;
/**
 * Get the specs output directory where SDLC artifacts are written.
 * Reads OPERANT_PI_SPECS_DIR env var, defaults to $PROJECT_ROOT/docs/specs.
 */
export declare function getSpecsOutputDir(): string;
/**
 * Get the project root directory.
 * Reads OPERANT_PI_PROJECT_ROOT env var, defaults to process.cwd().
 */
export declare function getProjectRoot(): string;
/**
 * Ensure the data directory and its standard subdirectories exist.
 */
export declare function ensureDataDir(): void;
/**
 * Read the current FSM state from current-state.txt.
 * Returns "idle" if the file is missing or unreadable.
 */
export declare function readState(): State;
/**
 * Write the current FSM state to current-state.txt.
 */
export declare function writeState(state: State): void;
/**
 * Read the active spec name from active-spec.txt.
 * Returns null if the file is missing or empty.
 */
export declare function readActiveSpec(): string | null;
/**
 * Write the active spec name to active-spec.txt.
 */
export declare function writeActiveSpec(name: string): void;
/**
 * Get the Operant API key for cloud mode.
 * Returns null if not set (local mode).
 */
export declare function getOperantApiKey(): string | null;
/**
 * Get the Operant API URL.
 */
export declare function getOperantApiUrl(): string;
/**
 * Get the current operating mode.
 * 'cloud' = proxied through operant-api, 'local' = direct Retell/Twilio calls.
 */
export declare function getMode(): 'cloud' | 'local';
