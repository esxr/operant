/**
 * @module state-machine
 *
 * Hardcoded finite state machine for the operant-pi voice pipeline.
 * All transitions are deterministic TypeScript code -- no LLM judgment
 * controls phase changes. Side effects are RETURNED, not executed.
 *
 * Dependencies: node:fs, node:path only (no Pi API dependency).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Coarse phase groups for skill loading and context injection. */
export type Phase = "idle" | "triage" | "sdlc" | "dev" | "audit" | "demo" | "confirmation";

/** Fine-grained FSM states. */
export type State =
  | "idle"
  | "call_active"
  | "triage"
  | "sdlc_intent"
  | "sdlc_hld"
  | "sdlc_adr"
  | "sdlc_eis"
  | "sdlc_review"
  | "dev"
  | "dev_blocked"
  | "audit"
  | "audit_failed"
  | "demo_setup"
  | "demo_calling"
  | "demo_active"
  | "demo_feedback"
  | "confirmation"
  | "complete";

/** Events that trigger state transitions. */
export type FSMEvent =
  | "CALL_RECEIVED"
  | "CALL_COMPLETED"
  | "NEW_REQUIREMENTS"
  | "CONFIRMATION_RECEIVED"
  | "REJECTED"
  | "ARTIFACT_PRODUCED"
  | "REVIEW_APPROVED"
  | "REVIEW_REJECTED"
  | "DEV_COMPLETE"
  | "BLOCKER_DETECTED"
  | "BLOCKER_RESOLVED"
  | "AUDIT_PASSED"
  | "AUDIT_FAILED"
  | "REVISION_READY"
  | "USER_CONFIRMED"
  | "USER_REJECTED"
  | "RESET"
  | "DEMO_READY"
  | "USER_JOINED_MEET"
  | "WALKTHROUGH_COMPLETE"
  | "DEMO_APPROVED"
  | "DEMO_REJECTED"
  | "DEMO_SKIPPED"
  | "DEMO_FAILED";

/** Side effects emitted by transitions. */
export type SideEffect =
  | { type: "CREATE_SPEC_DIR"; name: string }
  | { type: "WRITE_REQUIREMENTS"; specDir: string; content: string }
  | { type: "TRIGGER_REVIEW_CALL"; specDir: string; artifactType: string; artifactSummary: string }
  | { type: "TRIGGER_BLOCKER_CALL"; specDir: string; blockerPath: string }
  | { type: "TRIGGER_CONFIRMATION_CALL"; specDir: string }
  | { type: "LOAD_SKILL"; phase: Phase }
  | { type: "LAUNCH_AGENT"; phase: Phase; specDir: string; context: string }
  | { type: "MARK_COMPLETE"; specDir: string }
  | { type: "EMIT_EVENT"; name: string; payload: Record<string, unknown> }
  | { type: "CREATE_DEMO"; specDir: string }
  | { type: "TRIGGER_DEMO_INVITE_CALL"; specDir: string; meetUrl: string; meetCode: string }
  | { type: "START_WALKTHROUGH"; specDir: string }
  | { type: "CAPTURE_FEEDBACK" }
  | { type: "WRITE_DEMO_REVISION"; specDir: string; painPoints: string[] }
  | { type: "TEARDOWN_DEMO" };

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

// ---------------------------------------------------------------------------
// Custom Error
// ---------------------------------------------------------------------------

/**
 * Thrown when a transition is not valid from the current state.
 */
export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: State,
    public readonly event: FSMEvent,
  ) {
    super(`Invalid transition: cannot handle event "${event}" in state "${from}"`);
    this.name = "InvalidTransitionError";
  }
}

// ---------------------------------------------------------------------------
// Internal: SDLC artifact mapping
// ---------------------------------------------------------------------------

/** Maps SDLC production states to their artifact filenames. */
const SDLC_ARTIFACT_FILES: Record<string, string> = {
  sdlc_intent: "intent-and-constraints.md",
  sdlc_hld: "high-level-design.md",
  sdlc_adr: "adr-lite.md",
  sdlc_eis: "implementation-spec.md",
};

/** Maps SDLC production states to short artifact type names for review calls. */
const SDLC_ARTIFACT_TYPES: Record<string, string> = {
  sdlc_intent: "intent",
  sdlc_hld: "hld",
  sdlc_adr: "adr",
  sdlc_eis: "eis",
};

