<!-- #core -->
<!-- #google_meet_screen_share -->
# Intent & Constraints: Google Meet Live Demo Channel

**Version:** 1.0  
**Date:** 2026-06-06  
**Status:** Draft  
**Source:** Chat refinement with Pranav Dhoolia  
**Audience:** Implementation agents (Claude Code plugin)  
**Depends on:** `00-init` (base pipeline architecture), `01-glasses-channel` (channel abstraction — conceptual reference only; this is NOT a channel)

---

## 1. Problem Statement

When the audit phase passes (`AUDIT_PASSED`), the pipeline currently calls the user on the phone and verbally describes what was built: "The feature passed visual verification. All 12 FRs verified. Are you satisfied?" The user must form a mental model of the product entirely from a verbal summary — they never actually *see* it. This creates three problems:

1. **Approval without evidence.** The user is approving or rejecting work they haven't seen. The auditor-browser verified it visually, but the user is making a decision based on a secondhand verbal report. Rejections are vague ("something doesn't feel right") because the user can't point at specific UI elements.

2. **No interactive exploration.** The confirmation call is one-directional: the voice agent talks, the user listens, the user says "yes" or "no." The user cannot say "show me the settings page" or "what happens if I click that button?" They cannot explore the product or test edge cases before approving.

3. **Demo gap for stakeholders.** When the user wants to show the product to someone else (a co-founder, a client, an investor), they have to set up their own demo. The pipeline that *built* the product is the best entity to *demo* it — it knows every FR, every edge case, every navigation path.

**Solution:** After the audit passes and before the confirmation call, insert a **live demo phase** where the agent:
- Creates a Google Meet
- Calls the user to join the Meet
- Joins the Meet as a bot participant with screen share + audio
- Navigates the running product in a browser, showing each implemented feature
- Narrates what it's showing via a voice agent *inside* the Meet
- Listens for user commands ("go back", "click on settings", "what happens if...") and drives the browser accordingly
- Captures the user's feedback as structured approval/rejection

This is conceptually different from a "channel" (like phone or glasses). Channels are communication modalities — ways to send and receive messages. The live demo is an **interaction mode** that orchestrates multiple technologies (Meet, browser automation, voice AI, tunnel) into a coherent experience.

**Integration with the FSM:** The demo states (`demo_setup`, `demo_calling`, `demo_active`, `demo_feedback`) and events (`DEMO_READY`, `USER_JOINED_MEET`, `WALKTHROUGH_COMPLETE`, `DEMO_APPROVED`, `DEMO_REJECTED`, `DEMO_SKIPPED`, `DEMO_FAILED`) are already implemented in `src/state-machine.ts`. The FSM routes `AUDIT_PASSED` → `demo_setup` instead of directly to `confirmation`. Side effects (`CREATE_DEMO`, `TRIGGER_DEMO_INVITE_CALL`, `START_WALKTHROUGH`, `CAPTURE_FEEDBACK`, `WRITE_DEMO_REVISION`, `TEARDOWN_DEMO`) are defined in the state machine types and dispatched via plugin hooks.

---

## 2. Goals

- **G-1:** After audit passes, the agent autonomously creates a Google Meet, calls the user, joins the Meet as a bot, shares its screen showing the product, and walks the user through every implemented FR — no manual setup required.
- **G-2:** The experience is fully bidirectional. The user can interrupt, ask questions, request navigation ("show me the error state for FR-3"), and the agent drives the browser in real time while narrating what it's doing.
- **G-3:** The voice agent inside the Meet is a unified participant — one bot that shares screen AND speaks/listens. The user sees one "Operant Demo" participant in the Meet, not separate screen-share and audio bots.
- **G-4:** The demo follows a structured walkthrough plan derived from the implementation spec's functional requirements, but deviates on demand when the user asks to explore something specific.
- **G-5:** The user's verbal feedback during the demo (approval, rejection, specific complaints, navigation requests) is captured and structured into the same trigger-file format the pipeline already uses, enabling the existing confirmation → complete/revision flow.
- **G-6:** The full Meet lifecycle is autonomous: create → call user → join → share → narrate → capture feedback → leave → tear down. No human intervention on the agent side.

---

## 3. Functional Requirements

### FR-1: New FSM Phase — `demo`

