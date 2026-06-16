<!-- #core -->
<!-- #google_meet_screen_share -->
# High-Level Design: Google Meet Live Demo Channel

**Version:** 1.0  
**Date:** 2026-06-06  
**Status:** Draft

## 1. Overview

The Meet Demo system inserts a live interactive demo phase between audit-pass and user confirmation in the operant pipeline. A Playwright-controlled Chromium bot creates a Google Meet, joins it, shares a browser tab showing the running product, and narrates a structured walkthrough via a real-time voice AI pipeline — all while listening for the user's spoken commands and driving the browser accordingly. The user sees the product, talks to the agent, and gives structured feedback — all inside a single Google Meet session.

**FSM integration:** The demo states and transitions are already implemented in `src/state-machine.ts`. The FSM routes `AUDIT_PASSED` → `demo_setup` (not directly to `confirmation`). All demo events (`DEMO_READY`, `USER_JOINED_MEET`, `WALKTHROUGH_COMPLETE`, `DEMO_APPROVED`, `DEMO_REJECTED`, `DEMO_SKIPPED`, `DEMO_FAILED`) and side effects (`CREATE_DEMO`, `TRIGGER_DEMO_INVITE_CALL`, `START_WALKTHROUGH`, `CAPTURE_FEEDBACK`, `WRITE_DEMO_REVISION`, `TEARDOWN_DEMO`) are defined in the state machine types.

## 2. Goals and Non-Goals

### Goals

- Autonomous end-to-end Meet lifecycle (create → call user → join → share → narrate → capture feedback → leave → clean up)
- Unified bot participant: one "Operant Demo" in the Meet that shares screen AND speaks/listens
- Bidirectional voice: agent narrates walkthrough, user interrupts with navigation commands and questions
- Structured feedback capture that feeds back into the existing FSM (approval → confirmation, rejection → revision → dev loop)
- Graceful fallback to voice-only confirmation if any part of the demo infrastructure fails

### Non-Goals

- Meet recording or replay
- Multi-participant demos (team presentations)
- Custom Meet UI (add-ons, embedded apps)
- Replacing the Retell phone channel for non-demo interactions
- Cloud-hosted bot infrastructure (everything runs locally for v1)
- Video (webcam) for the bot — screen share only, no bot face

## 3. System Architecture

### Component Diagram

