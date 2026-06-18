# Intent & Constraints: GitHub Issue Trigger Extension

**Version:** 1.1
**Date:** 2026-06-18
**Status:** Draft (Revised — OQ-1–5 resolved, FR-8 added)
**Audience:** Implementation team (Claude Code agents)

---

## 1. Problem Statement

Operant's pipeline currently only ingests work from two channels: voice calls (Retell.ai webhook) and WhatsApp messages. Both require real-time human initiation. GitHub issues -- the most natural place for users and collaborators to report bugs, request features, and leave feedback -- are ignored entirely.

This creates a gap: feedback that arrives as a GitHub issue must be manually re-entered via voice or WhatsApp to enter the pipeline. This is friction that defeats the purpose of an autonomous development loop.

The pipeline must treat a GitHub issue as a first-class trigger source, with the same downstream behavior as a voice call: triage, SDLC spec, development, audit, and deployment.

---

## 2. Goals

| ID | Goal |
|----|------|
| G-1 | GitHub issues labeled `feedback` trigger the Operant pipeline automatically, with no human re-entry. |
| G-2 | Three redundant detection mechanisms (webhook, polling, session-start check) ensure no issue is missed regardless of whether the webhook server is running, the network blips, or a session restarts. |
| G-3 | The existing FSM, `process-trigger.ts`, and downstream pipeline are minimally changed -- the new source slots into the existing trigger file convention. |
| G-4 | The team is notified via WhatsApp when a GitHub issue enters the pipeline, matching the existing voice-call notification pattern. |

---

## 3. Functional Requirements

### FR-1: GitHub Webhook Endpoint

**Summary:** Add a `POST /webhook/github` route to the webhook server that receives GitHub issue events and writes trigger files.

**Details:**

1. Add a new route handler in `scripts/server.ts` at path `POST /webhook/github`.
2. Read the `X-Hub-Signature-256` header. Compute `HMAC-SHA256` of the raw request body using the webhook secret (stored in env var `GITHUB_WEBHOOK_SECRET`). Compare using `crypto.timingSafeEqual`. Reject with `401` if mismatch.
3. Read the `X-GitHub-Event` header. Only process `issues` events. Respond `200 OK` with `{"ignored": true}` for all other event types.
4. Parse the JSON body. Only process payloads where `action === "opened"`. Ignore `edited`, `closed`, `reopened`, etc.
5. Extract from the payload:
   - `issue.number` (number)
   - `issue.title` (string)
   - `issue.body` (string, may be null -- default to empty string)
   - `issue.user.login` (string)
   - `issue.html_url` (string)
   - `issue.labels` (array of `{name: string}` -- extract names only)
   - `issue.created_at` (ISO 8601 string)
6. Write a trigger file to `spec/.operant/pending/github-<issue_number>-<timestamp>.json` with the `TriggerPayload` shape defined in FR-4.
7. Respond `200 OK` with `{"processed": true, "issue": <number>}`.
8. If the `feedback` label is not present on the issue, still write the trigger (label filtering is a concern of the poller, not the webhook -- webhooks are explicitly configured to fire only for relevant repos/events by the repo admin). This keeps the webhook handler simple.

**Acceptance Criteria:**
- AC-FR1-1: A valid `issues.opened` webhook with correct HMAC writes exactly one trigger file to `spec/.operant/pending/`.
- AC-FR1-2: An invalid HMAC returns `401` and writes no file.
- AC-FR1-3: A `push` event returns `200` with `{"ignored": true}` and writes no file.
- AC-FR1-4: An `issues.closed` event returns `200` with `{"ignored": true}` and writes no file.
- AC-FR1-5: A missing or null `issue.body` does not crash -- defaults to empty string.

---

### FR-2: GitHub API Polling

**Summary:** A background poller that checks for new `feedback`-labeled issues via the GitHub API and writes trigger files for any unseen issues.

**Details:**

