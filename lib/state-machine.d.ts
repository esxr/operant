/**
 * @module state-machine
 *
 * Hardcoded finite state machine for the operant-pi voice pipeline.
 * All transitions are deterministic TypeScript code -- no LLM judgment
 * controls phase changes. Side effects are RETURNED, not executed.
 *
 * Dependencies: node:fs, node:path only (no Pi API dependency).
 */
/** Coarse phase groups for skill loading and context injection. */
export type Phase = "idle" | "triage" | "sdlc" | "dev" | "audit" | "demo" | "confirmation";
/** Fine-grained FSM states. */
export type State = "idle" | "call_active" | "triage" | "sdlc_intent" | "sdlc_hld" | "sdlc_adr" | "sdlc_eis" | "sdlc_review" | "dev" | "dev_blocked" | "audit" | "audit_failed" | "demo_setup" | "demo_calling" | "demo_active" | "demo_feedback" | "confirmation" | "complete";
/** Events that trigger state transitions. */
export type FSMEvent = "CALL_RECEIVED" | "CALL_COMPLETED" | "NEW_REQUIREMENTS" | "CONFIRMATION_RECEIVED" | "REJECTED" | "ARTIFACT_PRODUCED" | "REVIEW_APPROVED" | "REVIEW_REJECTED" | "DEV_COMPLETE" | "BLOCKER_DETECTED" | "BLOCKER_RESOLVED" | "AUDIT_PASSED" | "AUDIT_FAILED" | "REVISION_READY" | "USER_CONFIRMED" | "USER_REJECTED" | "RESET" | "DEMO_READY" | "USER_JOINED_MEET" | "WALKTHROUGH_COMPLETE" | "DEMO_APPROVED" | "DEMO_REJECTED" | "DEMO_SKIPPED" | "DEMO_FAILED" | "ISSUE_RECEIVED";
/** Side effects emitted by transitions. */
export type SideEffect = {
    type: "CREATE_SPEC_DIR";
    name: string;
} | {
    type: "WRITE_REQUIREMENTS";
    specDir: string;
    content: string;
} | {
    type: "TRIGGER_REVIEW_CALL";
    specDir: string;
    artifactType: string;
    artifactSummary: string;
} | {
    type: "TRIGGER_BLOCKER_CALL";
    specDir: string;
    blockerPath: string;
} | {
    type: "TRIGGER_CONFIRMATION_CALL";
    specDir: string;
} | {
    type: "LOAD_SKILL";
    phase: Phase;
} | {
    type: "LAUNCH_AGENT";
    phase: Phase;
    specDir: string;
    context: string;
} | {
    type: "MARK_COMPLETE";
    specDir: string;
} | {
    type: "EMIT_EVENT";
    name: string;
    payload: Record<string, unknown>;
} | {
    type: "CREATE_DEMO";
    specDir: string;
} | {
    type: "TRIGGER_DEMO_INVITE_CALL";
    specDir: string;
    meetUrl: string;
    meetCode: string;
} | {
    type: "START_WALKTHROUGH";
    specDir: string;
} | {
    type: "CAPTURE_FEEDBACK";
} | {
    type: "WRITE_DEMO_REVISION";
    specDir: string;
    painPoints: string[];
} | {
    type: "TEARDOWN_DEMO";
};
/** Transition result returned by `transition()`. */
export interface TransitionResult {
    from: State;
    to: State;
    event: FSMEvent;
    sideEffects: SideEffect[];
}
/** Spec directory status. */
export interface SpecStatus {
    name: string;
    path: string;
    complete: boolean;
    artifacts: {
        requirements: boolean;
        intent: boolean;
        hld: boolean;
        adr: boolean;
        eis: boolean;
    };
    blockerCount: number;
    revisionCount: number;
}
/**
 * Thrown when a transition is not valid from the current state.
 */
export declare class InvalidTransitionError extends Error {
    readonly from: State;
    readonly event: FSMEvent;
    constructor(from: State, event: FSMEvent);
}
/**
 * Map a fine-grained State to its coarse Phase group.
 *
 * @param state - The fine-grained FSM state
 * @returns The coarse phase group
 */
export declare function stateToPhase(state: State): Phase;
/**
 * Validate and execute a state transition.
 * Returns the new state and any side effects. Side effects are data
 * describing actions -- the caller is responsible for executing them.
 *
 * @param current - Current FSM state
 * @param event - The triggering event
 * @param context - Optional context (spec name, transcript, etc.)
 * @returns TransitionResult with new state and side effects
 * @throws InvalidTransitionError if the transition is not in the table
 */