```
                        ┌─────────────────────────────┐
                        │    User's Device             │
                        │  (phone + laptop/tablet)     │
                        │                              │
                        │  Phone: receives Retell call │
                        │  Browser: joins Google Meet  │
                        └──────────┬──────────────────┘
                                   │
                    ┌──────────────┼──────────────────────┐
                    │ Google Meet  │  (cloud)              │
                    │              │                       │
                    │   User ◄────┼────► Bot participant   │
                    │  (browser)  │   (Chromium via PW)    │
                    │              │                       │
                    │   audio ←→ audio                     │
                    │   sees ←── screen share              │
                    └──────────────┬──────────────────────┘
                                   │ Bot's Chromium instance
┌──────────────────────────────────┼────────────────────────────────────┐
│                        Operant (local machine)                        │
│                                  │                                    │
│  ┌───────────────────┐    ┌──────▼──────────┐    ┌────────────────┐  │
│  │ Plugin Hooks      │    │ Meet Bot        │    │ Product        │  │
│  │ (hooks.json +     │───▶│ (bot.ts)        │    │ Browser Tab    │  │
│  │  scripts/)        │    │                 │    │ (localhost:3000)│  │
│  │ demo side effects │    │ Chromium #1:    │    │                │  │
│  │ → create meet     │    │  Tab 1: Meet    │    │ Controlled by  │  │
│  │ → call user       │    │  Tab 2: Product │◄──▶│ Playwright MCP │  │
│  │ → start walkthru  │    │  (shared tab)   │    │                │  │
│  └────────┬──────────┘    └──────┬──────────┘    └────────────────┘  │
│           │                      │                                    │
│  ┌────────▼──────────┐    ┌──────▼──────────┐                        │
│  │ Retell Client     │    │ Voice Pipeline  │                        │
│  │ (retell.ts)       │    │ (voice-agent.ts)│                        │
│  │                   │    │                 │                        │
│  │ demo_invite call  │    │ ┌─────────────┐ │                        │
│  │ to user's phone   │    │ │ Audio Router │ │                        │
│  └───────────────────┘    │ │ (audio.ts)  │ │                        │
│                           │ └──────┬──────┘ │                        │
│  ┌───────────────────┐    │        │        │                        │
│  │ Meet API Client   │    │ ┌──────▼──────┐ │                        │
│  │ (meet.ts)         │    │ │  STT Engine │ │                        │
│  │                   │    │ │  (inbound)  │ │                        │
│  │ Create space      │    │ └──────┬──────┘ │                        │
│  │ Get join URL      │    │        │        │                        │
│  └───────────────────┘    │ ┌──────▼──────┐ │    ┌────────────────┐  │
│                           │ │  LLM        │ │    │ Walkthrough    │  │
│                           │ │ (streaming) │◄├────│ Engine         │  │
│                           │ └──────┬──────┘ │    │ (walkthrough.ts│  │
│                           │        │        │    │                │  │
│                           │ ┌──────▼──────┐ │    │ Plan from EIS  │  │
│                           │ │  TTS Engine │ │    │ Browser control│  │
│                           │ │  (outbound) │ │    │ State tracking │  │
│                           │ └─────────────┘ │    └────────────────┘  │
│                           └─────────────────┘                        │
│                                                                      │
│  ┌───────────────────┐                                               │
│  │ Dev Server        │                                               │
│  │ (localhost:3000)  │ ← Product being demoed                        │
│  └───────────────────┘                                               │
└──────────────────────────────────────────────────────────────────────┘
```

### Component Descriptions

| Component | Responsibility | Key Interfaces |
|-----------|----------------|----------------|
| Meet API Client (`meet.ts`) | Create Google Meet spaces, retrieve join URLs, manage auth tokens | Google Meet REST API v2 / Calendar API, OAuth2 |
| Meet Bot (`bot.ts`) | Launch Chromium, join Meet, share product tab, manage bot lifecycle | Playwright, Chrome launch flags, Meet UI automation |
| Audio Router (`audio.ts`) | Route TTS output → bot microphone, bot speaker → STT input | Virtual audio devices (PulseAudio/BlackHole) OR CDP WebAudio interception |
| Voice Pipeline (`voice-agent.ts`) | Real-time STT→LLM→TTS loop, utterance classification, context injection | STT API (Deepgram/Whisper), LLM (Claude streaming), TTS API (ElevenLabs/OpenAI) |
| Walkthrough Engine (`walkthrough.ts`) | Generate walkthrough plan from EIS, execute steps via browser, track position | Playwright MCP, implementation spec parser |
| Plugin hooks (`hooks/hooks.json` + `scripts/`) | FSM side effect execution for demo states, lifecycle orchestration | State machine, Retell client, all demo modules |
| Retell Client (`retell.ts`) | Outbound `demo_invite` phone call to tell user to join Meet | Retell REST API (existing) |

### Module Dependency Graph

```
hooks/hooks.json + scripts/ (Claude Code plugin hooks — orchestrate everything)
  ├── src/state-machine.ts (FSM — demo states already implemented)
  ├── src/retell.ts (demo_invite call mode)
  ├── src/demo/
  │   ├── meet.ts (Google API — no internal deps)
  │   ├── bot.ts (Playwright — depends on meet.ts for URL)
  │   ├── audio.ts (platform audio — depends on bot.ts for browser context)
  │   ├── voice-agent.ts (AI pipeline — depends on audio.ts for streams)
  │   └── walkthrough.ts (plan + execution — depends on voice-agent.ts for narration,
  │                        Playwright MCP for browser control)
  └── scripts/tunnel.sh (optional product tunnel — existing)
```

