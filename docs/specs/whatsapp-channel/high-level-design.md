# High-Level Design: WhatsApp Communication Channel

**Version:** 2.0 (Revised for Claude Code plugin architecture)  
**Date:** 2026-06-07  
**Status:** Implemented

## 1. Overview

The operant Claude Code plugin's human-in-the-loop gates currently couple directly to Retell.ai voice calls. This design introduces a channel abstraction layer between the FSM's side-effect executor and communication providers, then adds Twilio WhatsApp as a second provider. The system auto-selects voice vs WhatsApp per gate based on interaction complexity, with timeout-based escalation from WhatsApp to voice.

## 2. Goals and Non-Goals

### Goals
- Decouple the FSM side-effect executor from Retell-specific API calls
- Add WhatsApp messaging (with PDF attachments) as a gate channel via Twilio
- Auto-select channel per gate mode using deterministic complexity rules
- Escalate unanswered WhatsApp messages to voice calls after a configurable timeout
- Maintain the existing trigger-file + hook notification pattern for all inbound messages

### Non-Goals
- Replacing voice calls entirely — voice remains the primary channel for complex interactions
- Supporting additional channels beyond voice and WhatsApp in this iteration
- Adding conversational AI to WhatsApp (no multi-turn chat — one message out, one reply back)
- Changing FSM states or transitions — the abstraction sits in the executor only
- Building a WhatsApp chatbot or general-purpose messaging system

## 3. System Architecture

### Component Diagram

```
                        ┌─────────────────────────────────────────┐
                        │  Claude Code Plugin (hooks/hooks.json)  │
                        │  Shell script hooks invoke side effects │
                        └──────────┬──────────────────────────────┘
                                   │ SideEffect
                                   │ (TRIGGER_REVIEW_CALL, etc.)
                                   ▼
                        ┌─────────────────────────────┐
                        │    ChannelRouter             │
                        │  - classifyComplexity()      │
                        │  - selectChannel()           │
                        │  - sendGate()                │
                        │  - waitForReply()            │
                        └──────┬──────────┬───────────┘
                               │          │
                 ┌─────────────┘          └──────────────┐
                 ▼                                       ▼
     ┌───────────────────┐                  ┌───────────────────┐
     │  RetellChannel     │                  │  WhatsAppChannel   │
     │  (src/retell.ts)   │                  │  (src/whatsapp.ts) │
     │                    │                  │                    │
     │  makeOutboundCall()│                  │  sendMessage()     │
     │  buildDynamicVars()│                  │  sendMediaMessage()│
     └───────────────────┘                  └───────────────────┘
                 │                                       │
                 ▼                                       ▼
          Retell.ai API                           Twilio API
                 │                                       │
                 ▼                                       ▼
     ┌───────────────────┐                  ┌───────────────────┐
     │  Webhook:          │                  │  Webhook:          │
     │  /webhook/         │                  │  /webhook/         │
     │    call-completed  │                  │    whatsapp        │
     └────────┬──────────┘                  └────────┬──────────┘
              │                                      │
              └──────────────┬───────────────────────┘
                             ▼
                  ┌─────────────────────┐
                  │  scripts/server.ts   │
                  │  - writes trigger    │
                  │    file to pending/  │
                  │  - notifies Claude   │
                  │    Code hook handler │
                  └─────────────────────┘
```

### Component Descriptions

| Component | Responsibility | Key Interfaces |
|-----------|---------------|----------------|
| **ChannelRouter** (`src/channel.ts`) | Selects channel per gate, delegates send/receive, manages timeout escalation | `sendGate(mode, context)`, `onReply(callback)` |
| **RetellChannel** (`src/retell.ts`) | Wraps Retell API for outbound voice calls, unchanged from today | `Channel` interface implementation |
| **WhatsAppChannel** (`src/whatsapp.ts`) | Wraps Twilio API for outbound WhatsApp messages + media | `Channel` interface implementation |
| **scripts/server.ts** (updated) | New `/webhook/whatsapp` and `/media/` endpoints for Twilio inbound messages and PDF serving | HTTP POST handler, trigger file writer, hook notification |
| **hooks/hooks.json** (plugin hooks) | Claude Code plugin hook definitions that trigger shell scripts for session lifecycle, tool guards, artifact detection, and state validation | Shell script hooks invoked at `SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`, etc. |

