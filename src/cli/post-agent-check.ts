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

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";

import {
  detectNewBlockers,
  detectNewRevisions,
  getCurrentSpec,
  type State,
} from "../state-machine.js";

import { getDataDir, getSpecsRoot, readState, readActiveSpec } from "../config.js";

/** SDLC artifact files in production order. */
const SDLC_ARTIFACTS: { state: State; file: string; type: string }[] = [
  { state: "sdlc_intent", file: "intent-and-constraints.md", type: "intent" },
  { state: "sdlc_hld", file: "high-level-design.md", type: "hld" },
  { state: "sdlc_adr", file: "adr-lite.md", type: "adr" },
  { state: "sdlc_eis", file: "implementation-spec.md", type: "eis" },
];

interface CheckResult {
  currentState: State;
  specDir: string | null;
  findings: Finding[];
  suggestedTransitions: SuggestedTransition[];
}

interface Finding {
  type: "new_artifact" | "new_blocker" | "new_revision" | "dev_complete" | "none";
  detail: string;
}

interface SuggestedTransition {
  event: string;
  context: Record<string, string>;
  reason: string;
}

function safeReadFile(filePath: string): string {
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

function loadKnownFiles(dataDir: string, key: string): string[] {
  const path = join(dataDir, `known-${key}.json`);
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return [];
  }
}

function main(): void {
  const currentState = (process.argv[2] as State) ?? readState();
  const dataDir = getDataDir();
  const specsRoot = getSpecsRoot();
  const specDir = readActiveSpec() ?? getCurrentSpec(specsRoot);

  const result: CheckResult = {
    currentState,
    specDir,
    findings: [],
    suggestedTransitions: [],
  };

  if (!specDir || !existsSync(specDir)) {
    result.findings.push({ type: "none", detail: "No active spec directory found." });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  // Check for new SDLC artifacts (relevant in sdlc_* states)
  if (currentState.startsWith("sdlc_") && currentState !== "sdlc_review") {
    const artifact = SDLC_ARTIFACTS.find((a) => a.state === currentState);
    if (artifact) {
      const artifactPath = join(specDir, artifact.file);
      if (existsSync(artifactPath)) {
        const content = safeReadFile(artifactPath);
        // Extract first line as summary
        const firstLine = content.split("\n").find((l) => l.trim().length > 0) ?? "";
        const summary = firstLine.replace(/^#+\s*/, "").substring(0, 200);

        result.findings.push({
          type: "new_artifact",
          detail: `${artifact.type}: ${artifact.file} (${content.length} bytes)`,
        });
        result.suggestedTransitions.push({
          event: "ARTIFACT_PRODUCED",
          context: {
            specDir,
            artifactType: artifact.type,
            artifactSummary: summary,
          },
          reason: `${artifact.file} exists in spec directory`,
        });
      }
    }
  }

  // Check for new blockers (relevant in dev state)
  if (currentState === "dev") {
    const knownBlockers = loadKnownFiles(dataDir, "blockers");
    const newBlockers = detectNewBlockers(specDir, knownBlockers);

    if (newBlockers.length > 0) {
      for (const blocker of newBlockers) {
        result.findings.push({
          type: "new_blocker",
          detail: `New blocker: ${blocker}`,
        });
      }
      result.suggestedTransitions.push({
        event: "BLOCKER_DETECTED",
        context: {
          specDir,
          blockerPath: join(specDir, "blockers", newBlockers[0]),
        },
        reason: `${newBlockers.length} new blocker(s) detected`,
      });
    }

    // Check for dev completion: .dev-complete marker OR no blockers + agent finished cleanly
    const devCompletePath = join(specDir, ".dev-complete");
    if (existsSync(devCompletePath)) {
      result.findings.push({
        type: "dev_complete",
        detail: "Dev complete marker found",
      });
      result.suggestedTransitions.push({
        event: "DEV_COMPLETE",
        context: { specDir },
        reason: ".dev-complete marker exists",
      });
    } else if (newBlockers.length === 0) {
      // No blockers and agent just finished → dev is complete.
      // Create the marker so validate-state.sh can also detect this.
      writeFileSync(devCompletePath, new Date().toISOString() + "\n");
      result.findings.push({
        type: "dev_complete",
        detail: "Agent completed with no blockers — created .dev-complete marker",
      });
      result.suggestedTransitions.push({
        event: "DEV_COMPLETE",
        context: { specDir },
        reason: "Agent finished cleanly with no blockers",
      });
    }
  }

  // Check for new revisions (relevant in audit_failed state)
  if (currentState === "audit_failed") {
    const knownRevisions = loadKnownFiles(dataDir, "revisions");
    const newRevisions = detectNewRevisions(specDir, knownRevisions);

    if (newRevisions.length > 0) {
      for (const revision of newRevisions) {
        result.findings.push({
          type: "new_revision",
          detail: `New revision: ${revision}`,
        });
      }
      result.suggestedTransitions.push({
        event: "REVISION_READY",
        context: { specDir },
        reason: `${newRevisions.length} new revision(s) detected`,
      });
    }
  }

  if (result.findings.length === 0) {
    result.findings.push({ type: "none", detail: "No new artifacts, blockers, or revisions detected." });
  }

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

main();
