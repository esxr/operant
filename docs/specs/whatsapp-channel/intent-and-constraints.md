# Intent and Constraints: WhatsApp Communication Channel

**Status:** Implemented

## Problem Statement

The operant Claude Code plugin's human-in-the-loop mechanism is currently voice-only (Retell.ai phone calls). Every FSM gate — review, blocker, confirmation, demo invite — triggers an outbound phone call. This works but has limitations:

1. **Overhead mismatch:** Simple confirmations ("ship it?") don't need a full phone call. A WhatsApp message with a PDF attachment is faster and less intrusive.
2. **No rich content:** Voice calls deliver summaries via text-to-speech. The human can't see the actual artifact (HLD, ADR, EIS) during the call. WhatsApp can send the document itself.
3. **Single channel dependency:** If the user can't take a call (meeting, noisy environment), the pipeline blocks indefinitely.

## Goals

1. **Channel abstraction:** Introduce a `Channel` interface so the FSM is decoupled from any specific communication provider. Both Retell (voice) and Twilio WhatsApp implement this interface.
2. **WhatsApp as second channel:** Implement WhatsApp messaging via Twilio's WhatsApp Business API for sending gate messages and receiving user replies.
3. **Automatic channel selection:** The system picks voice vs WhatsApp per gate based on interaction complexity. Simple gates (confirmations, straightforward reviews) go to WhatsApp. Complex gates (blockers with multiple options, requirement gathering) use voice.
4. **Timeout escalation:** WhatsApp messages block the FSM waiting for a reply. If no reply arrives within a configurable timeout, automatically escalate to a phone call.
5. **Rich content delivery:** WhatsApp gates send artifacts as attachments (PDFs) rather than text-only summaries.

## Functional Requirements

### FR-1: Channel Interface
- Define a `Channel` interface with methods covering the full gate lifecycle: send a gate message, wait for a response, handle timeout.
- Retell voice becomes one implementation of this interface (wrapping existing `retell.ts` logic).
- Twilio WhatsApp becomes a second implementation.
- The FSM side-effect executor (invoked via Claude Code plugin hooks in `hooks/hooks.json` and shell scripts) calls the channel interface, never a provider directly.

### FR-2: Twilio WhatsApp Provider
- Send outbound WhatsApp messages via Twilio's WhatsApp API.
- Support text messages with structured content (gate mode, artifact summary, action options).
- Support media attachments (PDF documents for artifacts).
- Receive inbound WhatsApp replies via Twilio webhook.
- Parse user replies to extract decisions (approved/rejected, resolution choice, confirmation).

### FR-3: Complexity-Based Channel Selection
- Each gate interaction has a complexity classification: `simple` or `complex`.
- Classification rules (configurable, with sensible defaults):
  - `confirmation` mode -> simple (WhatsApp)
  - `review` mode -> simple (WhatsApp, with artifact PDF attached)
  - `blocker` mode -> complex (voice call — multiple options, nuanced discussion)
  - `requirements` mode -> complex (voice call — open-ended conversation)
  - `demo_invite` mode -> simple (WhatsApp — just a link)
- Allow per-mode override via configuration.

### FR-4: WhatsApp Reply Handling
- New webhook endpoint(s) on `scripts/server.ts` for Twilio WhatsApp callbacks (inbound messages, delivery status).
- Inbound WhatsApp messages matched to the pending gate by sender phone number.
- Reply parsed to extract the user's decision (approve/reject/resolution text).
- Write a trigger file to `pending/` following the same notification pattern as voice calls.
- Notify the FSM via the Claude Code hook handler just like voice webhooks do.

### FR-5: Timeout and Escalation
- Configurable timeout per gate mode (default: 10 minutes for WhatsApp).
- If no WhatsApp reply within the timeout, cancel the WhatsApp wait and escalate to a voice call via Retell.
- Escalation is transparent to the FSM — same channel interface, the provider handles the fallback internally.
- Log escalation events for observability.

### FR-6: Rich Content / Artifact Attachments
- For review gates, generate a PDF of the artifact (or use the markdown file directly if Twilio supports it).
- Attach the artifact to the WhatsApp message.
- Include a short text summary alongside the attachment.
- Support WhatsApp message templates if required by Twilio/Meta for business-initiated messages.

## Non-Functional Constraints

### NFC-1: Preserve Existing Voice Path
- The Retell voice path must continue to work exactly as it does today. This is additive, not a replacement.
- Mock mode (`SECONDAXIS_MOCK=1`) must work for both channels.

### NFC-2: Notification Pattern Consistency
- WhatsApp inbound messages must follow the same `pending/` trigger file + hook notification pattern as voice call webhooks. No new notification mechanism.

### NFC-3: Twilio WhatsApp API
- Provider: Twilio WhatsApp Business API (not Meta Cloud API directly).
- Requires: Twilio Account SID, Auth Token, WhatsApp-enabled Twilio phone number.
- WhatsApp message templates may be required for business-initiated (outbound) messages per Meta policy.

### NFC-4: No FSM State Changes
- The FSM states and transitions in `src/state-machine.ts` must NOT change. The channel abstraction sits between the FSM's side effects and the provider. The FSM emits the same `TRIGGER_REVIEW_CALL`, `TRIGGER_BLOCKER_CALL`, etc. side effects — the executor decides which channel to use.

### NFC-5: Plugin Architecture
- All execution is native to the operant Claude Code plugin. Side-effect routing and gate channel selection are part of the plugin's internal logic, orchestrated via hooks registered in `hooks/hooks.json` and executed as shell scripts under `scripts/`.
- No new Anthropic API calls for channel selection — use deterministic rules.

### NFC-6: Security
- Twilio credentials stored as environment variables (same pattern as Retell).
- Validate inbound WhatsApp webhook signatures (Twilio request validation) to prevent spoofing.
- Only accept messages from whitelisted phone numbers (reuse `whitelist.json`).

## Known Boundaries and Limitations

1. **WhatsApp Business API approval:** Twilio WhatsApp requires a registered WhatsApp Business number. Template messages need Meta approval. This is an onboarding step, not a code concern.
2. **Media hosting:** WhatsApp attachments require a publicly accessible URL. PDFs must be hosted via the cloudflared tunnel (managed by `scripts/tunnel.sh`).
3. **Reply parsing ambiguity:** Voice calls have Retell's structured `call_analysis`. WhatsApp replies are free-text. Parsing "approved" vs "rejected" from text is simpler but may need basic NLP or structured reply options (numbered choices, quick-reply buttons).
4. **Rate limits:** Twilio WhatsApp has rate limits and template message requirements for business-initiated conversations. Within a 24-hour reply window, free-form messages are allowed.
5. **Single concurrent gate:** The current FSM processes one gate at a time. WhatsApp doesn't change this — one pending message per gate, one reply expected.