1. New file: `src/cli/poll-github.ts`.
2. On startup, read the cursor from `spec/.operant/github-cursor.txt`. The cursor is a single integer: the highest issue number already processed. Default to `0` if the file does not exist.
3. Every `GITHUB_POLL_INTERVAL_MS` milliseconds (default `60000`, configurable via env var), query the GitHub API for issues:
   - Endpoint: `GET /repos/{owner}/{repo}/issues?labels=feedback&state=open&sort=created&direction=asc&since=<cursor_created_at>`
   - Use the `gh` CLI (`gh api ...`) or direct REST with a `GITHUB_TOKEN` env var. Prefer `gh api` for simplicity (inherits auth from `gh auth`).
   - The `{owner}/{repo}` values come from env vars `GITHUB_REPO_OWNER` and `GITHUB_REPO_NAME`, or a single `GITHUB_REPO` in `owner/repo` format.
4. For each issue returned where `issue.number > cursor`:
   - Check that a trigger file `github-<issue_number>-*.json` does not already exist in `spec/.operant/pending/` (idempotency guard).
   - Write a trigger file in the same format as FR-1.
   - Update the cursor to `max(cursor, issue.number)`.
5. After processing all new issues, write the updated cursor to `spec/.operant/github-cursor.txt`.
6. Log each poll cycle: `[poll-github] Checked at <ISO timestamp>. Found <N> new issues.`
7. Handle errors gracefully: log the error, do not crash, retry on next cycle.

**Acceptance Criteria:**
- AC-FR2-1: First run with no cursor file processes all open `feedback`-labeled issues and creates the cursor file.
- AC-FR2-2: Subsequent runs only process issues with `number > cursor`.
- AC-FR2-3: If a trigger file for an issue already exists in `pending/`, it is not re-created (idempotency).
- AC-FR2-4: A GitHub API error (rate limit, network failure) is logged but does not crash the poller.
- AC-FR2-5: Poll interval is configurable via `GITHUB_POLL_INTERVAL_MS`.

---

### FR-3: Session Start Check

**Summary:** On session startup, perform a one-shot check for unprocessed `feedback`-labeled issues before the main pipeline loop begins.

**Details:**

1. Add a block to `scripts/startup.sh` (after existing initialization, before the main loop).
2. The check logic is identical to one iteration of FR-2's poll loop. Reuse the same function by invoking `poll-github.ts` with a `--once` flag that runs a single poll cycle and exits.
3. This ensures that issues created while the session was offline are picked up immediately on restart, without waiting for the first poll interval.

**Acceptance Criteria:**
- AC-FR3-1: Starting a new session after 3 issues were created offline results in 3 trigger files being written before the main loop begins.
- AC-FR3-2: The `--once` flag causes `poll-github.ts` to execute one cycle and exit with code `0`.

---

### FR-4: Extended TriggerPayload

**Summary:** Extend the `TriggerPayload` interface to carry GitHub issue metadata.

**Details:**

1. In the file that defines `TriggerPayload` (currently used in `src/cli/process-trigger.ts`), add:

```typescript
interface TriggerPayload {
  // Existing fields (unchanged)
  call_id?: string;
  caller_name?: string;
  from_number?: string;
  raw_transcript?: string;
  call_analysis?: Record<string, unknown>;
  spec?: {
    raw_transcript?: string;
    call_analysis?: Record<string, unknown>;
    feature_name?: string;
    call_summary?: string;
  };
  body?: string;

  // EXTENDED: Source discriminator (was implicit, now explicit)
  source?: "voice" | "whatsapp" | "github";

  // NEW: GitHub issue metadata
  github_issue?: {
    number: number;
    title: string;
    body: string;
    author: string;
    url: string;
    labels: string[];
    created_at: string;
  };
}
```

2. The trigger file written by FR-1 / FR-2 / FR-3 must always set `source: "github"` and populate `github_issue`.

**Acceptance Criteria:**
- AC-FR4-1: Existing voice and WhatsApp trigger files continue to parse without error (backward compatible).
- AC-FR4-2: A GitHub trigger file contains both `source: "github"` and a fully populated `github_issue` object.

---

### FR-5: process-trigger.ts GitHub Path

**Summary:** Extend `process-trigger.ts` to handle `source === "github"` triggers with a GitHub-specific entry path.

**Details:**

1. After loading and parsing the trigger JSON, check `payload.source`:
   - `"voice"` or `undefined` (legacy): existing behavior (unchanged).
   - `"whatsapp"`: existing behavior (unchanged).
   - `"github"`: new path (below).

