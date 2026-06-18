# ADR-Lite: WhatsApp Group Notifications via Conversations API

**Version:** 1.0
**Date:** 2026-06-18
**Status:** Draft
**Parent:** [High-Level Design](high-level-design.md)

---

## ADR-001: Twilio Conversations API as the Group Delivery Mechanism

**Decision:** Use the Twilio Conversations API (`conversations.twilio.com`) to deliver group notifications, rather than native WhatsApp Groups or any other multi-recipient abstraction.

**Alternatives:** (A) Meta WhatsApp Groups API (native groups, launched Oct 2025) -- direct but Twilio support is unconfirmed and the API surface is new and unstable. (B) Send duplicate 1:1 Messages API calls to each participant in a loop -- no persistent thread, each participant sees isolated messages with no group context, and rate-limit risk increases linearly with participant count. (C) Twilio Notify service -- a fan-out abstraction over multiple channels, but adds a service dependency and is not WhatsApp-specific.

**Rationale:** OOS-1 explicitly rules out the Meta WhatsApp Groups API on grounds of unconfirmed Twilio support. The Conversations API is Twilio's standard multi-party messaging primitive -- it creates a persistent, shared thread that satisfies G-1 (group visibility) and G-4 (one-time setup, reused thereafter). Duplicate 1:1 sends (Option B) would technically reach each person but would not create a shared conversation, breaking G-2 (any participant can approve). The Conversations API webhook routing also means inbound replies from any participant arrive at the existing `/webhook/whatsapp` endpoint without any server changes, directly enabling FR-4.

**Consequences:** The pipeline depends on Twilio Conversations being enabled on the account. Twilio's Sandbox environment supports Conversations without a Messaging Service SID; production Business accounts require `TWILIO_MESSAGING_SERVICE_SID`. A free-tier or improperly provisioned account will fail at conversation creation and fall back to 1:1 (FR-5, AC-FR5-2).

**References:** G-1, G-2, G-4, OOS-1 from intent doc; HLD Section 2 (Technology Choices, "Conversations API transport" row)

---

## ADR-002: `node:https` Direct HTTPS Calls to `conversations.twilio.com`

**Decision:** Implement all Conversations API calls using `node:https` with Basic auth (`TWILIO_ACCOUNT_SID:TWILIO_AUTH_TOKEN`) and `application/x-www-form-urlencoded` body encoding, matching the existing `sendTwilioMessage()` pattern in `whatsapp.ts`.

**Alternatives:** (A) The `twilio` npm SDK -- ergonomic typed API, built-in retry and pagination, but adds a new npm dependency. (B) `node-fetch` or `axios` -- reduces boilerplate vs raw `node:https`, but also adds a new npm dependency. (C) Shell out to `curl` -- avoids new code but is subprocess-heavy and error-prone.

**Rationale:** NFC-1 prohibits new npm packages. This is a hard constraint that eliminates Options A and B. The existing `sendTwilioMessage()` function already demonstrates that `node:https` with Basic auth and form-encoded bodies is sufficient for the Twilio API -- the Conversations API uses the same auth scheme and encoding. Reusing the same pattern means the new `callConversationsApi()` helper is structurally familiar to anyone reading `whatsapp.ts`, and the only variable is the base hostname (`conversations.twilio.com` vs `api.twilio.com`). The `twilio` SDK would be the right choice in a fresh project, but adding it solely for this feature is disproportionate given the working baseline.

**Consequences:** All Conversations API callers must construct request paths and body strings manually. HTTP status codes (particularly 409 for participant conflicts and 404 for deleted conversations) are read from the raw response rather than from SDK-level exceptions. The `callConversationsApi()` function returns `{ status, data }` so callers can branch on status without rethrowing.

**References:** NFC-1 from intent doc; HLD Section 2 (Technology Choices, "Conversations API transport" row), Section 6 (`callConversationsApi()` signature)

---

## ADR-003: Per-Project Conversation SID Stored in `spec/.operant/conversation-sid.txt`

**Decision (resolves OQ-2):** Store the Conversation SID in `spec/.operant/conversation-sid.txt` (per-project), not in a global location like `~/.operant/`.

