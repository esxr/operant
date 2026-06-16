<!-- #core -->
<!-- #google_meet_screen_share -->
# Architecture Decisions: Google Meet Live Demo Channel

**Last Updated:** 2026-06-06

---

## ADR-001: Playwright Bot Over Managed Service (Recall.ai / MeetStream)

**Status:** Proposed

**Context:**  
The Meet bot needs to join a Google Meet, share a screen tab, and have bidirectional audio. Two paths exist: (A) build it ourselves with a Playwright-controlled Chromium, or (B) use a managed bot-as-a-service like Recall.ai or MeetStream.ai that handles Meet joining, screen sharing, and audio routing via their APIs.

**Decision:**  
Use a self-managed Playwright bot. The bot is a local headed Chromium instance that joins Meet, shares a tab, and routes audio through OS-level virtual audio devices.

**Alternatives Considered:**

| Option | Pros | Cons |
|--------|------|------|
| **Playwright bot (chosen)** | Full control over screen content and timing. No vendor dependency. Consistent with existing `auditor-browser` pattern. No per-minute cost. Runs on same machine — no network latency to a third-party. | Audio routing is DIY (PulseAudio/BlackHole). Meet UI automation is brittle. Screen sharing in headless mode requires Xvfb. |
| **Recall.ai Output Media API** | Handles Meet joining, audio I/O, and screen sharing. WebSocket API for sending/receiving audio. SOC 2 compliant. | Per-minute pricing (~$0.02-0.04/min). Vendor lock-in. Bot infrastructure runs remotely — latency for screen content. Less control over what's shown. Cannot share a *specific* localhost tab — would need to stream video. |
| **MeetStream.ai** | WebSocket audio injection (`sendaudio` with base64 PCM). SDKs in JS/Python. | Less mature than Recall.ai. Screen sharing support unclear. Another vendor dependency. |

**Rationale:**  
The demo's core value is showing *exactly* what the product looks like running locally. A managed service would require streaming the product's video to a remote bot, adding latency and complexity. The Playwright approach keeps everything local — the bot browses localhost directly, shares the tab it's viewing, and routes audio through the OS. This is the same architectural pattern as `auditor-browser` (which already uses Playwright to visually verify the product), extended with Meet joining and audio.

The managed service trade-off (easier audio, harder screen content) is the wrong trade-off for this use case. Audio routing has well-established solutions (PulseAudio sinks). Screen content fidelity is non-negotiable.

**Consequences:**
- We own the audio routing complexity (ADR-003)
- We must handle Meet UI automation brittleness (pin Chrome version, use stable selectors)
- No per-minute cost — demo duration is limited only by user patience
- If Playwright/Meet automation breaks in a future Chrome version, we fix it ourselves

**Resolves:** HLD Open Question D-1

---

## ADR-002: Two-Tab Single Chromium Over Separate Browser Instances

**Status:** Proposed

**Context:**  
The bot needs to simultaneously be in Google Meet (Tab 1) and navigate the product (Tab 2), while sharing the product tab's content in the Meet. Two approaches: (A) one Chromium instance with two tabs — the bot shares "this tab" (Tab 2) in the Meet, or (B) two separate Chromium instances — one for Meet, one for the product — where the Meet browser shares a window from the product browser.

**Decision:**  
Single Chromium instance with two tabs. Tab 1 is the Meet session. Tab 2 is the product at localhost. The bot presents Tab 2 in the Meet via Chrome's tab-sharing feature.

**Alternatives Considered:**

| Option | Pros | Cons |
|--------|------|------|
| **Two-tab single Chromium (chosen)** | Tab sharing is a native Chrome feature. Both tabs share the same audio device context. Simpler process management. Playwright can target specific pages by handle. | Must carefully manage tab focus — Meet may pause shared tab if it's not "active." Risk of tab interference. |
| **Two separate Chromium instances** | Complete isolation. No tab interference. | Window-level screen sharing is harder to automate (OS-level window picker). Audio routing is per-process, need two virtual device routes. Twice the memory. |