2. GitHub path:
   a. Set `raw_transcript = payload.github_issue.body`. This is the text that gets classified and becomes `REQUIREMENTS.md` content.
   b. Set `feature_name = payload.github_issue.title`. Pass this to `deriveSpecName()` instead of extracting from transcript classification.
   c. Do **not** fire `CALL_RECEIVED` or `CALL_COMPLETED` events. GitHub issues have no call phase.
   d. Fire the new `ISSUE_RECEIVED` event (see FR-6), which transitions directly from `idle` to `triage`.
   e. From `triage` onward, the pipeline proceeds identically to the voice path: `classifyTranscript()`, create spec directory, write `REQUIREMENTS.md`, transition to `sdlc_intent`, etc.
   f. Include the issue URL in `REQUIREMENTS.md` as a reference link at the top: `> Source: GitHub Issue #<number> -- <url>`.

3. If `github_issue.body` is empty or very short (< 20 characters), use `github_issue.title` as the transcript instead (some issues have all context in the title).

**Acceptance Criteria:**
- AC-FR5-1: A GitHub trigger file causes `ISSUE_RECEIVED` to fire (not `CALL_RECEIVED`).
- AC-FR5-2: The generated `REQUIREMENTS.md` contains the issue body as requirements text and the issue URL as a source reference.
- AC-FR5-3: `deriveSpecName()` receives the issue title, not a classified transcript excerpt.
- AC-FR5-4: An issue with empty body but descriptive title still produces valid `REQUIREMENTS.md`.
- AC-FR5-5: Existing voice triggers are completely unaffected.

---

### FR-6: FSM Extension -- ISSUE_RECEIVED Event

**Summary:** Add a new event and transition to the state machine to support direct entry from GitHub issues.

**Details:**

1. In `src/state-machine.ts`:
   a. Add `ISSUE_RECEIVED` to the `FSMEvent` union type (becomes the 24th event).
   b. Add transition: `{ from: "idle", event: "ISSUE_RECEIVED", to: "triage" }`.
   c. Side effects on this transition are identical to the `idle -> call_active -> triage` path's triage-entry side effects: create spec directory, initialize spec state. The difference is that it skips `call_active` entirely.

2. No other states or transitions are modified. From `triage` onward, the FSM is source-agnostic.

3. The pure-function nature of the FSM must be preserved: `ISSUE_RECEIVED` is just another event the `transition()` function handles. No I/O in the state machine module.

**Acceptance Criteria:**
- AC-FR6-1: `transition("idle", "ISSUE_RECEIVED")` returns `{ state: "triage", sideEffects: [...] }`.
- AC-FR6-2: `transition("call_active", "ISSUE_RECEIVED")` returns an error or is undefined (invalid transition).
- AC-FR6-3: The FSM module remains pure (no imports of `fs`, `path`, `child_process`, or network modules).
- AC-FR6-4: Existing transitions are not altered. The full set of 23 existing events + transitions still work.

---

### FR-7: WhatsApp Notification

**Summary:** When a GitHub issue triggers the pipeline, send a WhatsApp notification to the team.

**Details:**

1. After `REQUIREMENTS.md` is written for a GitHub-sourced trigger, use the existing WhatsApp integration in `src/channel.ts` to send a message.
2. Message format:
   ```
   New feedback from @<author>: "<title>"
   Issue #<number>: <url>
   Starting pipeline.
   ```
3. Send to the same group/number used for voice-call notifications.
4. If the WhatsApp send fails, log the error but do not block the pipeline. The notification is best-effort.

**Acceptance Criteria:**
- AC-FR7-1: A GitHub trigger results in exactly one WhatsApp notification with the correct format.
- AC-FR7-2: A WhatsApp delivery failure does not prevent the pipeline from proceeding to `triage`.
- AC-FR7-3: Voice and WhatsApp triggers continue to send their existing notifications (no regression).

---

### FR-8: `/operant:start` and `/operant:stop` Extension

**Summary:** Extend the start and stop commands to manage the GitHub poller lifecycle and verify required env vars.

**Details:**