**Alternatives:** (A) Global `~/.operant/conversation-sid.txt` -- a single Conversation shared across all projects on the machine. (B) Supabase or another database -- network-dependent, overkill for a single string. (C) Environment variable set by the user -- not persistent across sessions without `.env` edits; removes the one-time-setup property (G-4). (D) In-memory only -- lost on every process restart, violating NFC-4 and G-4.

**Rationale:** The `spec/.operant/` directory is the established location for all per-project pipeline state (`github-cursor.txt`, `pending/`, `processed/`). Per-project storage is correct because different projects will have different participant lists (G-4 says one-time setup, which implies setup is scoped to the project). Option A would cause all projects on a machine to share one WhatsApp conversation, which is noisy and confusing. Option C would require the user to manually record the SID after creation, undermining the self-managing lifecycle design of FR-1. The atomic-write pattern (write-tmp-then-rename, identical to `github-cursor.txt`) satisfies NFC-4.

**Consequences:** Each project that uses group notifications creates its own Twilio Conversation object. Teams using many projects will accumulate Conversations in their Twilio account, but these are lightweight objects. A project directory deletion does not clean up the Twilio-side Conversation; this is acceptable for MVP (users can delete manually from the Twilio console).

**References:** G-4, FR-1, NFC-4 from intent doc; HLD Section 2 (Technology Choices, "Conversation SID storage" row), Section 3 (`getConversationSid()` / `writeConversationSid()`), Section 5 (Configuration)

---

## ADR-004: Lazy `ensureConversation()` — Called on First Send, Not on `/operant:start`

**Decision (resolves OQ-1):** `ensureConversation()` is called lazily at the moment of the first outbound message send, not eagerly during plugin startup or `/operant:start`.

**Alternatives:** (A) Eager initialization in `/operant:start` -- validates Twilio credentials and creates the Conversation at a deterministic moment; errors surface immediately rather than mid-pipeline. (B) A dedicated `/operant:whitelist sync` subcommand that creates/validates the Conversation on demand without waiting for a send.

**Rationale:** G-4 says "one-time setup creates the conversation"; it does not require that setup happen at startup. Lazy initialization avoids creating orphan Conversations in sessions where the pipeline is started but never sends a WhatsApp message (e.g., developer testing without a configured recipient). Because the SID is persisted to disk and reused across sessions (NFC-4), the first-call cost of conversation creation is paid exactly once in the lifetime of the project -- not on every startup. Option A has a real downside: it introduces a network call into the `/operant:start` critical path, which today is synchronous and fast. A startup failure would make the entire plugin appear broken even though the core pipeline functionality is unaffected.

**Consequences:** Conversation creation errors surface during a live pipeline run rather than at startup. The error handling in `sendGroupNotification()` and `sendGate()` catches these and falls back to 1:1 (FR-5, AC-FR5-2), so the pipeline is never blocked. Teams that want to pre-validate their Conversations setup should do so with a test trigger.

**References:** G-4, FR-1, FR-5 from intent doc; HLD Section 3 (`ensureConversation()` pseudocode), Section 13 OQ-1

---

## ADR-005: `OPERANT_WHATSAPP_PARTICIPANTS` Env Var as Sole Participant Source

**Decision:** Read group participants from the `OPERANT_WHATSAPP_PARTICIPANTS` environment variable (comma-separated `+<country><number>` values). Do not derive participants from `whitelist.json`.

**Alternatives:** (A) Parse `whitelist.json` directly to build the participant list -- a single config file for both trusted senders and notification recipients. (B) Support both sources and merge them -- `OPERANT_WHATSAPP_PARTICIPANTS` for explicit additions, `whitelist.json` for the rest. (C) A dedicated `participants.json` config file -- explicit but adds another file type.

**Rationale:** `whitelist.json` defines trusted senders: phone numbers allowed to approve gates. `OPERANT_WHATSAPP_PARTICIPANTS` defines notification recipients: people who should receive pipeline messages. These are related but distinct concepts. A team member might be a trusted approver without needing to receive every pipeline notification, and vice versa. Option A conflates them, making both concepts harder to reason about independently. Option B adds complexity (merge logic, deduplication) for minimal benefit. The env var pattern is consistent with all other Operant configuration (`TWILIO_WHATSAPP_RECIPIENT`, `GITHUB_REPO`, etc.), requires no new file format, and integrates naturally with `.env` files and CI/CD secrets.

