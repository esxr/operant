# Intent & Constraints: WhatsApp Group Notifications via Conversations API

**Version:** 1.0
**Date:** 2026-06-18
**Status:** Draft
**Audience:** Implementation team (Claude Code agents)

---

## 1. Problem Statement

Operant's pipeline notifications currently use the Twilio Messages API (`POST /Messages.json`) to send 1:1 WhatsApp messages to a single recipient (`TWILIO_WHATSAPP_RECIPIENT`). This means only one person receives pipeline events (trigger received, gate requests, confirmations).

Teams need **group visibility** — when a GitHub issue triggers the pipeline, multiple team members should see the notification and be able to participate in gate approvals. The current 1:1 approach forces one person to be the sole pipeline operator.

---

## 2. Goals

| ID | Goal |
|----|------|
| G-1 | Pipeline notifications (trigger received, gate requests, confirmations) are delivered to all team members in a single shared WhatsApp conversation. |
| G-2 | Any participant in the conversation can approve or reject gates (not just the original recipient). |
| G-3 | The existing 1:1 notification path continues to work as a fallback when Conversations API is not configured. |
| G-4 | One-time setup creates the conversation and adds participants; subsequent notifications reuse the existing conversation. |

---

## 3. Functional Requirements

### FR-1: Conversation Lifecycle Management

**Summary:** Create and persist a Twilio Conversation for pipeline notifications.

**Details:**

1. On first use (no conversation SID stored), create a new Conversation via the Twilio Conversations API.
2. Store the Conversation SID in `spec/.operant/conversation-sid.txt` for reuse.
3. If the stored conversation is deleted or invalid, detect the error and recreate.

**Acceptance Criteria:**
- AC-FR1-1: First notification creates a Conversation and persists the SID.
- AC-FR1-2: Subsequent notifications reuse the stored SID.
- AC-FR1-3: An invalid/deleted SID triggers recreation.

### FR-2: Participant Management

**Summary:** Add team members as WhatsApp participants in the Conversation.

**Details:**

1. Read participant phone numbers from a config source (env var `OPERANT_WHATSAPP_PARTICIPANTS` as comma-separated `+<number>` list, or from `whitelist.json`).
2. For each participant, add them via `messagingBinding.address` = `whatsapp:+<number>` and `messagingBinding.proxyAddress` = the Twilio WhatsApp number.
3. Adding a participant that already exists should be idempotent (catch the "already exists" error and continue).
4. Participants are added during conversation creation (FR-1) and can be updated via a new `/operant:whitelist` subcommand or manually.

**Acceptance Criteria:**
- AC-FR2-1: All numbers in `OPERANT_WHATSAPP_PARTICIPANTS` are added to the Conversation.
- AC-FR2-2: Re-adding an existing participant does not error.
- AC-FR2-3: Each participant receives messages sent to the Conversation on their WhatsApp.

### FR-3: Send Notification to Conversation

**Summary:** Replace 1:1 message sends with Conversation message sends.

**Details:**

1. Where the pipeline currently calls `sendTwilioMessage()` (in `src/whatsapp.ts`) or the inline Twilio HTTPS call (in `src/cli/process-trigger.ts`), add an alternative path that posts to the Conversations API instead.
2. The Conversations API endpoint: `POST /v1/Conversations/{ConversationSid}/Messages` with `body` and optionally `author`.
3. All existing message formats (gate requests, notifications, confirmations) work unchanged — only the delivery mechanism changes.

**Acceptance Criteria:**
- AC-FR3-1: A pipeline notification sent via Conversations API is received by all participants.
- AC-FR3-2: Gate request messages include the same structured reply options ("Reply 1 to APPROVE").
- AC-FR3-3: The first participant to reply "1" approves the gate for everyone.

### FR-4: Gate Reply Handling

**Summary:** Any participant's reply to the Conversation should be picked up as a gate response.

**Details:**

1. Inbound replies from any participant arrive at the webhook server (`/webhook/whatsapp`) as before — Twilio routes Conversation participant replies through the same webhook.
2. The existing `whatsappEvents` EventEmitter and reply parsing logic should work unchanged — the reply payload includes `From`, `Body`, etc.
3. The first valid reply (from any participant) resolves the gate.

**Acceptance Criteria:**
- AC-FR4-1: Pranav can approve a gate by replying "1" to the group conversation.
- AC-FR4-2: Praneet can also approve a gate by replying "1" — whichever replies first wins.
- AC-FR4-3: The second reply is ignored (gate already resolved).

### FR-5: Graceful Fallback

**Summary:** If Conversations API is not configured, fall back to 1:1 Messages API.

**Details:**

1. If `OPERANT_WHATSAPP_PARTICIPANTS` is not set (or empty), use the existing `TWILIO_WHATSAPP_RECIPIENT` 1:1 path.
2. If Conversation creation fails, log the error and fall back to 1:1.
3. This ensures backward compatibility with existing single-user setups.

**Acceptance Criteria:**
- AC-FR5-1: A setup with only `TWILIO_WHATSAPP_RECIPIENT` (no `OPERANT_WHATSAPP_PARTICIPANTS`) works exactly as before.
- AC-FR5-2: A Conversations API failure does not block the pipeline.

---

## 4. Non-Functional Constraints

| ID | Constraint |
|----|------------|
| NFC-1 | **No new npm dependencies.** Use `node:https` for Conversations API calls, matching the existing Twilio integration pattern. |
| NFC-2 | **Backward compatible.** Existing single-recipient setups must work without any configuration changes. |
| NFC-3 | **Idempotent participant management.** Adding participants multiple times must not error or create duplicates. |
| NFC-4 | **Conversation SID persistence.** Stored in `spec/.operant/conversation-sid.txt` using the same atomic-write pattern as `github-cursor.txt`. |
| NFC-5 | **Twilio Sandbox compatible.** Must work with the Twilio WhatsApp Sandbox (`+14155238886`) for development/testing. |

---

## 5. Out of Scope

| ID | Item | Rationale |
|----|------|-----------|
| OOS-1 | **Meta WhatsApp Groups API (native groups).** Launched Oct 2025 but Twilio support is unclear. Conversations API is the proven path. |
| OOS-2 | **Media attachments in Conversations.** Twilio Conversations doesn't support all media types that the Messages API does. Text-only for now. |
| OOS-3 | **Dynamic participant management UI.** Participants are configured via env var or whitelist. No interactive add/remove flow. |
| OOS-4 | **Read receipts / delivery status per participant.** Nice-to-have but not needed for MVP. |

---

## 6. Key Files Affected

| File | Change |
|------|--------|
| `src/whatsapp.ts` | Add Conversations API send path alongside existing Messages API. Add conversation creation + participant management functions. |
| `src/cli/process-trigger.ts` | Update `sendGitHubNotification` to use Conversations API when configured. |
| `src/config.ts` | Add `getWhatsAppParticipants()` and `getConversationSid()` / `writeConversationSid()`. |
| `scripts/server.ts` | No changes needed — inbound webhook already handles all WhatsApp replies. |
| `spec/.operant/conversation-sid.txt` | **New file (runtime).** Stores the Twilio Conversation SID. |
