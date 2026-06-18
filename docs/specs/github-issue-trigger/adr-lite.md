# ADR-Lite: GitHub Issue Trigger Extension

**Version:** 1.1
**Date:** 2026-06-18
**Status:** Draft (Revised — ADR-008 added for poller lifecycle, ADR-008→009 renumbered)
**Parent:** [High-Level Design](high-level-design.md)

---

## ADR-001: Direct `idle -> triage` via `ISSUE_RECEIVED`

**Decision:** Add a new `ISSUE_RECEIVED` FSM event that transitions directly from `idle` to `triage`, bypassing `call_active`.

**Alternatives:** (A) Route through `call_active` by firing `CALL_RECEIVED` then immediately `CALL_COMPLETED`. (B) Reuse `CALL_RECEIVED` with synthetic call data and let existing transitions handle it. (C) Introduce a wrapper event type that internally dispatches to the appropriate transition chain.

**Rationale:** `call_active` exists to model the temporal gap between call pickup and hangup (HLD Section 2). GitHub issues arrive complete -- there is no in-progress phase. Option A requires a synthetic `CALL_COMPLETED` fired milliseconds after `CALL_RECEIVED`, adding fragile coupling to call semantics. Option B pollutes voice-call processing with GitHub-specific guards. A direct transition is the cleanest expression of the domain: an issue is a complete artifact, not a live session. This also preserves the pure-function FSM invariant (NFC-8, FR-6 AC-FR6-3).

**Consequences:** The FSM gains a 24th event and one new transition entry. From `triage` onward, all paths converge -- no downstream changes. If future sources also arrive as complete artifacts (e.g., email), this pattern is reusable.

**References:** FR-6, NFC-3 from intent doc; HLD Section 2 (FSM Changes, "Why `call_active` is skipped")

---

## ADR-002: Three Redundant Detection Mechanisms

**Decision:** Detect GitHub issues through three independent paths: webhook, interval poller, and session-start one-shot check.

**Alternatives:** (A) Webhook only -- simplest, but misses issues created while the server is down. (B) Polling only -- reliable but adds up to 60 seconds of latency and wastes API calls for the common case. (C) Webhook + poller without session-start check -- misses the gap between last poll and crash.

**Rationale:** G-2 explicitly requires that "no issue is missed regardless of whether the webhook server is running, the network blips, or a session restarts." Webhook provides near-instant detection in the happy path. The poller catches anything the webhook misses (server down, network blip, misconfigured hook). The session-start check closes the final gap: issues created during total downtime are picked up before the main loop begins, not after the first poll interval (FR-3). The four-layer idempotency design (HLD Section 9) makes triple-write safe.

**Consequences:** Three code paths to maintain, but each is small and shares the trigger file writer. The poller and session-start check reuse the same `pollOnce()` function (FR-3 detail 2), so the actual unique code surface is two paths, not three.

**References:** G-2, FR-1, FR-2, FR-3, NFC-2 from intent doc; HLD Sections 3, 4, 9

---

## ADR-003: `node:https` for GitHub API in Poller

**Decision:** Use `node:https` with `GITHUB_TOKEN` bearer auth for GitHub API calls in the poller.

**Alternatives:** (A) Shell out to `gh api` CLI via `child_process` -- simpler auth (inherits `gh auth`), but adds subprocess overhead and a runtime dependency on `gh` being installed and authenticated. (B) Use the Octokit npm package -- ergonomic, but adds a new dependency.

**Rationale:** NFC-1 prohibits new npm packages, ruling out Octokit. The HLD notes that `poll-triggers.ts` (the existing cloud-mode poller) already uses `node:https`, so this is a consistent pattern. Direct HTTP avoids child-process spawn overhead on every poll cycle and keeps the poller self-contained -- it only needs a `GITHUB_TOKEN` env var, not a configured `gh` CLI session. The intent doc (FR-2 detail 3) suggests `gh api` as acceptable, but the HLD (Section 4) resolves this in favor of `node:https`.

**Consequences:** Slightly more boilerplate than `gh api` (manual header construction, response parsing). Rate limit headers (`X-RateLimit-Remaining`) must be read manually, but this is already required by NFC-6.