**Consequences:** Teams must explicitly list participants in their `.env` file. There is no auto-population from existing config. The whitelist and participants list may overlap (same phone number in both), which is expected and handled correctly -- Twilio participant addition is idempotent (NFC-3), and the existing `parseReply()` logic doesn't care which list a sender is on.

**References:** FR-2, NFC-3 from intent doc; HLD Section 2 (Technology Choices, "Participant source" row), Section 5 (`getWhatsAppParticipants()`)

---

## ADR-006: Add-Only Participant Management — No Automated Removal

**Decision (resolves OQ-5):** Participants are added to the Conversation on creation and never automatically removed when they are dropped from `OPERANT_WHATSAPP_PARTICIPANTS`. Removal is a manual operation via the Twilio console.

**Alternatives:** (A) Cache participant SIDs alongside the Conversation SID; compute a diff on each `ensureConversation()` call; DELETE participants not in the current list. (B) Tear down and recreate the Conversation whenever the participant list changes. (C) Store a snapshot of the last participant list and only diff-detect removals.

**Rationale:** The Twilio Conversations API requires a Participant SID (e.g., `MB...`) to remove a participant -- the phone number alone is insufficient. Caching participant SIDs adds a second persistent file (or a structured JSON file instead of a plain `.txt`) and a diff computation step on every `ensureConversation()` call. This complexity is disproportionate for MVP, especially since participant removal is expected to be rare. Option B (recreate on change) would disrupt the shared conversation thread and is never appropriate. The add-only approach is explicitly safe: adding an existing participant returns HTTP 409, which is logged and skipped (NFC-3). The out-of-scope note OOS-3 establishes that "no interactive add/remove flow" is a deliberate boundary.

**Consequences:** Removing a participant from `OPERANT_WHATSAPP_PARTICIPANTS` does not stop them from receiving messages until someone manually removes them from the Twilio Conversation. Teams must be aware of this and manage removals via the Twilio console. A follow-on feature could cache participant SIDs and automate removal.

**References:** FR-2, NFC-3, OOS-3 from intent doc; HLD Section 2 (Technology Choices, "Participant source" row), Section 13 OQ-5

---

## ADR-007: Project Directory Basename in Conversation `FriendlyName`

**Decision (resolves OQ-3):** When creating a Conversation, set `FriendlyName` to `"Operant Pipeline - <basename>"` where `<basename>` is the last component of `process.cwd()` (e.g., `"Operant Pipeline - my-project"`).

**Alternatives:** (A) Static `"Operant Pipeline Notifications"` for all projects -- simpler but indistinguishable when multiple projects are used from the same Twilio account. (B) Full absolute project path -- too long and includes machine-specific information that leaks local directory structure. (C) A user-configurable `OPERANT_PIPELINE_NAME` env var -- maximum flexibility but adds configuration burden; teams rarely need custom names.

**Rationale:** A static name (Option A) makes Twilio console management difficult when multiple Operant-powered projects share the same Twilio account -- all Conversations appear identically named. Including the project basename makes Conversations identifiable at a glance without exposing machine-specific path information. `process.cwd()` is always available without a new env var or configuration file. The basename is stable for the lifetime of the project directory (teams rarely rename root directories). This resolves OQ-3's recommendation of "project directory basename."

**Consequences:** If a user renames their project directory after the Conversation is created, the `FriendlyName` on the existing Conversation will no longer match the directory. This is cosmetic -- the SID reference in `conversation-sid.txt` remains valid. The `FriendlyName` can be updated manually in the Twilio console.

**References:** FR-1 from intent doc; HLD Section 13 OQ-3, Section 3 (`ensureConversation()` step 3)

---

## ADR-008: `TWILIO_MESSAGING_SERVICE_SID` is Optional with a Startup Warning

**Decision (resolves OQ-4):** `TWILIO_MESSAGING_SERVICE_SID` is optional for all setups. If absent, `ensureConversation()` creates the Conversation without a `MessagingServiceSid`. A warning is logged: `[whatsapp] TWILIO_MESSAGING_SERVICE_SID not set; Conversation creation may fail outside sandbox.`