/** Ordered SDLC progression: intent -> hld -> adr -> eis -> dev. */
const SDLC_ORDER: State[] = ["sdlc_intent", "sdlc_hld", "sdlc_adr", "sdlc_eis"];

/**
 * Given an SDLC production state, return the next state after review approval.
 * intent -> hld, hld -> adr, adr -> eis, eis -> dev.
 */
function nextSdlcState(current: State): State {
  const idx = SDLC_ORDER.indexOf(current);
  if (idx < 0 || idx >= SDLC_ORDER.length - 1) return "dev";
  return SDLC_ORDER[idx + 1];
}

// ---------------------------------------------------------------------------
// Internal: Transition table context type
// ---------------------------------------------------------------------------

interface TransitionEntry {
  to: State | ((ctx: Record<string, string>) => State);
  sideEffects: (ctx: Record<string, string>) => SideEffect[];
}

// ---------------------------------------------------------------------------
// Transition Table
// ---------------------------------------------------------------------------

/**
 * The canonical transition table. 21 transitions across 14 states.
 * Side effects are returned as data, never executed.
 */
const TRANSITIONS: Map<State, Map<FSMEvent, TransitionEntry>> = new Map([
  // T1: idle -> call_active on CALL_RECEIVED
  ["idle", new Map<FSMEvent, TransitionEntry>([
    ["CALL_RECEIVED", {
      to: "call_active",
      sideEffects: (ctx) => [
        { type: "EMIT_EVENT", name: "log", payload: { message: "Call started", callId: ctx.callId ?? "unknown" } },
      ],
    }],
  ])],

  // T2: call_active -> triage on CALL_COMPLETED
  ["call_active", new Map<FSMEvent, TransitionEntry>([
    ["CALL_COMPLETED", {
      to: "triage",
      sideEffects: (ctx) => [
        { type: "EMIT_EVENT", name: "secondaxis:call-completed", payload: {
          callId: ctx.callId ?? "",
          callerName: ctx.callerName ?? "",
          fromNumber: ctx.fromNumber ?? "",
          triggerFile: ctx.triggerFile ?? "",
          triggerPath: ctx.triggerPath ?? "",
        }},
      ],
    }],
  ])],

  // T3, T4, T5: triage -> sdlc_intent | complete | idle
  ["triage", new Map<FSMEvent, TransitionEntry>([
    ["NEW_REQUIREMENTS", {
      to: "sdlc_intent",
      sideEffects: (ctx) => {
        const specName = ctx.specName ?? "unnamed-spec";
        const specDir = ctx.specDir ?? specName;
        const effects: SideEffect[] = [
          { type: "CREATE_SPEC_DIR", name: specName },
          { type: "WRITE_REQUIREMENTS", specDir, content: ctx.requirements ?? "" },
          { type: "LOAD_SKILL", phase: "sdlc" },
        ];
        return effects;
      },
    }],
    ["CONFIRMATION_RECEIVED", {
      to: "complete",
      sideEffects: (ctx) => {
        const specDir = ctx.specDir ?? "";
        return [
          { type: "MARK_COMPLETE", specDir },
        ];
      },
    }],
    ["REJECTED", {
      to: "idle",
      sideEffects: (ctx) => [
        { type: "EMIT_EVENT", name: "log", payload: { message: "Transcript rejected/unclassifiable", reason: ctx.reason ?? "unknown" } },
      ],
    }],
  ])],

  // T6: sdlc_intent -> sdlc_review on ARTIFACT_PRODUCED
  ["sdlc_intent", new Map<FSMEvent, TransitionEntry>([
    ["ARTIFACT_PRODUCED", {
      to: "sdlc_review",
      sideEffects: (ctx) => [
        { type: "TRIGGER_REVIEW_CALL", specDir: ctx.specDir ?? "", artifactType: "intent", artifactSummary: ctx.artifactSummary ?? "" },
      ],
    }],
  ])],

  // T7: sdlc_hld -> sdlc_review on ARTIFACT_PRODUCED
  ["sdlc_hld", new Map<FSMEvent, TransitionEntry>([
    ["ARTIFACT_PRODUCED", {
      to: "sdlc_review",
      sideEffects: (ctx) => [
        { type: "TRIGGER_REVIEW_CALL", specDir: ctx.specDir ?? "", artifactType: "hld", artifactSummary: ctx.artifactSummary ?? "" },
      ],
    }],
  ])],

  // T8: sdlc_adr -> sdlc_review on ARTIFACT_PRODUCED
  ["sdlc_adr", new Map<FSMEvent, TransitionEntry>([
    ["ARTIFACT_PRODUCED", {
      to: "sdlc_review",
      sideEffects: (ctx) => [
        { type: "TRIGGER_REVIEW_CALL", specDir: ctx.specDir ?? "", artifactType: "adr", artifactSummary: ctx.artifactSummary ?? "" },
      ],
    }],
  ])],

  // T9: sdlc_eis -> sdlc_review on ARTIFACT_PRODUCED
  ["sdlc_eis", new Map<FSMEvent, TransitionEntry>([
    ["ARTIFACT_PRODUCED", {
      to: "sdlc_review",
      sideEffects: (ctx) => [
        { type: "TRIGGER_REVIEW_CALL", specDir: ctx.specDir ?? "", artifactType: "eis", artifactSummary: ctx.artifactSummary ?? "" },
      ],
    }],
  ])],

  // T10, T11: sdlc_review -> next/prev sdlc state on REVIEW_APPROVED/REVIEW_REJECTED
  // T10 subsumes T12 (eis approval -> dev)
  ["sdlc_review", new Map<FSMEvent, TransitionEntry>([
    ["REVIEW_APPROVED", {
      to: (ctx) => {
        // ctx.reviewedArtifact tells us which artifact was under review
        const reviewed = ctx.reviewedArtifact as State | undefined;
        if (!reviewed || !SDLC_ORDER.includes(reviewed as State)) return "dev";
        return nextSdlcState(reviewed as State);
      },
      sideEffects: (ctx) => {
        const reviewed = ctx.reviewedArtifact as State | undefined;
        const next = reviewed && SDLC_ORDER.includes(reviewed as State)
          ? nextSdlcState(reviewed as State)
          : "dev" as State;
        const specDir = ctx.specDir ?? "";

        if (next === "dev") {
          // T12: EIS approved -> dev
          return [
            { type: "LOAD_SKILL", phase: "dev" },
            { type: "LAUNCH_AGENT", phase: "dev", specDir, context: "Full SDLC approved. Starting development." },
          ];
        }
        // T10: Advance to next SDLC phase
        return [
          { type: "LOAD_SKILL", phase: "sdlc" },
          { type: "LAUNCH_AGENT", phase: "sdlc", specDir, context: `Producing ${SDLC_ARTIFACT_FILES[next] ?? next}` },
        ];
      },
    }],
    ["REVIEW_REJECTED", {
      to: (ctx) => {
        // Re-enter the artifact phase that was under review
        const reviewed = ctx.reviewedArtifact as State | undefined;
        if (reviewed && SDLC_ORDER.includes(reviewed as State)) return reviewed as State;
        // Fallback: re-enter sdlc_intent if unknown
        return "sdlc_intent";
      },
      sideEffects: (ctx) => {
        const reviewed = ctx.reviewedArtifact ?? "sdlc_intent";
        const specDir = ctx.specDir ?? "";
        return [
          { type: "LOAD_SKILL", phase: "sdlc" },
          { type: "LAUNCH_AGENT", phase: "sdlc", specDir, context: `Revision requested for ${SDLC_ARTIFACT_FILES[reviewed] ?? reviewed}. Changes: ${ctx.revisionNotes ?? "none specified"}` },
        ];
      },
    }],
  ])],

  // T13, T14: dev -> dev_blocked | audit
  ["dev", new Map<FSMEvent, TransitionEntry>([
    ["BLOCKER_DETECTED", {
      to: "dev_blocked",
      sideEffects: (ctx) => [
        { type: "TRIGGER_BLOCKER_CALL", specDir: ctx.specDir ?? "", blockerPath: ctx.blockerPath ?? "" },
      ],
    }],
    ["DEV_COMPLETE", {
      to: "audit",
      sideEffects: (ctx) => {
        const specDir = ctx.specDir ?? "";
        return [
          { type: "LOAD_SKILL", phase: "audit" },
          { type: "LAUNCH_AGENT", phase: "audit", specDir, context: "Dev complete. Running visual verification." },
        ];
      },
    }],
  ])],

  // T15: dev_blocked -> dev on BLOCKER_RESOLVED
  ["dev_blocked", new Map<FSMEvent, TransitionEntry>([
    ["BLOCKER_RESOLVED", {
      to: "dev",
      sideEffects: (ctx) => {
        const specDir = ctx.specDir ?? "";
        return [
          { type: "LOAD_SKILL", phase: "dev" },
          { type: "LAUNCH_AGENT", phase: "dev", specDir, context: `Blocker resolved: ${ctx.resolution ?? "no details"}. Resuming dev.` },
        ];
      },
    }],
  ])],

  // T16, T18: audit -> audit_failed | confirmation
  ["audit", new Map<FSMEvent, TransitionEntry>([
    ["AUDIT_FAILED", {
      to: "audit_failed",
      sideEffects: (_ctx) => [
        // T16: Transition marker only -- no external side effects
        { type: "EMIT_EVENT", name: "log", payload: { message: "Audit failed. Revision required." } },
      ],
    }],
    ["AUDIT_PASSED", {
      to: "demo_setup",
      sideEffects: (ctx) => [
        { type: "CREATE_DEMO", specDir: ctx.specDir ?? "" },
      ],
    }],
  ])],

  // T17: audit_failed -> dev on REVISION_READY
  ["audit_failed", new Map<FSMEvent, TransitionEntry>([
    ["REVISION_READY", {
      to: "dev",
      sideEffects: (ctx) => {
        const specDir = ctx.specDir ?? "";
        return [
          { type: "LOAD_SKILL", phase: "dev" },
          { type: "LAUNCH_AGENT", phase: "dev", specDir, context: "Respawning dev with original spec + all revisions." },
        ];
      },
    }],
  ])],

  // T22: demo_setup -> demo_calling on DEMO_READY, or -> confirmation on DEMO_FAILED
  ["demo_setup", new Map<FSMEvent, TransitionEntry>([
    ["DEMO_READY", {
      to: "demo_calling",
      sideEffects: (ctx) => [
        { type: "TRIGGER_DEMO_INVITE_CALL", specDir: ctx.specDir ?? "", meetUrl: ctx.meetUrl ?? "", meetCode: ctx.meetCode ?? "" },
      ],
    }],
    ["DEMO_FAILED", {
      to: "confirmation",
      sideEffects: (ctx) => [
        { type: "TEARDOWN_DEMO" },
        { type: "TRIGGER_CONFIRMATION_CALL", specDir: ctx.specDir ?? "" },
        { type: "EMIT_EVENT", name: "log", payload: { message: `Demo setup failed: ${ctx.reason ?? "unknown"}. Falling back to voice confirmation.` } },
      ],
    }],
  ])],

  // T24, T28: demo_calling -> demo_active on USER_JOINED_MEET, or -> confirmation on DEMO_SKIPPED
  ["demo_calling", new Map<FSMEvent, TransitionEntry>([
    ["USER_JOINED_MEET", {
      to: "demo_active",
      sideEffects: (ctx) => [
        { type: "START_WALKTHROUGH", specDir: ctx.specDir ?? "" },
      ],
    }],
    ["DEMO_SKIPPED", {
      to: "confirmation",
      sideEffects: (ctx) => [
        { type: "TEARDOWN_DEMO" },
        { type: "TRIGGER_CONFIRMATION_CALL", specDir: ctx.specDir ?? "" },
      ],
    }],
  ])],

  // T25: demo_active -> demo_feedback on WALKTHROUGH_COMPLETE
  ["demo_active", new Map<FSMEvent, TransitionEntry>([
    ["WALKTHROUGH_COMPLETE", {
      to: "demo_feedback",
      sideEffects: () => [
        { type: "CAPTURE_FEEDBACK" },
      ],
    }],
  ])],

  // T26, T27: demo_feedback -> confirmation on DEMO_APPROVED, or -> dev on DEMO_REJECTED
  ["demo_feedback", new Map<FSMEvent, TransitionEntry>([
    ["DEMO_APPROVED", {
      to: "confirmation",
      sideEffects: (ctx) => [
        { type: "TEARDOWN_DEMO" },
        { type: "TRIGGER_CONFIRMATION_CALL", specDir: ctx.specDir ?? "" },
      ],
    }],
    ["DEMO_REJECTED", {
      to: "dev",
      sideEffects: (ctx) => {
        const specDir = ctx.specDir ?? "";
        const painPoints = (ctx.painPoints ?? "").split("\n").filter(Boolean);
        return [
          { type: "WRITE_DEMO_REVISION", specDir, painPoints },
          { type: "TEARDOWN_DEMO" },
          { type: "LOAD_SKILL", phase: "dev" },
          { type: "LAUNCH_AGENT", phase: "dev", specDir, context: `Demo rejected. Pain points: ${ctx.painPoints ?? "none specified"}` },
        ];
      },
    }],
  ])],

  // T19, T20: confirmation -> complete | dev
  ["confirmation", new Map<FSMEvent, TransitionEntry>([
    ["USER_CONFIRMED", {
      to: "complete",
      sideEffects: (ctx) => [
        { type: "MARK_COMPLETE", specDir: ctx.specDir ?? "" },
      ],
    }],
    ["USER_REJECTED", {
      to: "dev",
      sideEffects: (ctx) => {
        const specDir = ctx.specDir ?? "";
        return [
          { type: "LOAD_SKILL", phase: "dev" },
          { type: "LAUNCH_AGENT", phase: "dev", specDir, context: `User rejected. Pain points: ${ctx.painPoints ?? "none specified"}` },
        ];
      },
    }],
  ])],

  // T21: complete -> idle on RESET
  ["complete", new Map<FSMEvent, TransitionEntry>([
    ["RESET", {
      to: "idle",
      sideEffects: (_ctx) => [
        { type: "EMIT_EVENT", name: "log", payload: { message: "Pipeline reset. Returning to idle." } },
      ],
    }],
  ])],
]);