- **FR-1.1:** Insert a new phase group `demo` between `audit` (P2) and `confirmation`. The new transition path is: `AUDIT_PASSED` → `demo` → (user satisfied) → `confirmation` → `complete`, or `demo` → (user rejects) → `dev` (with new revision).
- **FR-1.2:** New FSM states:
  | State | Description |
  |-------|-------------|
  | `demo_setup` | Creating Meet, starting tunnel, preparing walkthrough plan |
  | `demo_calling` | Outbound call in progress, telling user to join Meet |
  | `demo_active` | Bot is in Meet, sharing screen, narrating, and listening |
  | `demo_feedback` | Demo complete, capturing user's structured feedback |
- **FR-1.3:** New transitions:
  | From | To | Trigger | Side Effects |
  |------|----|---------|--------------|
  | `audit` | `demo_setup` | `AUDIT_PASSED` | Create Meet, prepare walkthrough |
  | `demo_setup` | `demo_calling` | `DEMO_READY` | Call user to join Meet |
  | `demo_calling` | `demo_active` | `USER_JOINED_MEET` | Bot starts walkthrough |
  | `demo_active` | `demo_feedback` | `WALKTHROUGH_COMPLETE` | Capture feedback |
  | `demo_feedback` | `confirmation` | `DEMO_APPROVED` | Trigger confirmation call |
  | `demo_feedback` | `dev` | `DEMO_REJECTED` | Write revision, restart dev |
  | `demo_calling` | `confirmation` | `DEMO_SKIPPED` | User declines Meet, fallback to voice-only confirmation |
- **FR-1.4:** The `demo` phase is the default path after `AUDIT_PASSED`. The user can skip it during the setup call ("I don't need a demo, just confirm") which triggers `DEMO_SKIPPED` → falls back to the existing voice-only confirmation flow.

### FR-2: Google Meet Lifecycle

- **FR-2.1:** Create a Google Meet programmatically. Two options (to be resolved in ADR):
  - **Option A:** Google Meet REST API v2 — `POST https://meet.googleapis.com/v2/spaces` — returns a standalone `meetingUri`. No calendar event.
  - **Option B:** Google Calendar API — `POST /calendar/v3/calendars/primary/events` with `conferenceDataVersion=1` and `conferenceData.createRequest`. Returns a calendar event with a Meet link. Sends calendar invite to the user's email.
- **FR-2.2:** Extract the user-facing Meet join URL (e.g., `https://meet.google.com/abc-defg-hij`).
- **FR-2.3:** Store the Meet URL and meeting metadata in `spec/<name>/.demo/meet.json` for the current spec.
- **FR-2.4:** After the demo completes (or user leaves), clean up: the bot leaves the Meet. No need to explicitly delete the Meet space (it expires naturally).
- **FR-2.5:** Authentication: Use a Google Cloud service account or OAuth2 credentials for the Meet/Calendar API. Credentials stored in project `.env`.

### FR-3: Meet Bot (Browser-Based Participant)

- **FR-3.1:** Launch a Chromium browser instance (via Playwright) that navigates to the Meet URL and joins as a participant named "Operant Demo".
- **FR-3.2:** The browser must be launched with flags that enable:
  - Auto-accept camera/mic permissions (`--use-fake-ui-for-media-stream`)
  - Screen/tab sharing without user interaction (`--auto-select-desktop-capture-source`)
  - Audio input from a virtual device (for TTS output → Meet microphone)
  - Audio output capture (Meet audio → STT input)
- **FR-3.3:** The bot authenticates to Google using pre-seeded session cookies or a Google account dedicated to the bot. The bot must bypass the "ask to join" / "waiting room" flow — it should auto-admit (as the Meet creator) or the Meet should be configured with no waiting room.
- **FR-3.4:** Once in the Meet, the bot initiates screen sharing of a specific browser tab — the tab running the product at its local/tunnel URL.
- **FR-3.5:** The bot runs in headed mode with a virtual display (Xvfb on Linux, or native display on macOS). True headless mode does not support screen sharing in Meet.
- **FR-3.6:** The Meet bot and the product browser can be the same Playwright browser instance (two tabs: one for Meet, one for the product) or two separate browser instances. The shared-tab approach means the bot shares "this tab" (the product tab). Resolved in ADR-002: two-tab single Chromium.

### FR-4: Voice Agent Inside the Meet

- **FR-4.1:** The bot must have bidirectional audio inside the Meet:
  - **Outbound (TTS → Meet):** The voice agent's text-to-speech output is piped into the bot's microphone input. Other Meet participants hear the agent narrating.
  - **Inbound (Meet → STT):** Audio from other Meet participants (the user speaking) is captured from the bot's audio output and piped to a speech-to-text engine.