1. **`commands/start.md` additions (after existing steps):**
   a. Verify that `GITHUB_REPO`, `GITHUB_TOKEN`, and `TWILIO_WHATSAPP_RECIPIENT` env vars are set. If any are missing, log a warning but do not block startup (GitHub trigger is optional — voice/WhatsApp still work without it).
   b. If all three are present, start the GitHub poller as a background process: `node $PLUGIN_ROOT/lib/cli/poll-github.js &`. Write the poller PID to `$DATA_DIR/github-poller.pid`.
   c. Log: `GitHub issue poller started (PID: <pid>, repo: <GITHUB_REPO>)`.

2. **`commands/stop.md` additions:**
   a. Read PID from `$DATA_DIR/github-poller.pid`. If the process is alive, kill it.
   b. Remove the PID file.
   c. Log: `GitHub poller stopped`.

3. **`scripts/startup.sh` additions (session-start check):**
   a. After existing initialization, if `GITHUB_TOKEN` and `GITHUB_REPO` are set, run `poll-github.ts --once` for offline recovery.
   b. This catches issues created while the session was down, before the main poller starts.

**Acceptance Criteria:**
- AC-FR8-1: Running `/operant:start` with `GITHUB_REPO`, `GITHUB_TOKEN`, and `TWILIO_WHATSAPP_RECIPIENT` set starts the GitHub poller and writes a PID file.
- AC-FR8-2: Running `/operant:start` without `GITHUB_REPO` logs a warning but completes successfully (voice/WhatsApp still functional).
- AC-FR8-3: Running `/operant:stop` kills the GitHub poller process and removes the PID file.
- AC-FR8-4: The poller PID is cleaned up by the existing stale-PID cleanup logic in `startup.sh` if the process dies unexpectedly.

---

## 4. Non-Functional Constraints

| ID | Constraint |
|----|------------|
| NFC-1 | **No new dependencies.** Use Node.js `crypto` for HMAC. Use `gh` CLI (already available) or `fetch` for GitHub API. No new npm packages. |
| NFC-2 | **Idempotency.** Processing the same issue twice (via webhook + poller, or poller + session-start) must not create duplicate trigger files or duplicate pipeline runs. The filename convention (`github-<issue_number>-*.json`) plus the existence check in FR-2 enforces this. |
| NFC-3 | **Backward compatibility.** All existing voice and WhatsApp triggers must continue to work with zero changes to their payloads or processing paths. The `source` field is optional; existing payloads without it default to `"voice"`. |
| NFC-4 | **Secret management.** `GITHUB_WEBHOOK_SECRET` and `GITHUB_TOKEN` must be read from environment variables, never hardcoded. Document required env vars in a setup section of the implementation PR. |
| NFC-5 | **Cursor durability.** The cursor file (`spec/.operant/github-cursor.txt`) must be written atomically (write to temp file, then rename) to prevent corruption on crash. |
| NFC-6 | **Rate limiting awareness.** The poller must respect GitHub API rate limits. At 60-second intervals querying a single endpoint, this is well within the 5000 requests/hour authenticated limit. Log a warning if `X-RateLimit-Remaining` drops below 100. |
| NFC-7 | **Logging.** All new code must log to stdout with a prefix: `[webhook/github]`, `[poll-github]`, or `[startup/github]` as appropriate. Use the same logging style as existing Operant modules. |
| NFC-8 | **Testability.** The webhook handler, poller logic, and payload extraction must be unit-testable by accepting dependencies (file writer, API client) as parameters rather than importing them directly. |

---

## 5. Acceptance Criteria (System-Level)

| ID | Criterion |
|----|-----------|
| AC-1 | **End-to-end webhook path:** Creating a `feedback`-labeled issue on the configured repo fires the webhook, writes a trigger file, `process-trigger.ts` picks it up, FSM transitions `idle -> triage`, `REQUIREMENTS.md` is created with the issue body, and a WhatsApp notification is sent. |
| AC-2 | **End-to-end poller path:** With the webhook server stopped, creating a `feedback`-labeled issue is detected by `poll-github.ts` within 60 seconds, and the same downstream pipeline executes. |
| AC-3 | **Session restart recovery:** After a session crash, restarting picks up any issues created during downtime via the session-start check in `startup.sh`. |
| AC-4 | **Deduplication:** An issue detected by both webhook and poller results in exactly one pipeline run. |
| AC-5 | **Voice regression:** A voice call trigger still works identically to the pre-change behavior, transitioning through `idle -> call_active -> triage`. |
| AC-6 | **WhatsApp regression:** A WhatsApp trigger still works identically to the pre-change behavior. |
| AC-7 | **Invalid webhook rejection:** A webhook request with an invalid HMAC signature returns `401` and produces no side effects. |