**References:** NFC-1, NFC-6, FR-2 from intent doc; HLD Section 4 (GitHub API Access)

---

## ADR-004: Cursor-Based Tracking in a File

**Decision:** Track the highest processed issue number in `spec/.operant/github-cursor.txt` as a single integer, written atomically via write-tmp-then-rename.

**Alternatives:** (A) Use `If-Modified-Since` / last-modified timestamp -- depends on GitHub API honoring the header precisely; issue numbers are a more reliable monotonic key. (B) Use a database (SQLite, Supabase) -- overkill for a single integer; adds a dependency and failure mode. (C) Track per-issue state in a JSON map -- more information but unnecessary given the idempotency guard already handles duplicates.

**Rationale:** Issue numbers are monotonically increasing within a repo, making `number > cursor` a correct and simple filter. A flat file is consistent with the existing `pending/`/`processed/` file-based architecture. Atomic write (NFC-5) prevents corruption on crash; if the file is corrupted, `parseInt()` returns `NaN` which defaults to `0`, triggering a safe full re-scan guarded by idempotency checks (HLD Section 10).

**Consequences:** Cursor can only move forward. If an older issue is retroactively labeled `feedback`, it will not be picked up by the poller (its number is below the cursor). The webhook path is unaffected. This is an acceptable trade-off for simplicity.

**References:** NFC-5, NFC-2, FR-2 from intent doc; HLD Section 4 (Cursor Tracking), Section 10 (cursor corrupted row)

---

## ADR-005: HMAC-SHA256 with `node:crypto`

**Decision:** Validate webhook authenticity using HMAC-SHA256 with `crypto.timingSafeEqual`, reading the secret from `GITHUB_WEBHOOK_SECRET` env var.

**Alternatives:** (A) No validation -- accepts any POST, risking spoofed triggers. (B) GitHub App with JWT-based verification -- more secure (installation-scoped tokens), but requires App registration, private key management, and is explicitly out of scope (OOS-4). (C) IP allowlist -- fragile, GitHub's IP ranges change.

**Rationale:** HMAC-SHA256 is GitHub's standard webhook verification mechanism. `node:crypto` is stdlib, satisfying NFC-1. `timingSafeEqual` prevents timing attacks. This matches the security posture appropriate for a self-hosted tool: strong enough to prevent spoofing, simple enough to not require infrastructure (no App registration, no key rotation service). OOS-4 explicitly defers GitHub App integration.

**Consequences:** The webhook secret must be configured both in the GitHub repo settings and in the Operant environment. A single shared secret means all repos using this webhook share the same key (OQ-2 remains open). Rotation requires updating both sides simultaneously.

**References:** FR-1, NFC-1, NFC-4, OOS-4 from intent doc; HLD Section 3 (HMAC Validation)

---

## ADR-006: Webhook Writes Unconditionally / Poller Does Existence Check

**Decision:** The webhook handler writes trigger files without checking the cursor or existing files. The poller checks both the cursor and existing files before writing.

**Alternatives:** (A) Both paths check for existing files -- adds a glob to the webhook hot path for no practical benefit. (B) Webhook checks the cursor -- creates a shared-state coupling between webhook and poller. (C) Neither checks -- relies entirely on `process-trigger.ts` to deduplicate, which would create unnecessary file churn.

**Rationale:** GitHub webhooks fire exactly once per `issues.opened` event -- there is no natural duplication source for the webhook path. Adding an existence check would be defensive code with no real-world trigger. The poller, by contrast, re-queries the same API endpoint every cycle and will see the same issues repeatedly, making the existence check essential. Keeping the webhook simple (write-and-respond) minimizes latency and matches the existing `/webhook/call-completed` handler's pattern. The poller's existence check (Layer 2 in HLD Section 9) handles the webhook-then-poller overlap case.

**Consequences:** If GitHub retries a webhook delivery (e.g., due to a timeout), a second trigger file could be written. This is handled by Layer 4 (FSM rejects `ISSUE_RECEIVED` when not in `idle`). The risk is low and the mitigation is already in place.

**References:** NFC-2, FR-1, FR-2 from intent doc; HLD Section 9 (Webhook Deduplication, Layers 1-4)

---

## ADR-007: Best-Effort WhatsApp Notification