## 4. Data Flow

### Outbound Gate (WhatsApp path)

```
1. FSM emits TRIGGER_REVIEW_CALL side effect
2. Hook-driven executor calls channelRouter.sendGate("review", context)
3. ChannelRouter.classifyComplexity("review") -> "simple"
4. ChannelRouter.selectChannel("simple") -> WhatsAppChannel
5. WhatsAppChannel.sendMessage():
   a. Generate PDF from artifact markdown via src/pdf.ts (markdownToPdf)
   b. Serve PDF via cloudflared tunnel (scripts/tunnel.sh) at /media/<spec>/<file>.pdf
   c. POST to Twilio API: text summary + mediaUrl
6. ChannelRouter starts timeout timer (10 min default)
7. FSM blocks (same as waiting for a voice call to complete)
```

### Inbound Reply (WhatsApp path)

```
1. User replies on WhatsApp
2. Twilio POSTs to /webhook/whatsapp on scripts/server.ts
3. server.ts validates Twilio signature
4. server.ts matches sender to whitelisted number
5. server.ts parses reply body (text content)
6. server.ts writes trigger file to pending/:
   {
     call_id: "wa-<timestamp>",
     caller_name: <from whitelist>,
     from_number: <sender>,
     source: "whatsapp",
     spec: { decision: "approved"|"rejected", raw_text: "..." },
     created_at: <timestamp>
   }
7. server.ts notifies Claude Code hook handler: { type: "call_completed", ... }
8. ChannelRouter cancels timeout timer
9. FSM processes reply same as voice call transcript
```

### Timeout Escalation

```
1. ChannelRouter timeout fires (no WhatsApp reply in N minutes)
2. ChannelRouter logs escalation event
3. ChannelRouter calls RetellChannel.sendGate(mode, context) as fallback
4. Voice call proceeds normally — reply comes back via existing Retell webhook path
5. Original WhatsApp wait is cancelled (late WhatsApp reply ignored, or acknowledged with "already handled by call")
```

## 5. Technology Choices

| Layer | Choice | Rationale |
|-------|--------|-----------|
| WhatsApp API | Twilio WhatsApp Business API | User preference; Twilio already powers Retell's phone numbers; single vendor for telephony |
| HTTP client | Node.js `https` module | Consistent with existing `src/retell.ts` — no new dependencies |
| PDF generation | `md-to-pdf` npm package (via `src/pdf.ts`) | Convert markdown artifacts to PDF for WhatsApp attachments |
| Media hosting | Serve via cloudflared tunnel (`/media/<filename>`) managed by `scripts/tunnel.sh` | Reuse existing tunnel infrastructure; no separate hosting needed |
| Webhook validation | `twilio` npm package (`validateRequest`) | Official Twilio signature validation to prevent webhook spoofing |
| Reply parsing | Deterministic keyword matching | Consistent with existing `classifyTranscript()` approach — no LLM needed |

## 6. Key Design Decisions

1. **Channel interface in executor, not FSM:** The FSM emits the same side effects as today. The hook-driven executor routes through `ChannelRouter` instead of calling `makeOutboundCall()` directly. This means zero FSM changes (NFC-4).

2. **Router, not strategy pattern:** `ChannelRouter` owns the complexity classification and channel selection. It's not a generic strategy — it knows about gate modes and has hardcoded defaults with configurable overrides.

3. **Timeout escalation is internal:** The FSM doesn't know about WhatsApp timeouts. `ChannelRouter.sendGate()` returns a promise that resolves when a reply arrives — whether that reply came from WhatsApp or an escalated voice call.