// ---------------------------------------------------------------------------
// Public Functions
// ---------------------------------------------------------------------------

/**
 * Map a fine-grained State to its coarse Phase group.
 *
 * @param state - The fine-grained FSM state
 * @returns The coarse phase group
 */
export function stateToPhase(state: State): Phase {
  switch (state) {
    case "idle":
    case "call_active":
    case "complete":
      return "idle";
    case "triage":
      return "triage";
    case "sdlc_intent":
    case "sdlc_hld":
    case "sdlc_adr":
    case "sdlc_eis":
    case "sdlc_review":
      return "sdlc";
    case "dev":
    case "dev_blocked":
      return "dev";
    case "audit":
    case "audit_failed":
      return "audit";
    case "demo_setup":
    case "demo_calling":
    case "demo_active":
    case "demo_feedback":
      return "demo";
    case "confirmation":
      return "confirmation";
  }
}

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
export function transition(
  current: State,
  event: FSMEvent,
  context?: Record<string, string>,
): TransitionResult {
  const stateMap = TRANSITIONS.get(current);
  if (!stateMap) {
    throw new InvalidTransitionError(current, event);
  }

  const entry = stateMap.get(event);
  if (!entry) {
    throw new InvalidTransitionError(current, event);
  }

  const ctx = context ?? {};
  const to = typeof entry.to === "function" ? entry.to(ctx) : entry.to;
  const sideEffects = entry.sideEffects(ctx);

  return { from: current, to, event, sideEffects };
}