**Decision:** WhatsApp notifications for GitHub triggers are best-effort: failures are logged but do not block the pipeline.

**Alternatives:** (A) Blocking notification with retry -- delays the pipeline if WhatsApp is down; notification is not critical path. (B) No notification -- team loses visibility into GitHub-sourced pipeline runs, breaking parity with voice-call notifications. (C) Queue-based notification with guaranteed delivery -- overengineered for a status message.

**Rationale:** FR-7 and AC-FR7-2 explicitly require that "a WhatsApp delivery failure does not prevent the pipeline from proceeding to `triage`." The notification is informational -- the pipeline's value is in processing the issue, not in announcing it. This matches the existing voice-call notification pattern where delivery failures are logged but not retried. The `try/catch` wrapper is minimal code (HLD Section 8).

**Consequences:** If WhatsApp is consistently down, the team will not know about GitHub-triggered pipeline runs until they check manually. This is acceptable given that the pipeline itself still runs, and logs capture the activity.

**References:** FR-7, AC-FR7-2, G-4 from intent doc; HLD Section 8 (Error Handling)

---

## ADR-008: Poller Lifecycle Managed by `/operant:start` and `/operant:stop`

**Decision:** The GitHub poller is started as a background process by `/operant:start` and killed by `/operant:stop`, with PID tracking via `github-poller.pid`. Required env vars (`GITHUB_REPO`, `GITHUB_TOKEN`, `TWILIO_WHATSAPP_RECIPIENT`) are verified at start time — missing vars log a warning but do not block the pipeline.

**Alternatives:** (A) Auto-start the poller in `startup.sh` (SessionStart hook) unconditionally. (B) Require the user to start the poller manually as a separate process. (C) Integrate polling into the existing webhook server process (single process, multiple responsibilities).

**Rationale:** The existing pipeline uses explicit start/stop lifecycle management — the webhook server and tunnel are started by `/operant:start` and stopped by `/operant:stop`. The poller should follow the same pattern for operational consistency. Option A would start the poller even when the user hasn't configured GitHub credentials, leading to error spam. Option B adds friction and is easy to forget. Option C would make the server harder to reason about and would mean a poller failure could crash the webhook server. A dedicated background process with PID tracking mirrors how `poll-triggers.ts` (cloud-mode poller) is managed by `startup.sh`.

**Consequences:** Users must have `GITHUB_REPO`, `GITHUB_TOKEN` in their `.env` file before running `/operant:start`. If not set, the poller is silently skipped — the rest of the pipeline works fine without it. The webhook endpoint in `server.ts` still works regardless (it only needs `GITHUB_WEBHOOK_SECRET`).

**References:** FR-8 from intent doc; HLD Section 14 (Poller Lifecycle Management)

---

## ADR-009: `source` Field as Optional Discriminator

**Decision:** Add an optional `source` field (`"voice" | "whatsapp" | "github"`) to `TriggerPayload`. Existing payloads without the field default to `"voice"`.

**Alternatives:** (A) Separate trigger types with distinct interfaces (`VoiceTrigger`, `GitHubTrigger`) -- type-safe but requires a discriminated union refactor across `process-trigger.ts` and all consumers. (B) A wrapper envelope (`{ type: "github", payload: {...} }`) -- changes the file format, breaking backward compatibility. (C) Infer the source from filename prefix (`github-*` vs `call-*`) -- fragile, couples processing logic to naming conventions.

**Rationale:** NFC-3 mandates that "all existing voice and WhatsApp triggers must continue to work with zero changes to their payloads." An optional field with a `"voice"` default is the least invasive extension. `process-trigger.ts` already parses a loosely-typed JSON payload; adding one optional field is a natural evolution. The `source` check (`payload.source ?? "voice"`) is a single line that gates the GitHub-specific path (HLD Section 5). Option A would be cleaner in a greenfield design but requires touching every existing trigger file and consumer.

**Consequences:** The payload type is stringly-typed rather than structurally discriminated. Future sources (email, Slack, etc.) add another union member. If the number of sources grows significantly, a refactor to discriminated unions may be warranted, but for three sources this is proportionate.

**References:** FR-4, NFC-3, AC-FR4-1 from intent doc; HLD Section 5 (Source Discrimination, TriggerPayload Extension)