## 4. Data Flow

### Flow A: Demo Setup (AUDIT_PASSED → DEMO_READY)

```
1. Audit agent completes with PASS
2. FSM transitions: audit → demo_setup
3. Side effect: CREATE_DEMO
4. Plugin hook script executes:
   a. meet.ts: POST /v2/spaces → meetUri, meetCode
   b. walkthrough.ts: read implementation-spec.md → generate walkthrough.json
   c. bot.ts: launch Chromium with audio flags
   d. bot.ts: navigate to meetUri, join Meet as "Operant Demo"
   e. bot.ts: open product tab (localhost:3000), share tab in Meet
   f. audio.ts: initialize virtual audio routing
   g. voice-agent.ts: initialize STT + LLM + TTS pipeline
5. All ready → FSM event: DEMO_READY
6. Write meet metadata to spec/<name>/.demo/meet.json
```

### Flow B: Call User to Join (DEMO_READY → USER_JOINED_MEET)

```
1. FSM transitions: demo_setup → demo_calling
2. Side effect: TRIGGER_DEMO_INVITE_CALL
3. Plugin hook script executes:
   a. retell.ts: makeOutboundCall(call_mode="demo_invite",
        meet_url=meetUri, meet_code=meetCode, spec_name=...)
   b. Voice agent on phone: "I've set up a live demo. Join meet.google.com/abc-defg-hij"
4. User joins Meet in their browser
5. bot.ts detects new participant in Meet (polls Meet UI or API)
6. FSM event: USER_JOINED_MEET
```

### Flow C: Live Demo (DEMO_ACTIVE)

```
1. FSM transitions: demo_calling → demo_active
2. Side effect: START_WALKTHROUGH
3. Plugin hook script executes:
   a. voice-agent.ts: "Welcome! I'll walk you through the [feature]. Let's start."
   b. walkthrough.ts: execute step 1 — navigate product browser, narrate
   c. Loop:
      i.  User speaks → audio.ts captures → STT → text
      ii. voice-agent.ts classifies utterance:
          - Navigation: "click settings" → walkthrough.ts drives browser
          - Question: "what does this do?" → LLM answers from spec context
          - Feedback: "this looks wrong" → accumulate in feedback buffer
          - Control: "next" / "end demo" → advance/end walkthrough
      iii. Agent responds via TTS → audio.ts → bot mic → Meet
      iv. Next walkthrough step (if no interruption)
4. Walkthrough completes OR user says "end demo"
5. FSM event: WALKTHROUGH_COMPLETE
```

### Flow D: Feedback Capture (DEMO_FEEDBACK → confirmation/dev)

```
1. FSM transitions: demo_active → demo_feedback
2. voice-agent.ts: "That's the walkthrough. Based on what you've seen,
   are you satisfied, or would you like changes?"
3. User gives verdict + any final notes
4. voice-agent.ts structures feedback into trigger file format
5. Writes to spec/.operant/pending/<ts>-demo-<spec>.json
6. If approved → FSM event: DEMO_APPROVED → confirmation state
7. If rejected → FSM event: DEMO_REJECTED →
   writes revision to spec/<name>/revisions/<NNN>-demo-feedback.md
   → dev state (restart dev loop)
8. bot.ts: leave Meet, close Chromium
9. audio.ts: tear down virtual audio
10. meet.ts: (Meet expires naturally, no cleanup needed)
```

## 5. Technology Choices

