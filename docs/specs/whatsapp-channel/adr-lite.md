# Architecture Decisions: WhatsApp Communication Channel

**Last Updated:** 2026-06-07

---

## ADR-001: Channel Abstraction in Side-Effect Executor, Not FSM

**Status:** Accepted

**Context:**  
The FSM in `src/state-machine.ts` emits side effects like `TRIGGER_REVIEW_CALL` and `TRIGGER_BLOCKER_CALL`. In the Claude Code plugin model, hook-driven shell scripts (registered in `hooks/hooks.json`) handle these side effects by invoking the appropriate TypeScript modules. Adding WhatsApp requires the executor to choose between providers. The question is where the abstraction boundary sits: modify the FSM to emit channel-aware events, or keep the FSM unchanged and add the abstraction in the executor.

**Decision:**  
Add a `ChannelRouter` in the side-effect executor. The FSM continues to emit the same `TRIGGER_*_CALL` side effects. The hook-driven executor delegates to `ChannelRouter.sendGate()` instead of calling Retell directly. The router selects the channel and returns a promise that resolves when a reply arrives (from either channel).

**Alternatives Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A. Abstraction in executor (chosen) | Zero FSM changes; FSM tests stay untouched; side effects remain semantically the same | Executor gets more complex; "CALL" in side-effect names is misleading |
| B. New FSM side effects (`TRIGGER_REVIEW_MESSAGE`) | FSM is explicitly channel-aware; cleaner naming | Breaks all FSM tests; adds new state/event types; FSM logic leak |
| C. Channel selection in FSM transitions | Full control over channel at state level | Violates NFC-4; couples FSM to provider concerns; massive refactor |

**Rationale:**  
NFC-4 (intent doc) explicitly prohibits FSM state changes. The FSM has passing unit and integration tests — all of which would break if we touched transitions. The "CALL" naming is a misnomer after this change, but renaming side effects is cosmetic and can happen later without functional impact.

**Consequences:**
- FSM tests continue to pass without modification
- Hook-driven side-effect execution routes 4 `TRIGGER_*` cases through `channelRouter.sendGate()` calls
- Side effect type names (`TRIGGER_REVIEW_CALL`) are misleading — they now mean "trigger a gate interaction" not "make a phone call". Accept this for now; rename in a future PR if desired.

**Resolves:** HLD Section 6, Decision 1; HLD Open Question (implicit: where does abstraction live?)

---

## ADR-002: Deterministic Complexity Classification (No LLM)

**Status:** Accepted

**Context:**  
The system must auto-select voice vs WhatsApp per gate. This requires classifying each gate interaction's complexity. Options range from a static mapping to an LLM-based classifier.

**Decision:**  
Use a static mapping from gate mode to complexity, stored as a configuration object in `src/channel.ts`. Default rules:

```typescript
const COMPLEXITY_MAP: Record<CallMode, "simple" | "complex"> = {
  confirmation: "simple",    // WhatsApp
  review: "simple",          // WhatsApp (with PDF)
  demo_invite: "simple",     // WhatsApp (just a link)
  blocker: "complex",        // Voice call
  requirements: "complex",   // Voice call
};
```

Allow per-mode override via environment variable: `CHANNEL_OVERRIDE_review=voice` forces reviews to voice.

**Alternatives Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A. Static mapping (chosen) | Deterministic, zero latency, no API cost, testable | Can't adapt to context (e.g., a simple blocker with 2 options vs complex one with 5) |
| B. LLM classifier | Could weigh context dynamically | Violates NFC-5 (no new API calls — plugin uses deterministic logic); adds latency; non-deterministic |
| C. Heuristic on context fields | Middle ground — count blocker options, transcript length | More complex; edge cases; still rule-based |