export declare function transition(current: State, event: FSMEvent, context?: Record<string, string>): TransitionResult;
/**
 * Find the active (non-complete) spec directory.
 * Returns null if all specs are complete or no specs exist.
 * Only considers directories that contain a REQUIREMENTS.md file.
 *
 * @param specsRoot - Absolute path to `spec/` directory
 * @returns Absolute path to active spec dir, or null
 */
export declare function getCurrentSpec(specsRoot: string): string | null;
/**
 * Get status of all spec directories.
 *
 * @param specsRoot - Absolute path to `spec/` directory
 * @returns Array of SpecStatus objects
 */
export declare function listSpecs(specsRoot: string): SpecStatus[];
/**
 * Detect new blocker files by comparing current state to a known set.
 *
 * @param specDir - Absolute path to the active spec directory
 * @param knownBlockers - Array of previously known blocker filenames
 * @returns Array of NEW blocker filenames (not in knownBlockers)
 */
export declare function detectNewBlockers(specDir: string, knownBlockers: string[]): string[];
/**
 * Detect new revision files by comparing current state to a known set.
 *
 * @param specDir - Absolute path to the active spec directory
 * @param knownRevisions - Array of previously known revision filenames
 * @returns Array of NEW revision filenames
 */
export declare function detectNewRevisions(specDir: string, knownRevisions: string[]): string[];
/**
 * Classify a call transcript as "requirements", "confirmation", or "unknown".
 * Uses keyword heuristics and call analysis data.
 *
 * Heuristic rules (checked in order):
 * 1. If callAnalysis has call_summary (top-level or under custom_analysis_data)
 *    -> "requirements" (Retell already determined this is substantive)
 * 2. If transcript contains 2+ standalone confirmation keywords:
 *    "looks good", "confirmed", "approved", "ship it", "satisfied",
 *    plus standalone "done"/"yes" -> "confirmation"
 * 3. If transcript contains 1+ requirement-indicating keywords:
 *    "requirements", "spec", "build", "feature", "implement", "solve",
 *    "fix", "create", "want", "need", "should", "must", "problem",
 *    "solution", "goal", "constraint" -> "requirements"
 * 4. If transcript has any non-trivial content (> 20 chars) -> "requirements"
 *    (default to requirements for anything substantive -- better to over-classify
 *    than to drop a real call)
 * 5. Otherwise -> "unknown"
 *
 * @param transcript - Raw call transcript text
 * @param callAnalysis - Optional structured call analysis from Retell
 * @returns "requirements" | "confirmation" | "unknown"
 */
export declare function classifyTranscript(transcript: string, callAnalysis?: Record<string, unknown>): "requirements" | "confirmation" | "unknown";
/**
 * Derive a kebab-case spec directory name from a feature description.
 *
 * @param featureName - Human-readable feature name or title
 * @returns kebab-case slug (max 50 chars, alphanumeric + hyphens only)
 */
export declare function deriveSpecName(featureName: string): string;
/**
 * Infer the current pipeline phase from the filesystem state.
 * Used for crash recovery and session resume (NFC-2).
 *
 * @param specsRoot - Absolute path to the `spec/` directory
 * @returns The inferred coarse Phase
 */
export declare function inferPhase(specsRoot: string): Phase;
/**
 * Infer the current fine-grained FSM state from the filesystem.
 * Supports crash recovery by reading directory structure.
 *
 * Algorithm (checked in order, first match wins):
 * 1. No directories in spec/ (excluding .operant/) -> idle
 * 2. Active spec dir exists (REQUIREMENTS.md without STATUS: complete):
 *    a. blockers/ has files newer than last dev start -> dev_blocked
 *    b. revisions/ has files newer than last audit start -> audit_failed
 *    c. implementation-spec.md exists AND revisions/ exists -> dev (re-enter)
 *    d. implementation-spec.md exists AND no revisions/ -> dev (first run)
 *    e. adr-lite.md exists but no implementation-spec.md -> sdlc_eis
 *    f. high-level-design.md exists but no adr-lite.md -> sdlc_adr
 *    g. intent-and-constraints.md exists but no high-level-design.md -> sdlc_hld
 *    h. REQUIREMENTS.md exists but no intent-and-constraints.md -> sdlc_intent
 * 3. All specs have STATUS: complete -> idle
 *
 * Limitation: Cannot distinguish sdlc_review from artifact-production state.
 * On crash recovery, re-enters the artifact production state which re-triggers
 * the review call. This is acceptable (extra confirmation call is harmless).
 *
 * @param specsRoot - Absolute path to the `spec/` directory
 * @returns The inferred State
 */
export declare function inferState(specsRoot: string): State;