4. **Trigger files are channel-agnostic:** WhatsApp replies produce the same `pending/*.json` trigger files as voice calls, with an added `source: "whatsapp"` field. The FSM handler doesn't need to distinguish.

5. **PDF via tunnel:** Artifacts are served as static files through the existing cloudflared tunnel (managed by `scripts/tunnel.sh`) rather than uploading to a third-party CDN. The tunnel URL is already known at runtime.

6. **Structured WhatsApp replies:** Messages include numbered options ("Reply 1 to approve, 2 to reject, or type your feedback"). Parsing is simple `startsWith("1")` / `startsWith("2")` — no NLP needed.

## 7. Open Questions (Resolved)

All open questions have been resolved via ADR decisions:

- [x] **WhatsApp template approval lead time:** Sandbox for dev, templates for prod. See **ADR-003**.
- [x] **Late WhatsApp reply after escalation:** Auto-reply "handled via call", discard. See **ADR-006**.
- [x] **PDF generation vs. markdown link:** PDF for formal artifacts, plain text for confirmations. See **ADR-004**.
- [x] **Single webhook endpoint vs. separate:** Single `/webhook/whatsapp`, disambiguate by payload. See **ADR-008**.
- [x] **Reply timeout value:** Per-mode configurable, 10 min default. See **ADR-006**.
- [x] **Twilio account setup:** Greenfield — new Twilio account being provisioned. See **ADR-003**.
- [x] **WhatsApp number:** Separate number from Retell voice. See **ADR-007**.
- [x] **Reply parsing approach:** Numbered options + keyword fallback. See **ADR-005**.

## 8. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| WhatsApp template approval delays | M | Use Twilio sandbox for dev/test; submit templates early; plain-text fallback |
| Tunnel URL changes break media URLs | M | Generate media URLs at send-time using current tunnel URL; PDF served from same tunnel |
| Free-text replies are ambiguous | L | Use numbered options in messages; fall back to keyword matching; escalate to call if unparseable |
| Twilio rate limits on WhatsApp | L | Single user, low volume (few messages per pipeline run); monitor 429s |
| PDF generation adds build dependency | L | Use lightweight `md-to-pdf`; fallback to raw markdown link if generation fails |
| Late WhatsApp reply after voice escalation | L | Auto-reply "handled via call"; idempotent trigger file processing prevents double-action |

## 9. Traceability

| Intent Requirement | HLD Section | Notes |
|--------------------|-------------|-------|
| FR-1: Channel Interface | 3 (ChannelRouter, RetellChannel, WhatsAppChannel) | Three modules: `src/channel.ts`, `src/retell.ts`, `src/whatsapp.ts` |
| FR-2: Twilio WhatsApp Provider | 3 (WhatsAppChannel), 5 (Technology) | Implemented in `src/whatsapp.ts` |
| FR-3: Complexity-Based Selection | 4 (Outbound Gate flow, step 3-4) | Deterministic rules in ChannelRouter (`src/channel.ts`) |
| FR-4: WhatsApp Reply Handling | 4 (Inbound Reply flow) | `/webhook/whatsapp` endpoint on `scripts/server.ts` |
| FR-5: Timeout and Escalation | 4 (Timeout Escalation flow) | Internal to ChannelRouter |
| FR-6: Rich Content | 4 (Outbound Gate flow, step 5) | PDF generation via `src/pdf.ts` + tunnel serving via `scripts/tunnel.sh` |
| NFC-1: Preserve Voice Path | 6 (Decision 1) | RetellChannel wraps existing code unchanged |
| NFC-2: Notification Consistency | 6 (Decision 4) | Same trigger file pattern, `source` field added |
| NFC-4: No FSM Changes | 6 (Decision 1) | Abstraction in executor only |
| NFC-6: Security | 5 (Webhook validation) | Twilio signature validation + whitelist |