**Rationale:**  
NFC-5 (intent doc) requires no new Anthropic API calls — channel selection is deterministic logic internal to the plugin. A static map is consistent with the existing `classifyTranscript()` pattern in `src/state-machine.ts` which also uses keyword heuristics. The 5 gate modes have clear complexity profiles: requirements/blockers need nuanced conversation, reviews/confirmations/invites are yes/no decisions.

**Consequences:**
- Channel selection is fully predictable and testable
- A blocker with a trivial resolution still gets a phone call — accepted trade-off for simplicity
- Per-mode env-var overrides provide an escape hatch without code changes

**Resolves:** HLD Open Question: Design Alternatives (complexity classification approach)

---

## ADR-003: Twilio WhatsApp Sandbox for Development, Templates for Production

**Status:** Accepted

**Context:**  
WhatsApp Business API requires Meta-approved message templates for business-initiated (outbound) messages. Template approval takes 24-48 hours. During development, Twilio provides a sandbox that allows free-form messages without templates.

**Decision:**  
Use Twilio WhatsApp Sandbox for development and testing. In parallel, submit message templates for each gate mode (review, confirmation, demo_invite). Production deployment switches to approved templates. The `WhatsAppChannel` implementation checks for a `TWILIO_WHATSAPP_SANDBOX=1` env var to determine which message format to use.

**Alternatives Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A. Sandbox for dev, templates for prod (chosen) | Unblocks development immediately; templates ready by deploy time | Two code paths (sandbox vs template); sandbox has limitations |
| B. Templates only | Single code path; production-ready from start | Blocks development until templates approved; iterating on message content requires re-approval |
| C. Twilio Content API (template abstraction) | Twilio manages template lifecycle | Added complexity; still needs Meta approval; heavier integration |

**Rationale:**  
HLD Open Question asked about template approval lead time. Sandbox mode eliminates this blocker for development. Template submission is a parallel workstream — by the time code is ready for production, templates should be approved. The branching logic is minimal (message body format only).

**Consequences:**
- Development can start immediately without waiting for Meta approval
- Need to submit and maintain 3 message templates (review, confirmation, demo_invite)
- Sandbox requires the recipient to opt-in with a join code first — acceptable for single-user dev

**Resolves:** HLD Open Question: WhatsApp template approval lead time

---

## ADR-004: Serve Artifact PDFs via Cloudflared Tunnel

**Status:** Accepted

**Context:**  
WhatsApp media messages require a publicly accessible URL for attachments. Artifacts (HLD, ADR, EIS) are markdown files in the local spec directory. They need to be converted to PDF and made accessible for Twilio to fetch.

**Decision:**  
Add a `/media/<spec>/<filename>.pdf` route to `scripts/server.ts`. When a WhatsApp gate needs an attachment:
1. Convert the markdown artifact to PDF using `md-to-pdf` via `src/pdf.ts` (`markdownToPdf` function)
2. Write the PDF to a `media/` directory under the data dir
3. Construct the URL using the current cloudflared tunnel URL (managed by `scripts/tunnel.sh`): `${tunnelUrl}/media/${spec}/${filename}.pdf`
4. Pass this URL as `mediaUrl` in the Twilio API call

**Alternatives Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A. Serve via tunnel (chosen) | Reuses existing infrastructure; no third-party upload; URL available immediately | Tunnel URL changes on restart; PDF must be generated before sending |
| B. Upload to S3/GCS | Stable URL; survives tunnel restart | New AWS/GCP dependency; credential management; overkill for single-user |
| C. Upload to Twilio Assets | Stays in Twilio ecosystem | 1MB limit; manual upload process; not designed for dynamic content |
| D. Send markdown as text body | No PDF generation needed | Loses formatting; WhatsApp has 4096 char limit; artifacts exceed this |

**Rationale:**  
The cloudflared tunnel (managed by `scripts/tunnel.sh`) is already running and publicly accessible. Adding a static file route is trivial. The tunnel URL is known at runtime. Yes, the URL changes on tunnel restart — but the tunnel only restarts when the pipeline restarts, and at that point no messages are in-flight.