**Rationale:**  
Chrome's "share a tab" feature (as opposed to "share entire screen" or "share a window") is the cleanest path. It captures the tab's rendered content regardless of focus state, which means Tab 1 (Meet) can be "active" while Tab 2 (product) is being shared. Playwright's `browser.pages()` returns handles to both tabs, so we can drive Tab 2 without switching focus away from Tab 1.

The single-instance approach also means both tabs share the same audio device assignments — the virtual mic/speaker configured via Chrome launch flags apply to the whole browser, which is what we want (the Meet tab reads the virtual mic, not the product tab).

**Consequences:**
- Must verify that Chrome tab sharing continues rendering when the shared tab is backgrounded
- Playwright page handles must be carefully managed (don't close the wrong tab)
- If tab-sharing proves unreliable, fallback is to share the entire virtual display (Xvfb screen)

**Resolves:** HLD Open Question OQ-3

---

## ADR-003: OS-Level Virtual Audio Routing Over CDP/WebRTC Injection

**Status:** Proposed

**Context:**  
The bot needs to: (A) pipe TTS-generated audio into its microphone so Meet participants hear the agent speaking, and (B) capture audio from Meet participants so the STT engine hears the user. Three approaches: OS-level virtual audio devices, Chrome DevTools Protocol audio injection, or a managed service.

**Decision:**  
Use OS-level virtual audio devices. On Linux: PulseAudio virtual sinks/sources. On macOS: BlackHole (virtual audio driver).

**Alternatives Considered:**

| Option | Pros | Cons |
|--------|------|------|
| **Virtual audio devices (chosen)** | Well-established technology. PulseAudio is standard on Linux. Works with any browser, any application. No browser-version dependency. | Platform-specific setup (PulseAudio on Linux, BlackHole on macOS). Requires installing a kernel extension on macOS. Global system state — can interfere with other audio apps. |
| **CDP WebAudio interception** | No OS-level dependencies. Pure browser-level. | Experimental Chrome feature. `Runtime.evaluate` to intercept WebAudio nodes is fragile. No stable API for injecting audio *into* a MediaStream used by WebRTC. Chrome versions break this. |
| **`--use-fake-device-for-media-stream` with audio file** | Simple Chrome flag. No OS setup. | Only supports a static audio file, not a real-time TTS stream. Cannot dynamically change the audio being sent. |
| **Managed service (Recall.ai)** | Audio routing is their problem. WebSocket API. | Already rejected in ADR-001 for screen sharing reasons. |

**Rationale:**  
The voice pipeline produces audio in real-time (streaming TTS). We need a real-time audio channel from our TTS process to Chrome's microphone input, and from Chrome's speaker output to our STT process. Virtual audio devices are the standard solution for this:

**Linux (PulseAudio):**
```
TTS process → writes PCM to → PulseAudio virtual sink "tts_output"
Chrome launched with: PULSE_SINK=tts_output (mic reads from this sink)

Chrome speaker → PulseAudio virtual source "meet_capture"
STT process → reads PCM from → "meet_capture"
```

**macOS (BlackHole):**
```
TTS process → writes audio to → BlackHole 2ch (virtual device)
Chrome launched with: --audio-output-device-id=BlackHole (mic reads from BlackHole)

Chrome speaker → BlackHole 2ch (routed via Multi-Output Device)
STT process → reads audio from → BlackHole 2ch
```

Both approaches are well-documented and battle-tested in streaming/podcasting tooling.

**Consequences:**
- Linux: PulseAudio must be available (standard on desktop Linux, needs setup on headless servers)
- macOS: BlackHole must be installed (`brew install blackhole-2ch`). Requires user to grant audio permissions.
- Audio routing is platform-specific — `audio.ts` must detect OS and configure accordingly
- Need a way to write PCM audio from Node.js to the virtual device (e.g., `sox`, `ffmpeg`, or direct ALSA/CoreAudio bindings)

**Resolves:** HLD Open Question OQ-3

---

## ADR-004: Modular Voice Stack (Deepgram + Claude + ElevenLabs) Over Speech-to-Speech

**Status:** Proposed

**Context:**  
The in-Meet voice agent needs real-time bidirectional conversation. Two approaches: (A) a modular pipeline of STT → LLM → TTS with best-of-breed components, or (B) a speech-to-speech model like OpenAI Realtime API that handles audio-in, audio-out natively.

**Decision:**  
Use a modular stack: Deepgram Nova-3 for streaming STT, Claude (Anthropic API, streaming) for the LLM, ElevenLabs for streaming TTS.

**Alternatives Considered:**

| Option | Pros | Cons |
|--------|------|------|
| **Deepgram + Claude + ElevenLabs (chosen)** | Full control over each component. Claude has the spec context and is already the pipeline's LLM. Can swap any component. Intermediate text is inspectable/loggable. Deepgram streaming is ~300ms latency. ElevenLabs streaming is ~200ms. | Total chain latency: ~1-2s (STT + LLM first token + TTS first byte). Three vendor dependencies. More moving parts. |
| **OpenAI Realtime API** | Speech-to-speech: ~500ms total latency. Single vendor. Simpler pipeline. | Cannot use Claude as the LLM (locked to GPT-4o). Less control over reasoning. Spec context must be crammed into a system prompt, not streamed as tool calls. Harder to inspect intermediate reasoning. More expensive per-minute. |
| **LiveKit Agents framework** | Open-source orchestration for voice AI. Built-in VAD, STT, LLM, TTS pipeline. Production-grade. | Another framework to learn. Heavier than we need — designed for multi-room, multi-participant scenarios. Would need to bridge LiveKit's audio transport to our Meet bot's virtual audio, adding complexity. |
| **Pipecat (by Daily.co)** | Open-source, frame-based streaming pipeline. Vendor-neutral. Python. | Python, not TypeScript (our stack is TS). Would need a subprocess or API bridge. |

**Rationale:**  
The demo voice agent needs deep context about the implementation spec, the walkthrough plan, the current browser state, and the user's accumulated feedback. Claude is already the LLM for the entire pipeline — it understands the spec artifacts natively. Using a different LLM for the demo voice agent would mean re-injecting all context into a foreign model.

The modular approach also lets us inspect the intermediate text (STT output, LLM response) for structured extraction — we need to classify utterances as navigation commands vs questions vs feedback, and text-based classification is more reliable than trying to extract structure from audio.

The ~1-2s total latency is acceptable for a demo walkthrough. The agent narrates proactively (not just reactively), so the user is rarely waiting in silence.

**Consequences:**
- Three API keys to manage (Deepgram, Anthropic, ElevenLabs)
- ~1-2s response latency (acceptable for walkthrough, might feel slow for rapid Q&A)
- Full transcript available for feedback capture (intermediate text is logged)
- Can swap components independently (e.g., switch to Google STT, switch to OpenAI TTS)

**Resolves:** HLD Open Question OQ-4

---

## ADR-005: Google Meet REST API v2 Over Calendar API for Meeting Creation

**Status:** Proposed

**Context:**  
Need to create a Google Meet programmatically. Two APIs available: Meet REST API v2 (`POST /v2/spaces`, released 2024, GA) and Calendar API (create event with `conferenceData`).

**Decision:**  
Use Google Meet REST API v2 to create standalone meeting spaces.

**Alternatives Considered:**

| Option | Pros | Cons |
|--------|------|------|
| **Meet REST API v2 (chosen)** | Lightweight — just creates a meeting space, no calendar event. Fast (single API call). Returns `meetingUri` directly. No need for Calendar API scopes. | No calendar invite sent to user. User must be told the code verbally (via Retell call). Requires Meet API OAuth scope (`meetings.space.created`). |
| **Calendar API with conferenceData** | Sends a calendar invite to the user's email (they can click to join). Calendar event provides structure (time, title). | Heavier — creates a calendar event + conference. Conference creation is async (must poll for `status: "success"`). Requires Calendar API scopes + conferenceData version. Over-engineered for a 10-minute demo. |

**Rationale:**  
The demo is an ad-hoc, immediate interaction — not a scheduled meeting. The user is already on the phone with the Retell agent when the demo is proposed. The voice agent reads the Meet code to the user, who joins immediately. A calendar invite adds latency (user has to check email) and complexity (async conference creation). The Meet REST API is a single synchronous call that returns the join URL.

If we later want calendar invites (e.g., for scheduled demos with stakeholders), we can add Calendar API support without changing the core flow.

**Consequences:**
- User must join via the Meet code read to them on the phone — no email link
- Need OAuth2 setup for Google Meet API (scope: `meetings.space.created`)
- Simple, fast, one API call

**Resolves:** HLD Open Question OQ-1

---

## ADR-006: Retell Call Completion as User-Join Signal Over Meet API Polling

**Status:** Proposed

**Context:**  
After the bot is in the Meet and the user has been called, we need to detect when the user has actually joined the Meet so the walkthrough can begin. Three detection methods: (A) poll Google Meet API for participant list, (B) poll the Meet UI DOM for participant count, (C) use the Retell demo_invite call completion as a proxy signal.

**Decision:**  
Use Retell call completion as the primary signal. When the demo_invite call ends (the user says "I'm joining" or hangs up), wait a configurable grace period (default 15 seconds), then start the walkthrough. Optionally verify via Meet UI DOM that participant count > 1.

**Alternatives Considered:**

| Option | Pros | Cons |
|--------|------|------|
| **Retell call completion + grace period (chosen)** | Simple. Uses existing infrastructure. No additional API calls. The user naturally hangs up the phone to switch to their laptop/tablet. | Not a definitive signal — user might not join immediately. Grace period is a guess. |
| **Google Meet REST API participant polling** | Authoritative — API knows who's in the Meet. | Meet REST API `conferenceRecords` only shows participants *after* the meeting ends, not during. Live participant data is not available in the current v2 API. |
| **Meet UI DOM polling** | Real-time — Playwright can check the participant list in the Meet tab. | Brittle — depends on Meet UI structure. Participant list DOM changes with Meet updates. |

**Rationale:**  
The Google Meet REST API does not expose a real-time participant list for active meetings — `conferenceRecords` and `participants` are only available after the meeting ends. DOM polling is possible but fragile. The simplest reliable approach is: the Retell call ends (user says they're joining), we wait 15 seconds (enough time to open a browser and click the Meet link), and then start. If we need verification, a quick Playwright check of the Meet UI's participant count (looking for a badge showing "2") is a lightweight supplement.

**Consequences:**
- 15-second grace period adds slight delay before demo starts
- If user is slow to join, the walkthrough starts to an empty room (voice agent can detect silence and wait)
- DOM verification is a nice-to-have supplement, not a hard requirement

**Resolves:** HLD Open Question OQ-5

---

## ADR-007: Demo Phase as Default Post-Audit Path With Skip Option

**Status:** Proposed

**Context:**  
The demo phase is new infrastructure with significant complexity (Meet, browser, audio, voice AI). Should it be opt-in (user requests a demo) or opt-out (demo is the default, user can skip)?

**Decision:**  
Demo is the default path after `AUDIT_PASSED`. The Retell `demo_invite` call gives the user the option to skip ("I don't need a demo, just confirm"). If they skip, the pipeline fires `DEMO_SKIPPED` and falls through to the existing voice-only confirmation flow.

**Alternatives Considered:**

| Option | Pros | Cons |
|--------|------|------|
| **Default with skip (chosen)** | Users see the product by default — highest value path. Low friction to skip. | Adds setup time (~30s) even if user will skip. Demo infrastructure must be robust. |
| **Opt-in on request** | No demo overhead for simple features. User explicitly chooses. | Users may never discover the feature. Requires the phone agent to *offer* the demo, adding conversation complexity. |

**Rationale:**  
The demo is the primary reason this feature exists — to let the user *see* the product before confirming. Making it opt-in defeats the purpose. The skip path exists for when the user trusts the audit results or is in a hurry.

The `demo_setup` side effects (create Meet, launch browser, generate walkthrough) run in parallel with the Retell call, so if the user skips, minimal time is wasted.

**Consequences:**
- Demo infrastructure is always initialized after AUDIT_PASSED (then torn down if skipped)
- The Retell `demo_invite` voice prompt must clearly offer the skip option
- Pipeline is slightly slower overall (demo setup takes ~30s) even for skip cases

**Resolves:** HLD D-4, Intent G-6