- **FR-4.2:** The voice AI pipeline is: User speaks → (Meet audio) → STT → LLM (with context about current screen state, walkthrough plan, spec) → TTS → (Meet audio) → User hears.
- **FR-4.3:** The voice agent must support real-time conversation — not batch processing. Latency from user utterance to agent response should be under 2 seconds (excluding network latency).
- **FR-4.4:** The voice agent has access to:
  - The walkthrough plan (derived from implementation spec FRs)
  - The current browser state (URL, visible elements, screenshot)
  - The implementation spec and all revisions
  - Browser control tools (navigate, click, type, scroll)
- **FR-4.5:** Audio routing approach (to be resolved in ADR):
  - **Option A: Virtual audio devices.** Use PulseAudio (Linux) or BlackHole/Soundflower (macOS) to create virtual audio devices. TTS writes to a virtual mic that the browser reads as its input device. Browser audio output routes to a virtual speaker that STT reads from.
  - **Option B: Managed service.** Use Recall.ai or MeetStream.ai to handle Meet bot + audio routing. The managed service provides WebSocket endpoints for sending/receiving audio.
  - **Option C: WebRTC injection.** Pipe audio directly into the browser's WebRTC streams using Chrome DevTools Protocol (CDP) or `--use-fake-device-for-media-stream` with a custom audio file/stream.

### FR-5: Product Browser & Navigation