---

## 6. Out of Scope

| ID | Item | Rationale |
|----|------|-----------|
| OOS-1 | **Closing/updating the GitHub issue from the pipeline.** The pipeline does not write back to GitHub (e.g., posting a comment when the fix is deployed). This is a future enhancement. |
| OOS-2 | **Issue comment triggers.** Only `issues.opened` is handled. Comments on existing issues do not trigger new pipeline runs. |
| OOS-3 | **Multi-repo support.** The poller targets a single `owner/repo`. Supporting multiple repositories requires a future config extension. |
| OOS-4 | **GitHub App installation.** This spec uses a personal access token or fine-grained token, not a GitHub App with installation-level permissions. |
| OOS-5 | **Label-based routing (e.g., `bug` vs `feature`).** All `feedback`-labeled issues enter the same pipeline path. Priority/type classification happens downstream in `classifyTranscript()`. |
| OOS-6 | **Operant API (cloud mode) integration.** `poll-triggers.ts` (cloud poller) is not modified. GitHub issue triggers only work in local/self-hosted mode via the file-based `pending/` directory. |
| OOS-7 | **Tunnel/ngrok setup for the webhook.** The webhook endpoint is added to the existing server in `scripts/server.ts` which already has tunnel infrastructure. No new tunnel is needed. |

---

## 7. Open Questions (Resolved)

| ID | Question | Resolution |
|----|----------|------------|
| OQ-1 | Which GitHub repo(s) should the poller target? | **Resolved:** Configured at runtime via `GITHUB_REPO` env var, set during `/operant:start`. No hardcoded default — the start command verifies it is set before launching the poller. |
| OQ-2 | Should the webhook secret be per-repo or shared across repos? | **Resolved:** Single shared secret in `GITHUB_WEBHOOK_SECRET`. Multi-repo is OOS-3. |
| OQ-3 | Should the poller also check for issues labeled `bug` in addition to `feedback`? | **Resolved:** `feedback` label only. Teams can add `feedback` alongside any other label on issues they want auto-processed. |
| OQ-4 | What is the WhatsApp group/number for pipeline notifications? | **Resolved:** Uses existing `TWILIO_WHATSAPP_RECIPIENT` env var (already used for voice-call notifications). `/operant:start` verifies this is set before launching. |
| OQ-5 | Should the pipeline eventually close or comment on the GitHub issue when work is complete? | **Deferred to OOS-1.** Store `issue_number` + `issue_url` in `source-metadata.json` to enable future write-back without archaeology. |

---

## 8. Key Files Affected

| File | Change |
|------|--------|
| `scripts/server.ts` | Add `POST /webhook/github` route with HMAC validation and trigger file creation. |
| `src/cli/poll-github.ts` | **New file.** GitHub API poller with cursor tracking and `--once` flag. |
| `src/cli/process-trigger.ts` | Add `source === "github"` branch. Extract transcript from `github_issue.body`, use title as `feature_name`, fire `ISSUE_RECEIVED` instead of `CALL_RECEIVED`. |
| `src/state-machine.ts` | Add `ISSUE_RECEIVED` event. Add transition `idle + ISSUE_RECEIVED -> triage`. |
| `src/channel.ts` | Add GitHub notification message formatting (reuses existing WhatsApp send infrastructure). |
| `scripts/startup.sh` | Add session-start GitHub issue check by invoking `poll-github.ts --once`. |
| `spec/.operant/github-cursor.txt` | **New file (runtime).** Stores the highest processed issue number. |
| `src/config.ts` | Add `GITHUB_REPO`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_POLL_INTERVAL_MS` to config constants. |
| `commands/start.md` | Extend to start GitHub poller, verify `GITHUB_REPO` + `GITHUB_TOKEN` + `TWILIO_WHATSAPP_RECIPIENT` are set. |
| `commands/stop.md` | Extend to stop GitHub poller process (kill PID from `github-poller.pid`). |