**Consequences:**
- PDF generation implemented in `src/pdf.ts` using `md-to-pdf`
- Route in `scripts/server.ts`: `GET /media/:spec/:file`
- PDFs are ephemeral — regenerated per send, not cached long-term
- If tunnel restarts mid-send, the media URL breaks — accepted because tunnel restarts kill the pipeline anyway

**Resolves:** HLD Open Question: Design Alternatives (PDF generation vs markdown link); Intent NFC-2 boundary (media hosting)

---

## ADR-005: Structured Reply Options with Keyword Fallback

**Status:** Accepted

**Context:**  
Voice calls produce structured `call_analysis` via Retell. WhatsApp replies are free-text. The system needs to parse WhatsApp replies to extract decisions (approved/rejected/resolution).

**Decision:**  
Outbound WhatsApp messages include numbered options:
```
Reply 1 to APPROVE
Reply 2 to REJECT (include feedback)
Or type your detailed feedback
```

Reply parsing logic (in `src/whatsapp.ts` `parseReply()` function, in order):
1. Exact match: `"1"` -> approved, `"2"` -> rejected
2. Keyword match: "approve"/"approved"/"lgtm"/"ship it"/"yes" -> approved; "reject"/"rejected"/"no"/"changes needed" -> rejected
3. Anything else -> treated as feedback text, classified as rejected-with-notes (conservative — don't auto-approve ambiguous replies)

**Alternatives Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A. Numbered options + keyword fallback (chosen) | Simple to implement; clear UX; deterministic | Can't handle nuanced responses ("mostly good but change X") |
| B. WhatsApp interactive buttons | Native button UI; no parsing needed | Requires approved templates; buttons limited to 3 options; not available in sandbox |
| C. LLM-based reply parsing | Handles nuance; natural language | Violates NFC-5; adds latency; non-deterministic |

**Rationale:**  
Consistent with the existing `classifyTranscript()` approach — deterministic keyword matching. Numbered options are universally understood and remove ambiguity. The conservative default (unknown = rejected-with-notes) prevents auto-approving something the user didn't explicitly approve, which is the safer direction.

**Consequences:**
- Simple, testable parsing logic
- Nuanced feedback (e.g., "approve but change the button color") is classified as rejection with the full text as revision notes — slightly aggressive but safe
- Interactive buttons can be added later when templates are approved (non-breaking upgrade)

**Resolves:** HLD Open Question (implicit: reply parsing approach); Intent boundary #3 (reply parsing ambiguity)

---

## ADR-006: Timeout Escalation Internal to ChannelRouter

**Status:** Accepted

**Context:**  
WhatsApp messages may go unanswered. The FSM shouldn't block indefinitely. The question is whether timeout/escalation logic lives in the FSM (new states/events) or in the channel layer.

**Decision:**  
`ChannelRouter.sendGate()` returns a `Promise<GateReply>` that internally manages the timeout. Flow:

1. Send via WhatsApp
2. Start timer (configurable per mode, default 10 min)
3. If reply arrives before timeout: resolve promise with WhatsApp reply
4. If timeout fires: log escalation, cancel WhatsApp wait, send via RetellChannel, resolve promise with voice reply
5. If late WhatsApp reply arrives after escalation: auto-reply "Handled via phone call", discard

The FSM sees a single `await channelRouter.sendGate()` call — it doesn't know about the timeout or escalation.

**Alternatives Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A. Internal to ChannelRouter (chosen) | Zero FSM changes; clean async interface; escalation is an implementation detail | ChannelRouter has more responsibility; harder to test escalation path |
| B. FSM timeout event | FSM controls escalation; explicit state transitions | New FSM events (WHATSAPP_TIMEOUT); new states; breaks NFC-4 |
| C. External timer in hook scripts | Hook manages timeout; ChannelRouter is simpler | Leaks channel concerns into hook scripts; more coupling |

**Rationale:**  
NFC-4 prohibits FSM changes. The timeout is a channel-layer concern — the FSM only cares about "I need a human decision at this gate." How that decision arrives (WhatsApp, voice, carrier pigeon) is the channel layer's job. The `Promise<GateReply>` interface is clean and testable — mock the timer in tests.

**Consequences:**
- `ChannelRouter` manages two concurrent listeners (WhatsApp webhook + voice webhook) during escalation — needs careful cleanup
- Per-mode timeout config: `{ confirmation: 5*60*1000, review: 10*60*1000, demo_invite: 10*60*1000 }`
- Late WhatsApp replies require a "stale gate" check in the webhook handler — if no pending gate, auto-reply and discard

**Resolves:** HLD Open Question: Reply timeout value; HLD Section 6, Decision 3

---

## ADR-007: Separate WhatsApp Number from Retell Voice Number

**Status:** Accepted

**Context:**  
Retell uses a Twilio-provisioned phone number for voice calls. WhatsApp requires a WhatsApp-enabled number. The question is whether to use the same number or a separate one.

**Decision:**  
Use a separate Twilio WhatsApp-enabled number. Store it as `TWILIO_WHATSAPP_NUMBER` environment variable (in `whatsapp:` format, e.g., `whatsapp:+1XXXXXXXXXX`).

**Alternatives Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A. Separate number (chosen) | No conflict with Retell; independent lifecycle; cleaner routing | User sees two numbers; extra Twilio cost (~$1/mo) |
| B. Same number | Single identity; user recognizes the number | May conflict with Retell's Twilio integration; WhatsApp Business registration could interfere with voice routing |

**Rationale:**  
Retell manages its own Twilio sub-account for voice. Sharing that number with a direct Twilio WhatsApp integration risks routing conflicts. A dedicated WhatsApp number costs ~$1/month and eliminates any interference between providers. The user (single user) can save both numbers as contacts.

**Consequences:**
- Need to provision a new Twilio number with WhatsApp capability
- New env vars: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_NUMBER`
- Whitelist matching works by phone number (without `whatsapp:` prefix) — same whitelist for both channels

**Resolves:** HLD Open Question: Clarifications Needed (same or separate number)

---

## ADR-008: Single Webhook Endpoint for All Twilio WhatsApp Callbacks

**Status:** Accepted

**Context:**  
Twilio sends multiple types of WhatsApp callbacks: inbound messages, delivery status updates (sent, delivered, read, failed). These can be routed to one endpoint or separate ones.

**Decision:**  
Single endpoint: `POST /webhook/whatsapp` on `scripts/server.ts`. Disambiguate by payload fields:
- Inbound message: has `Body`, `From`, `To` fields
- Status callback: has `MessageStatus` field (`sent`, `delivered`, `read`, `failed`)

Inbound messages trigger the gate reply flow. Status callbacks are logged but don't trigger FSM events (delivery confirmation is nice-to-have observability, not flow control).

**Alternatives Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A. Single endpoint (chosen) | One URL to configure in Twilio; simpler tunnel routing | Payload disambiguation logic needed |
| B. Separate endpoints (`/webhook/whatsapp/inbound`, `/webhook/whatsapp/status`) | Cleaner separation; no disambiguation | Two URLs to configure; more routes in server.ts |

**Rationale:**  
Twilio's webhook configuration allows one URL per number for messaging. Splitting requires Twilio Flow or Studio, which adds unnecessary complexity. The payload shapes are distinct and easy to differentiate.

**Consequences:**
- Single URL configured in Twilio console for the WhatsApp number
- Status callbacks logged for observability (delivery tracking)
- Failed delivery status could trigger early escalation to voice — future enhancement, not in scope now

**Resolves:** HLD Open Question: Design Alternatives (single vs separate webhook endpoint)