/**
 * Find the active (non-complete) spec directory.
 * Returns null if all specs are complete or no specs exist.
 * Only considers directories that contain a REQUIREMENTS.md file.
 *
 * @param specsRoot - Absolute path to `spec/` directory
 * @returns Absolute path to active spec dir, or null
 */
export function getCurrentSpec(specsRoot: string): string | null {
  if (!existsSync(specsRoot)) return null;

  const entries = safeReaddir(specsRoot);
  for (const entry of entries) {
    if (entry === ".operant") continue;

    const specPath = join(specsRoot, entry);
    if (!isDirectory(specPath)) continue;

    const reqPath = join(specPath, "REQUIREMENTS.md");
    if (!existsSync(reqPath)) continue;

    if (!isSpecComplete(reqPath)) {
      return specPath;
    }
  }

  return null;
}

/**
 * Get status of all spec directories.
 *
 * @param specsRoot - Absolute path to `spec/` directory
 * @returns Array of SpecStatus objects
 */
export function listSpecs(specsRoot: string): SpecStatus[] {
  if (!existsSync(specsRoot)) return [];

  const results: SpecStatus[] = [];
  const entries = safeReaddir(specsRoot);

  for (const entry of entries) {
    if (entry === ".operant") continue;

    const specPath = join(specsRoot, entry);
    if (!isDirectory(specPath)) continue;

    const reqPath = join(specPath, "REQUIREMENTS.md");
    if (!existsSync(reqPath)) continue;

    const blockersDir = join(specPath, "blockers");
    const revisionsDir = join(specPath, "revisions");

    results.push({
      name: entry,
      path: specPath,
      complete: isSpecComplete(reqPath),
      artifacts: {
        requirements: true, // We already checked REQUIREMENTS.md exists
        intent: existsSync(join(specPath, "intent-and-constraints.md")),
        hld: existsSync(join(specPath, "high-level-design.md")),
        adr: existsSync(join(specPath, "adr-lite.md")),
        eis: existsSync(join(specPath, "implementation-spec.md")),
      },
      blockerCount: countFiles(blockersDir),
      revisionCount: countFiles(revisionsDir),
    });
  }

  return results;
}