| Layer | Choice | Rationale | Alternatives Considered |
|-------|--------|-----------|------------------------|
| Meet creation | Google Meet REST API v2 | Standalone space, no calendar dependency, fast | Calendar API (heavier but sends invite email) |
| Meet bot | Playwright + Chromium (headed, Xvfb) | Already in the stack (auditor-browser), full control | Recall.ai (managed, but vendor lock-in + cost) |
| Screen share | Tab sharing via Chrome flags | Direct, no middleware, bot controls exactly what's shown | CDP-injected video stream (complex, fragile) |
| Audio routing | PulseAudio virtual sinks (Linux) / BlackHole (macOS) | OS-level, works with any browser, no CDP hacks | CDP WebAudio interception (experimental), Recall.ai (managed) |
| STT | Deepgram Nova-3 (streaming WebSocket) | Low latency (~300ms), streaming, good accuracy | Whisper (batch, higher latency), Google STT |
| LLM | Claude (streaming, via Anthropic API) | Already the pipeline's LLM, spec context awareness | GPT-4o (viable alternative), OpenAI Realtime (speech-to-speech, lower latency but less control) |
| TTS | ElevenLabs (streaming WebSocket) | Low latency, natural voice, streaming output | OpenAI TTS (simpler but batch), Google TTS |
| Browser control | Playwright MCP (`my-browser`) | Already configured, CDP connection, full Playwright API | Direct CDP commands (lower level, more fragile) |
| Walkthrough plan | Claude-generated JSON from EIS | Existing LLM produces structured plans from specs | Manual plan authoring (doesn't scale) |

## 6. Key Design Decisions

- **D-1: Playwright bot over managed service.** The bot is a local Chromium instance controlled by Playwright, not a managed service like Recall.ai. Rationale: full control over screen content, no vendor dependency, consistent with auditor-browser pattern already in the codebase. Trade-off: audio routing is harder (we handle it ourselves).

- **D-2: Two-tab single browser, not two browsers.** The Meet bot runs one Chromium instance with two tabs: Tab 1 is the Google Meet, Tab 2 is the product at localhost. The bot shares Tab 2 in the Meet. Rationale: sharing "this tab" is simpler than sharing a window from a different process. The Meet tab and product tab don't interfere because Playwright can target specific pages.

- **D-3: Separate voice pipeline from Retell.** The in-Meet voice agent is NOT the Retell agent. Retell handles PSTN phone calls (outbound demo_invite call). The in-Meet voice is a custom STT→LLM→TTS pipeline running locally. Rationale: Retell has no WebRTC/Meet integration; the audio paths are fundamentally different (PSTN vs WebRTC).

- **D-4: Demo phase is opt-out, not opt-in.** The pipeline defaults to demo mode after AUDIT_PASSED. The user can skip ("just confirm on the phone"). Rationale: the demo is the highest-value interaction — the user sees the actual product. Skipping should be the exception.

- **D-5: Walkthrough plan is pre-generated, execution is adaptive.** The plan is generated during `demo_setup` (before the user joins). During the live demo, the agent follows the plan but deviates on user command. Rationale: pre-generation avoids LLM latency during the live demo; adaptiveness avoids rigidity.

- **D-6: OS-level audio routing over CDP hacks.** Audio is routed through virtual audio devices (PulseAudio/BlackHole), not through Chrome DevTools Protocol injection. Rationale: OS-level routing is well-understood and reliable. CDP audio injection is experimental and browser-version-dependent.

## 7. Open Questions

### Ambiguities in Requirements

- [ ] **OQ-1: Meet creation API** — Meet REST API v2 (standalone, no invite) vs Calendar API (sends email invite). **Default:** Meet REST API v2 — the phone call tells the user the Meet code; no email needed.
- [ ] **OQ-2: How does the user join?** The Retell voice agent reads the Meet code on the phone ("join meet.google.com/abc-defg-hij"). Should we also send a link via SMS or email? **Default:** Phone-only for v1. The user can ask the voice agent to repeat the code.

### Design Alternatives

- [ ] **OQ-3: Audio routing** — Virtual audio devices vs Recall.ai managed service vs CDP WebAudio. **Default:** Virtual audio devices (PulseAudio on Linux, BlackHole on macOS). Most control, no vendor dependency.
- [ ] **OQ-4: Voice AI stack** — Deepgram + Claude + ElevenLabs (modular, ~1-2s latency) vs OpenAI Realtime API (speech-to-speech, ~500ms latency, less control over LLM). **Default:** Modular stack (Deepgram + Claude + ElevenLabs) for spec context control.
- [ ] **OQ-5: Meet bot detection of user join** — Poll Meet UI DOM for participant count vs Google Meet REST API `GET /v2/conferenceRecords` (lists participants) vs Watch the Retell call completion (user says "I'm in"). **Default:** Retell call completion — when the demo_invite call ends, wait 15s then assume user is in.

### Clarifications Needed

- [ ] **OQ-6: macOS vs Linux for v1?** Audio routing differs significantly. PulseAudio is Linux-native. macOS needs BlackHole (third-party kernel extension). Which platform is the primary target?
- [ ] **OQ-7: Google Workspace vs personal Google account?** If the bot uses a Workspace account, it can create Meets without waiting rooms. Personal accounts may have restrictions.

## 8. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Google blocks automated Meet join | H | Use dedicated bot Google account, no waiting room, bot is meeting creator |
| Audio routing fails (virtual device not available) | H | Fallback to voice-only confirmation (`DEMO_SKIPPED`) |
| Meet UI changes break Playwright selectors | M | Use `data-` attributes and ARIA labels, not CSS classes. Pin Chrome version. |
| Voice latency > 3s kills interactivity | M | Pre-generate narration scripts in walkthrough plan; use streaming STT/TTS |
| Chromium + voice pipeline exhausts RAM | M | Monitor memory; kill demo and fallback if > 80% usage |
| User has poor internet, Meet lags | M | Voice agent detects silence > 10s, asks "Are you still there?" |
| STT misinterprets navigation command | L | Voice agent confirms before acting: "You want me to click Settings?" |
| Dev server not running when demo starts | L | Reuse audit phase's dev server startup logic (FR-4.4 from 00-init) |

## 9. Traceability

| Intent | HLD Section | Notes |
|--------|-------------|-------|
| G-1 (autonomous Meet lifecycle) | 4. Flows A-D | Full lifecycle covered across four flows |
| G-2 (bidirectional voice) | 3. Voice Pipeline, 4. Flow C | STT→LLM→TTS + utterance classification |
| G-3 (unified bot participant) | 3. Meet Bot, D-2 | Single Chromium, two tabs, one participant |
| G-4 (structured walkthrough) | 3. Walkthrough Engine, 4. Flow C | Pre-generated plan, adaptive execution |
| G-5 (structured feedback) | 4. Flow D, FR-7 | Trigger file format, revision writing |
| G-6 (full autonomous lifecycle) | 4. Flows A-D | Create → call → join → share → narrate → feedback → leave |
| FR-1 (new FSM states) | 4. All flows (FSM events) | demo_setup, demo_calling, demo_active, demo_feedback |
| FR-2 (Meet creation) | 3. Meet API Client, 4. Flow A | POST /v2/spaces |
| FR-3 (Meet bot) | 3. Meet Bot, D-1, D-2 | Playwright + Chromium + tab sharing |
| FR-4 (voice agent) | 3. Voice Pipeline, D-3 | Separate from Retell, custom STT→LLM→TTS |
| FR-5 (product browser) | 3. Product Browser Tab, D-2 | localhost, Playwright MCP control |
| FR-6 (walkthrough plan) | 3. Walkthrough Engine, D-5 | JSON plan from EIS, pre-generated |
| FR-7 (feedback capture) | 4. Flow D | Trigger file, revision writing |
| FR-8 (demo_invite call) | 4. Flow B | Retell outbound, new call_mode |
| FR-9 (module structure) | 3. Module Dependency Graph | demo/ directory, 5 modules |
| NFC-1 (voice latency < 2s) | 5. Tech Choices (streaming) | Streaming STT + streaming LLM + streaming TTS |
| NFC-4 (graceful fallback) | 8. Risks (all fallbacks) | DEMO_SKIPPED path for any failure |
| NFC-8 (FSM purity) | 4. All flows (FSM events) | Side effects returned, not executed by FSM |