**Alternatives:** (A) Require `TWILIO_MESSAGING_SERVICE_SID` for all non-sandbox setups; fail loudly at `ensureConversation()` if absent -- safer for production but breaks sandbox users who must now add another env var. (B) Attempt creation without the SID and surface the Twilio API error directly if it fails -- no proactive warning, harder to debug.

**Rationale:** NFC-5 requires sandbox compatibility. The Twilio Sandbox does not require a Messaging Service SID for Conversations -- requiring it unconditionally would violate NFC-5. At the same time, a production WhatsApp Business Account will reject Conversation creation without a Messaging Service. The warning (Option: warn, not fail) threads this needle: sandbox users (the primary development use case) proceed without friction, and production users who haven't set the SID get a clear, actionable log message before the API call fails. If the Twilio API returns a 4xx due to the missing SID, `ensureConversation()` throws, and the caller falls back to 1:1 (FR-5, AC-FR5-2) -- the pipeline is never blocked.

**Consequences:** Production deployments that forget to set `TWILIO_MESSAGING_SERVICE_SID` will silently fall back to 1:1 notifications after logging a warning. Teams upgrading from sandbox to production must add the SID to their `.env`; the warning makes this discoverability straightforward.

**References:** NFC-5 from intent doc; HLD Section 5 (Configuration, `TWILIO_MESSAGING_SERVICE_SID` row), Section 13 OQ-4

---

## ADR-009: Cloud Mode Excludes Group Send — Deferred to `operant-api`

**Decision (resolves OQ-6):** When `OPERANT_API_KEY` is set (cloud mode), all WhatsApp sends continue to route through `cloudSendWhatsApp()` (the `operant-api` proxy). The Conversations API group path is local-mode only.

**Alternatives:** (A) Add a `/api/whatsapp/send-group` endpoint to `operant-api` and call it from cloud mode -- full parity between local and cloud, but requires server-side changes outside this repo. (B) Cloud mode clients set their own `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` locally and use the same Conversations path -- bypasses the proxy, defeating the purpose of cloud mode (centralized credential management, billing). (C) Block cloud mode users from using group notifications entirely with an explicit error.

**Rationale:** Cloud mode routes through `operant-api` to centralize credentials and billing. Adding Conversations API support to the cloud path requires changes to `esxr/operant-api`, which is outside the scope of this feature (OOS-3 is interpreted to include dynamic server-side participant management). Option B undermines cloud mode's security model. Option C is user-hostile given that the 1:1 path still works. The deferred approach (Option: local-only for now) lets cloud mode users continue receiving 1:1 notifications unchanged (NFC-2) while the `operant-api` extension is tracked as a follow-on. The routing decision in `sendGroupNotification()` and `sendGate()` already checks `getMode()` before the Conversations branch (HLD Section 1 architecture diagram), so no cloud-mode user is affected.

**Consequences:** Cloud mode users do not get group notifications until `operant-api` is extended. Teams on cloud mode who need group visibility must switch to local mode or wait for the follow-on. This is documented in the feature's known limitations.

**References:** G-3, FR-5, NFC-2 from intent doc; HLD Section 2 (Technology Choices, "Cloud mode handling" row), Section 13 OQ-6

---

## ADR-010: First-Reply-Wins Gate Resolution via `.once()` — No Participant Identity Check

**Decision:** Gate resolution uses the existing `whatsappEvents.once("whatsapp:reply", handler)` semantics. The first inbound reply from any participant resolves the gate. No participant identity check is performed; the resolver does not verify that the reply came from a known participant.

**Alternatives:** (A) Track the set of known participant phone numbers and only accept replies from that set -- prevents non-participants from resolving gates, but requires parsing `OPERANT_WHATSAPP_PARTICIPANTS` in the reply handler and adds logic for the case where the replier is in `whitelist.json` but not in the participants list. (B) Named-participant tracking that records which participant approved, for audit purposes -- useful but out of scope for MVP.