/**
 * Detect new blocker files by comparing current state to a known set.
 *
 * @param specDir - Absolute path to the active spec directory
 * @param knownBlockers - Array of previously known blocker filenames
 * @returns Array of NEW blocker filenames (not in knownBlockers)
 */
export function detectNewBlockers(specDir: string, knownBlockers: string[]): string[] {
  const blockersDir = join(specDir, "blockers");
  return detectNewFiles(blockersDir, knownBlockers);
}

/**
 * Detect new revision files by comparing current state to a known set.
 *
 * @param specDir - Absolute path to the active spec directory
 * @param knownRevisions - Array of previously known revision filenames
 * @returns Array of NEW revision filenames
 */
export function detectNewRevisions(specDir: string, knownRevisions: string[]): string[] {
  const revisionsDir = join(specDir, "revisions");
  return detectNewFiles(revisionsDir, knownRevisions);
}

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
export function classifyTranscript(
  transcript: string,
  callAnalysis?: Record<string, unknown>,
): "requirements" | "confirmation" | "unknown" {
  // Rule 1: Structured call analysis exists -- check BEFORE transcript emptiness.
  // Retell's call_analysis.call_summary lives at top level, but some payloads
  // nest it under custom_analysis_data. Check both.
  if (callAnalysis && typeof callAnalysis === "object") {
    const summary = callAnalysis.call_summary;
    if (summary && typeof summary === "string" && summary.trim().length > 0) {
      return "requirements";
    }
    // Also check nested under custom_analysis_data (Retell nests feature info there)
    const customData = callAnalysis.custom_analysis_data;
    if (customData && typeof customData === "object") {
      const nestedSummary = (customData as Record<string, unknown>).call_summary;
      if (nestedSummary && typeof nestedSummary === "string" && nestedSummary.trim().length > 0) {
        return "requirements";
      }
      // If custom_analysis_data has a feature_name, it's requirements
      const featureName = (customData as Record<string, unknown>).feature_name;
      if (featureName && typeof featureName === "string" && featureName.trim().length > 0) {
        return "requirements";
      }
    }
  }

  // Empty transcript with no call analysis -> unknown
  if (!transcript || transcript.trim().length === 0) {
    return "unknown";
  }

  const lower = transcript.toLowerCase();

  // Rule 2: Check confirmation keywords (must be standalone, not part of sentences)
  // Use word-boundary matching to avoid false positives like "I'm done with the requirements"
  const confirmationPatterns = [
    /\blooks good\b/,
    /\bconfirmed\b/,
    /\bapproved\b/,
    /\bsatisfied\b/,
    /\bship it\b/,
  ];
  // "done" and "yes" require standalone usage: must be a full sentence or isolated phrase
  // e.g. "Done." or "Yes, ship it" but NOT "I'm done explaining the requirements"
  const doneStandalone = /(?:^|[.!?,;:\s])done(?:[.!?,;:\s]|$)/im;
  const yesStandalone = /(?:^|[.!?,;:\s])yes(?:[.!?,;:\s]|$)/im;

  let confirmCount = 0;
  for (const pattern of confirmationPatterns) {
    if (pattern.test(lower)) confirmCount++;
  }
  if (doneStandalone.test(lower)) confirmCount++;
  if (yesStandalone.test(lower)) confirmCount++;

  // Only classify as confirmation if 2+ matches AND transcript is short/simple
  // (a long transcript with "yes" and "done" in it is likely requirements with filler words)
  if (confirmCount >= 2 && transcript.length < 200) {
    return "confirmation";
  }

  // Rule 3: Requirement-indicating keywords (any single match is enough)
  const requirementKeywords = [
    "requirements",
    "requirement",
    "spec",
    "build",
    "feature",
    "features",
    "implement",
    "solve",
    "fix",
    "create",
    "want",
    "need",
    "needs",
    "should",
    "must",
    "problem",
    "solution",
    "goal",
    "goals",
    "constraint",
    "design",
    "add",
    "update",
    "change",
    "modify",
    "improve",
    "garment",
    "notes",
    "testing",
  ];

  for (const kw of requirementKeywords) {
    if (lower.includes(kw)) {
      return "requirements";
    }
  }

  // Rule 4: Any non-trivial transcript defaults to requirements
  // Better to over-classify than drop a real call
  if (transcript.trim().length > 20) {
    return "requirements";
  }

  // Rule 5: Default
  return "unknown";
}