- **FR-5.1:** The product browser navigates to `localhost:<port>` (the dev server running the built feature). No tunnel required for the bot — it runs on the same machine. A tunnel URL is optionally created if the user wants to open the product in their own browser simultaneously.
- **FR-5.2:** The bot uses the existing `my-browser` or `auditor-browser` Playwright MCP to control the product browser. Navigation commands from the voice agent (derived from the user's speech or the walkthrough plan) are translated into Playwright MCP tool calls: `browser_navigate`, `browser_click`, `browser_type`, `browser_snapshot`, `browser_take_screenshot`.
- **FR-5.3:** Before starting the demo, the bot verifies the dev server is running. If not, it starts it (same logic as the audit phase, FR-4.4 from `00-init`).
- **FR-5.4:** The walkthrough plan is an ordered list of steps derived from the implementation spec's FRs:
  ```
  Step 1: Navigate to /dashboard — show FR-1 (Dashboard overview)
  Step 2: Click "Settings" — show FR-2 (Settings page)
  Step 3: Toggle notification preference — show FR-3 (Toggle functionality)
  ...
  ```
  Each step includes: URL, action sequence, expected visual state, narration script.
- **FR-5.5:** When the user requests ad-hoc navigation ("show me what happens if I enter an invalid email"), the voice agent interrupts the walkthrough plan, executes the user's request via browser tools, narrates the result, and offers to resume the plan.

### FR-6: Walkthrough Plan Generation

- **FR-6.1:** Before the demo starts (during `demo_setup`), generate a walkthrough plan from `spec/<name>/implementation-spec.md`.
- **FR-6.2:** The plan is a JSON file stored at `spec/<name>/.demo/walkthrough.json`:
  ```json
  {
    "spec_name": "notification-preferences",
    "steps": [
      {
        "id": "FR-1",
        "title": "Dashboard Overview",
        "url": "/dashboard",
        "actions": [
          { "type": "navigate", "target": "/dashboard" },
          { "type": "wait", "selector": ".dashboard-container" }
        ],
        "narration": "This is the main dashboard. You can see the notification preferences panel on the right side.",
        "expected_state": "Dashboard page loaded with notification panel visible"
      }
    ],
    "generated_at": "ISO8601"
  }
  ```
- **FR-6.3:** The walkthrough plan is generated by the Claude Code agent reading the implementation spec and producing a structured navigation sequence. This happens once during `demo_setup`, not during the live demo.

### FR-7: Feedback Capture

- **FR-7.1:** During the demo, the voice agent continuously classifies the user's utterances:
  - **Navigation commands:** "go back", "click that", "show me X" → drive browser
  - **Questions:** "what does this do?", "why is it like that?" → answer from spec context
  - **Feedback:** "this looks wrong", "I expected Y", "this is perfect" → accumulate in feedback buffer
  - **Control:** "skip this", "next", "end demo" → advance/end walkthrough
- **FR-7.2:** At the end of the walkthrough (or when the user says "end demo"), the voice agent summarizes accumulated feedback and asks for a final verdict: "Based on what you've seen, are you satisfied with the implementation, or do you want changes?"
- **FR-7.3:** The feedback is written to a trigger file in the same format as call completion triggers (`pending/<timestamp>-demo-<spec>.json`), with an additional `demo_feedback` field:
  ```json
  {
    "call_id": "demo-session-<timestamp>",
    "caller_name": "Pranav Dhoolia",
    "source": "meet-demo",
    "spec": {
      "decision": "approved | rejected",
      "pain_points": ["FR-3 toggle doesn't animate", "..."],
      "navigation_requests": ["user asked to see error state for FR-5"],
      "positive_feedback": ["liked the dashboard layout"],
      "raw_transcript": "full demo transcript"
    }
  }
  ```
- **FR-7.4:** If rejected, the pain points are formatted as a revision file (`spec/<name>/revisions/<NNN>-demo-feedback.md`) and the pipeline transitions back to `dev`.

### FR-8: Outbound Call to Join Meet

- **FR-8.1:** After the Meet is created and the bot is ready, the agent calls the user via the existing Retell outbound call path with a new `call_mode: "demo_invite"`.
- **FR-8.2:** The voice agent says: "Hey, the [feature] has been built and verified. I've set up a live demo for you. Join this Google Meet and I'll walk you through it: [reads Meet code or says 'I've sent you a calendar invite']. Are you ready?"
- **FR-8.3:** If the user says "yes", the agent waits for them to appear in the Meet (detected via Meet participant list or webhook). If the user says "skip the demo" or "just tell me", the pipeline fires `DEMO_SKIPPED` and falls back to voice-only confirmation.
- **FR-8.4:** New dynamic variable for this call mode:
  | Variable | Value | Source |
  |----------|-------|--------|
  | `call_mode` | `"demo_invite"` | Hardcoded |
  | `meet_url` | `"https://meet.google.com/abc-defg-hij"` | From Meet creation |
  | `meet_code` | `"abc-defg-hij"` | Extracted from URL |
  | `spec_name` | `"notification-preferences"` | Active spec |
  | `feature_summary` | `"We built..."` | Generated summary |

### FR-9: Module Structure

- **FR-9.1:** New modules:
  ```
  src/
    demo/
      meet.ts          — Google Meet API client (create space, get URL)
      bot.ts           — Meet bot lifecycle (join, share, leave)
      audio.ts         — Audio routing (TTS→mic, speaker→STT)
      walkthrough.ts   — Walkthrough plan generation + execution
      voice-agent.ts   — Real-time voice AI pipeline for the demo
  ```
- **FR-9.2:** The demo modules are independent of the channel abstraction (`channels/`). They are orchestrated by the Claude Code plugin hooks via FSM side effects, same as everything else.
- **FR-9.3:** The demo voice agent is a *separate* voice pipeline from the Retell phone agent. The Retell agent handles phone calls (PSTN). The demo voice agent handles in-Meet conversation (WebRTC audio). They share no code except the structured output schemas.

---

## 4. Non-Functional Constraints

- **NFC-1: Voice latency.** User utterance → agent response < 2 seconds (excluding network). This requires streaming STT + streaming LLM + streaming TTS, not batch processing.
- **NFC-2: Screen share quality.** The shared product browser must be visible and legible to the user in the Meet. Minimum resolution: 1280x720. No compression artifacts that obscure text.
- **NFC-3: Single machine.** The Meet bot, product browser, voice AI pipeline, and dev server all run on the same machine as the Claude Code session. No cloud-hosted bot infrastructure for v1 (unless a managed service like Recall.ai is used, in which case the orchestration still runs locally).
- **NFC-4: Graceful degradation.** If Meet creation fails, audio routing fails, or the bot can't join, the pipeline falls back to the existing voice-only confirmation flow (`DEMO_SKIPPED`). The demo phase must never block the pipeline.
- **NFC-5: Demo duration.** A typical demo should take 5-15 minutes (depending on FR count). The voice agent should pace itself — not rush through, but not dawdle.
- **NFC-6: Resource usage.** Running a headed Chromium for the Meet bot + another for the product browser + a voice AI pipeline is resource-intensive. The system should work on a MacBook Pro (M-series, 16GB+ RAM). If resources are insufficient, fall back to voice-only.
- **NFC-7: No persistent Google auth state.** Bot auth tokens/cookies for Google must be refreshable. If a session expires mid-demo, the bot should attempt re-auth or gracefully exit.
- **NFC-8: FSM purity.** The `demo` phase follows the same architectural pattern as all other phases: the FSM in `state-machine.ts` emits side effects, the Claude Code plugin hooks execute them. No LLM-controlled transitions.

---

## 5. Known Boundaries and Limitations

- **B-1: Google account required for bot.** The Meet bot needs a Google account to join the Meet. This can be the same account that creates the Meet, or a dedicated bot account. The account must be in the same Google Workspace org if the Meet requires it, or the Meet must allow external participants.
- **B-2: Screen share requires display.** Chromium cannot share a screen/tab in true headless mode. On Linux, Xvfb (virtual framebuffer) is required. On macOS, this may work with a native display but needs accessibility permissions.
- **B-3: Audio routing is platform-dependent.** Virtual audio devices (PulseAudio on Linux, BlackHole on macOS) are OS-specific. A managed service (Recall.ai) abstracts this but adds cost and a vendor dependency.
- **B-4: Google Meet anti-bot measures.** Google may block or CAPTCHA automated joins. The bot account needs to be "trusted" (not flagged). Meet links should be configured with no waiting room and the bot account should be the meeting creator.
- **B-5: No recording.** This spec does not include recording the Meet for later replay. The transcript is captured, but video recording is out of scope.
- **B-6: Single user demo.** The demo is for one user at a time. Multi-participant demos (e.g., demo for a team) are out of scope for v1 — though the architecture doesn't preclude it.
- **B-7: Voice agent is not the Retell agent.** The in-Meet voice agent is a separate pipeline (STT → LLM → TTS). It does not use Retell's PSTN infrastructure. The Retell agent is only used for the initial "join the Meet" phone call.
- **B-8: Browser navigation latency.** Playwright MCP tool calls have latency (100-500ms per action). Complex navigation sequences may feel sluggish during the live demo. The voice agent should narrate during waits ("Loading the settings page...").

---

## 6. Open Questions

- **OQ-1:** Which Google API for Meet creation? Meet REST API v2 (standalone space, no calendar event) vs Calendar API (calendar event + invite email). Calendar API is more user-friendly (user gets an invite) but heavier.
- **OQ-2:** Audio routing approach: virtual audio devices (PulseAudio/BlackHole) vs managed service (Recall.ai/MeetStream) vs WebRTC injection via CDP? This is the hardest technical decision and the biggest risk.
- **OQ-3:** Meet bot + product browser: same Playwright instance (two tabs) or separate instances? Same instance means simpler screen sharing (share "this tab") but risks the Meet tab interfering with the product tab.
- **OQ-4:** Voice AI stack: OpenAI Realtime API (speech-to-speech, lowest latency) vs Deepgram STT + Claude + ElevenLabs TTS (more control, higher latency) vs LiveKit Agents (open-source framework with built-in VAD/STT/LLM/TTS pipeline)?
- **OQ-5:** How does the bot detect that the user has joined the Meet? Poll the Meet participant list via API? Watch the Meet UI in the browser for a participant count change? WebSocket event from a managed service?
- **OQ-6:** Should the walkthrough plan be editable by the user before the demo starts? ("I only care about FR-3 and FR-7, skip the rest")
- **OQ-7:** What happens if the user's internet connection drops during the demo? Timeout → fall back to phone call for confirmation?

---

## 7. Existing Assets

| Asset | Location | Status |
|-------|----------|--------|
| State machine | `src/state-machine.ts` | Built — demo states (`demo_setup`, `demo_calling`, `demo_active`, `demo_feedback`) and events (`DEMO_READY`, `USER_JOINED_MEET`, `WALKTHROUGH_COMPLETE`, `DEMO_APPROVED`, `DEMO_REJECTED`, `DEMO_SKIPPED`, `DEMO_FAILED`) already implemented. FSM routes `AUDIT_PASSED` → `demo_setup`. |
| Plugin hooks | `hooks/hooks.json` + `scripts/` | Built — needs demo side effect handlers in hook scripts |
| Plugin manifest | `.claude-plugin/plugin.json` | Configured — defines commands, agents, hooks for Claude Code |
| Retell client | `src/retell.ts` | Built — needs `demo_invite` call mode |
| Voice agent prompt | `prompts/voice-agent.md` | Built — needs `demo_invite` section |
| Auditor browser MCP | project `.mcp.json` | Configured — `auditor-browser` pattern reusable for demo |
| My-browser MCP | project `.mcp.json` | Configured — `my-browser` for CDP-connected Chrome |
| Tunnel manager | `scripts/tunnel.sh` | Built — reusable for optional product tunnel |
| Playwright MCP | `@playwright/mcp` | Available — browser automation for product navigation |
| Google Calendar MCP | Claude.ai integration | Available — can create calendar events with Meet links |