**Rationale:** AC-FR4-3 requires that the second reply is ignored; `.once()` already guarantees this with no additional code. The gate security model is already established by the Twilio webhook (only the Twilio account's configured phone numbers can POST to `/webhook/whatsapp`), and `whitelist.json` is the trusted-sender allowlist for the pipeline. Adding a separate identity check against `OPERANT_WHATSAPP_PARTICIPANTS` inside the reply handler would be a second layer of authorization that the existing architecture does not have even for 1:1 mode -- it would be inconsistent and unexpected. FR-4 explicitly says "the first valid reply from any participant resolves the gate," with no qualifier about which participant. This design is the simplest correct implementation of that requirement.

**Consequences:** If a participant's reply is heard by the webhook before the `.once()` listener is registered (race condition between send and listen setup), the gate hangs. This pre-existing race condition affects the 1:1 path identically and is not introduced by this feature. The `.once()` listener is registered before the send in both the existing code and the new group branch.

**References:** FR-4, AC-FR4-1, AC-FR4-2, AC-FR4-3 from intent doc; HLD Section 2 (Technology Choices, "Gate reply disambiguation" row), Section 9 (Gate Reply Handling)

---

## ADR-011: `sendGroupNotification()` Consolidates the Inline HTTPS Code in `process-trigger.ts`

**Decision:** Delete the inline Twilio HTTPS invocation in `process-trigger.ts` (`sendGitHubNotification()`) and replace it with a single import of `sendGroupNotification()` from `whatsapp.ts`. All routing logic (group vs. 1:1 vs. cloud) lives inside `sendGroupNotification()`.

**Alternatives:** (A) Keep the inline code in `process-trigger.ts` and add a separate group-send branch alongside it -- results in two parallel Twilio send implementations in different files. (B) Add a `useConversation` parameter to the existing `sendTwilioMessage()` function and branch inside it -- mixes two API shapes into one function.

**Rationale:** The inline HTTPS block in `process-trigger.ts` is already a duplication of logic in `whatsapp.ts`. This feature adds a third delivery path (Conversations). Centralizing all WhatsApp send routing in `whatsapp.ts` avoids a three-way code split (process-trigger inline, sendTwilioMessage 1:1, ensureConversation+sendConversationMessage group). Option A is the existing debt carried forward, not resolved. Option B violates single-responsibility: `sendTwilioMessage()` targets the Messages API (`api.twilio.com`) and should not be responsible for routing to a different API. `sendGroupNotification()` is the correct abstraction: it is the answer to "send a pipeline notification via WhatsApp, by whatever method is currently configured."

**Consequences:** `process-trigger.ts` no longer imports `node:https` directly for WhatsApp (it may still use it for GitHub API calls). The `whatsapp.ts` module becomes the single owner of all WhatsApp send logic, which simplifies future changes (adding a new delivery path means touching one file, not two).

**References:** FR-3, FR-5 from intent doc; HLD Section 7 (process-trigger.ts Changes, Before/After), Section 6 (`sendGroupNotification()`)

---

## ADR-012: Partial Participant-Add Failure is Non-Fatal

**Decision:** If adding a participant to a Conversation returns a non-409 4xx or 5xx error, log a warning and continue adding the remaining participants. Do not abort the `ensureConversation()` call.

**Alternatives:** (A) Abort `ensureConversation()` on any participant-add failure -- clean failure boundary but means one misconfigured number blocks all others from receiving notifications. (B) Retry failed participant adds with exponential backoff -- adds complexity and latency to what is already a first-call-only operation. (C) Queue failed adds for retry on next `ensureConversation()` call -- requires tracking partial state across calls.

**Rationale:** The purpose of participant management is to maximise group coverage. If one participant's number is misconfigured (e.g., a wrong country code), aborting would prevent the remaining correctly configured participants from receiving notifications. The cost of partial failure is that one person misses messages; the cost of aborting is that everyone misses messages. Partial success is strictly better. The Twilio 409 case (participant already in conversation) is already idempotent and logged separately (NFC-3). Other 4xx errors (invalid number format, etc.) are genuine configuration errors that the operator should fix, and the warning log provides the signal to do so. This matches the spirit of FR-5 (graceful degradation): a single misconfigured participant is not a reason to block the pipeline.

**Consequences:** Operators must check logs to detect participant-add failures, as the pipeline will appear to function normally. A misconfigured participant will never be added until the conversation is recreated (e.g., after manual deletion). The log line format is `[whatsapp] Failed to add participant +<number> to conversation <sid>: HTTP <status> — skipping`.

**References:** FR-2, NFC-3, FR-5 from intent doc; HLD Section 3 (`ensureConversation()` step 5c), Section 11 (Error Handling, "POST /Participants returns other 4xx" row)