/**
 * Derive a kebab-case spec directory name from a feature description.
 *
 * @param featureName - Human-readable feature name or title
 * @returns kebab-case slug (max 50 chars, alphanumeric + hyphens only)
 */
export function deriveSpecName(featureName: string): string {
  if (!featureName || featureName.trim().length === 0) {
    return "unnamed-spec";
  }

  const slug = featureName
    .toLowerCase()
    .trim()
    // Replace non-alphanumeric characters (except spaces/hyphens) with empty
    .replace(/[^a-z0-9\s-]/g, "")
    // Collapse whitespace and hyphens to single hyphen
    .replace(/[\s-]+/g, "-")
    // Remove leading/trailing hyphens
    .replace(/^-+|-+$/g, "");

  if (slug.length === 0) {
    return "unnamed-spec";
  }

  // Truncate to 50 chars, avoiding mid-word breaks
  if (slug.length <= 50) return slug;

  const truncated = slug.substring(0, 50);
  const lastHyphen = truncated.lastIndexOf("-");
  // If there's a hyphen in the last 15 chars, break there for a clean word boundary
  if (lastHyphen > 35) {
    return truncated.substring(0, lastHyphen);
  }
  return truncated;
}

/**
 * Infer the current pipeline phase from the filesystem state.
 * Used for crash recovery and session resume (NFC-2).
 *
 * @param specsRoot - Absolute path to the `spec/` directory
 * @returns The inferred coarse Phase
 */
export function inferPhase(specsRoot: string): Phase {
  return stateToPhase(inferState(specsRoot));
}

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
export function inferState(specsRoot: string): State {
  if (!existsSync(specsRoot)) return "idle";

  // Collect spec directories (excluding .operant/)
  const specDirs = safeReaddir(specsRoot).filter(
    (entry) => entry !== ".operant" && isDirectory(join(specsRoot, entry)),
  );

  // 1. No spec directories -> idle
  if (specDirs.length === 0) return "idle";

  // 2. Look for an active (non-complete) spec
  for (const dir of specDirs) {
    const specPath = join(specsRoot, dir);
    const reqPath = join(specPath, "REQUIREMENTS.md");

    if (!existsSync(reqPath)) continue;
    if (isSpecComplete(reqPath)) continue;

    // Active spec found -- determine fine-grained state

    const hasIntent = existsSync(join(specPath, "intent-and-constraints.md"));
    const hasHld = existsSync(join(specPath, "high-level-design.md"));
    const hasAdr = existsSync(join(specPath, "adr-lite.md"));
    const hasEis = existsSync(join(specPath, "implementation-spec.md"));

    const blockersDir = join(specPath, "blockers");
    const revisionsDir = join(specPath, "revisions");
    const hasBlockersDir = existsSync(blockersDir);
    const hasRevisionsDir = existsSync(revisionsDir);

    // 2a. blockers/ has files newer than last dev agent start -> dev_blocked
    if (hasBlockersDir && hasEis) {
      const blockerFiles = safeReaddir(blockersDir).filter(
        (f) => f.endsWith(".md"),
      );
      if (blockerFiles.length > 0) {
        // Check if any blocker is newer than the most recent non-blocker activity
        // Heuristic: if open blockers exist (STATUS: open), we're blocked
        const hasOpenBlocker = blockerFiles.some((f) => {
          const content = safeReadFile(join(blockersDir, f));
          return /\*\*Status:\*\*\s*open/i.test(content);
        });
        if (hasOpenBlocker) return "dev_blocked";
      }
    }

    // 2b. revisions/ has files -> audit_failed (if we have EIS, meaning we're past dev)
    if (hasRevisionsDir && hasEis) {
      const revisionFiles = safeReaddir(revisionsDir).filter(
        (f) => f.endsWith(".md"),
      );
      if (revisionFiles.length > 0) {
        // Check if the most recent revision is newer than the latest code change
        // Heuristic: if revisions exist and we're not in a blocker state, we're in audit_failed
        // But only if we don't also have open blockers (checked above)
        // Additional guard: only report audit_failed if there are NO open blockers
        const hasOpenBlockers = hasBlockersDir && safeReaddir(blockersDir).some((f) => {
          const content = safeReadFile(join(blockersDir, f));
          return /\*\*Status:\*\*\s*open/i.test(content);
        });
        if (!hasOpenBlockers) {
          // Could be dev (re-enter with revisions) or audit_failed
          // We differentiate by checking the newest revision timestamp vs implementation-spec
          // If newest revision is newer than the implementation-spec, it's audit_failed
          const eisMtime = safeStatMtime(join(specPath, "implementation-spec.md"));
          const newestRevisionMtime = Math.max(
            ...revisionFiles.map((f) => safeStatMtime(join(revisionsDir, f))),
          );
          if (newestRevisionMtime > eisMtime) {
            return "audit_failed";
          }
        }
      }
    }

    // 2b2. Check for demo state: .demo/ directory exists
    const demoDir = join(specPath, ".demo");
    if (existsSync(demoDir) && hasEis) {
      const hasMeet = existsSync(join(demoDir, "meet.json"));
      const hasFeedback = existsSync(join(demoDir, "feedback.json"));
      const hasWalkthrough = existsSync(join(demoDir, "walkthrough.json"));

      if (hasMeet && !hasFeedback) {
        // Demo is in progress — determine sub-state
        if (hasWalkthrough) return "demo_active";
        return "demo_setup";
      }
      if (hasFeedback) {
        // Feedback captured — check decision
        const feedbackContent = safeReadFile(join(demoDir, "feedback.json"));
        try {
          const feedback = JSON.parse(feedbackContent);
          if (feedback.decision === "rejected") return "dev";
          // approved or undecided -> confirmation
          return "confirmation";
        } catch {
          return "confirmation";
        }
      }
    }

    // 2c. implementation-spec.md exists AND revisions/ exists -> dev (re-enter)
    if (hasEis && hasRevisionsDir && countFiles(revisionsDir) > 0) {
      return "dev";
    }

    // 2d. implementation-spec.md exists AND no revisions/ -> dev (first run)
    if (hasEis) {
      return "dev";
    }

    // 2e. adr-lite.md exists but no implementation-spec.md -> sdlc_eis
    if (hasAdr && !hasEis) {
      return "sdlc_eis";
    }

    // 2f. high-level-design.md exists but no adr-lite.md -> sdlc_adr
    if (hasHld && !hasAdr) {
      return "sdlc_adr";
    }

    // 2g. intent-and-constraints.md exists but no high-level-design.md -> sdlc_hld
    if (hasIntent && !hasHld) {
      return "sdlc_hld";
    }

    // 2h. REQUIREMENTS.md exists but no intent-and-constraints.md -> sdlc_intent
    if (!hasIntent) {
      return "sdlc_intent";
    }
  }

  // 3. All specs have STATUS: complete -> idle
  return "idle";
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Read a directory safely, returning an empty array if the directory
 * does not exist or is not readable.
 */
function safeReaddir(dirPath: string): string[] {
  try {
    return readdirSync(dirPath);
  } catch {
    return [];
  }
}

/**
 * Read a file safely, returning an empty string on failure.
 */
function safeReadFile(filePath: string): string {
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Get file mtime as epoch milliseconds, returning 0 on failure.
 */
function safeStatMtime(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Check if a path is a directory.
 */
function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Check if a REQUIREMENTS.md file has STATUS: complete.
 * Looks for the pattern `**Status:** complete` (case-insensitive).
 */
function isSpecComplete(reqPath: string): boolean {
  const content = safeReadFile(reqPath);
  return /\*\*Status:\*\*\s*complete/i.test(content);
}

/**
 * Count files (not directories) in a directory.
 * Returns 0 if the directory does not exist.
 */
function countFiles(dirPath: string): number {
  if (!existsSync(dirPath)) return 0;
  try {
    return readdirSync(dirPath).filter((f) => {
      try {
        return statSync(join(dirPath, f)).isFile();
      } catch {
        return false;
      }
    }).length;
  } catch {
    return 0;
  }
}

/**
 * Detect new files in a directory compared to a known set.
 * Returns filenames that exist in the directory but not in the known list.
 */
function detectNewFiles(dirPath: string, knownFiles: string[]): string[] {
  if (!existsSync(dirPath)) return [];

  const knownSet = new Set(knownFiles);
  const currentFiles = safeReaddir(dirPath).filter((f) => {
    try {
      return statSync(join(dirPath, f)).isFile();
    } catch {
      return false;
    }
  });

  return currentFiles.filter((f) => !knownSet.has(f));
}
