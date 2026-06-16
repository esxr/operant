# Intent & Constraints: Multi-Channel Architecture + G1 Smart Glasses Channel

**Version:** 2.0  
**Date:** 2026-06-06  
**Status:** Draft  
**Source:** Research + chat refinement with Pranav Dhoolia  
**Audience:** Implementation agents (Claude Code plugin)  
**Depends on:** `00-init` (base pipeline architecture)  
**Changes from v1.0:** Replaced MentraOS with direct BLE via Python `bleak` + `even_glasses` companion process. MentraOS was evaluated and rejected (flaky app, unreliable support).

---

## 1. Problem Statement

Operant currently has a single communication channel: phone calls via Retell.ai. Every human-in-the-loop touchpoint --- requirements intake, spec review gates, blocker resolution, completion confirmation --- goes through PSTN telephony. This works but has three problems:

1. **Latency per interaction.** Outbound calls take 5-15 seconds to connect. For rapid-fire review gates (4 per spec), this adds up. The user must answer the phone, wait for the voice agent to speak, respond verbally, and wait for the call to end before the pipeline can continue.

2. **Context-switching cost.** A phone call is interruptive. When the pipeline needs a quick "approve or revise?" decision, forcing a full phone call is heavy-handed. The user has to stop what they're doing, context-switch into a phone conversation, then switch back.

3. **No persistent visibility.** Between calls, the user has zero awareness of pipeline state. They don't know whether the dev agent is running, blocked, or waiting for audit. There is no ambient status display.

Even Realities G1 smart glasses solve all three. The user wears the glasses. When the pipeline needs input, a message appears on the heads-up display. The user reads it, presses the touchpad, dictates a response, and the pipeline continues --- no phone ringing, no voice agent preamble, sub-second latency. Between interactions, the glasses show a persistent status dashboard (phase, active spec, blocker count).

Adding this second channel requires refactoring the codebase: the current code has Retell.ai calls hardwired into the plugin hook logic. The pipeline's state machine must become **channel-agnostic**, and each communication channel (phone, glasses) must be a self-contained module with a shared interface.

**Why not MentraOS:** MentraOS was the initial approach (v1.0 of this spec). It was rejected after evaluation --- the companion app is flaky, support is unreliable, and adding a dependency on MentraOS Cloud for WebSocket relay and STT introduces a fragile external dependency. Instead, we connect to the G1 directly over BLE using a Python companion process built on `bleak` (proven BLE library for macOS) and `even_glasses` (existing G1 protocol library). This gives us full control over the connection, audio pipeline, and display --- no vendor dependency.

---

## 2. Goals

- **G-1:** The user can press the G1 touchpad, dictate requirements or decisions, and have them flow into the pipeline identically to a phone call --- same trigger files, same IPC, same state machine transitions.
- **G-2:** The pipeline's state machine and phase logic have zero knowledge of which channel delivered the input. Channel selection is handled at the plugin hook glue layer.
- **G-3:** Each communication channel (phone, glasses) is a self-contained module with a uniform interface. Adding a third channel (e.g., chat, web UI) requires only implementing the interface, not modifying core pipeline code.
- **G-4:** The G1 glasses display persistent pipeline status (phase, active spec, progress) as an ambient dashboard --- always visible, zero user effort.
- **G-5:** Both channels can coexist. The user can receive a blocker notification on the glasses and choose to resolve it via phone call, or vice versa. Channel preference is configurable with a default.
- **G-6:** No vendor dependency for the glasses channel. The BLE companion is our own code, built on open-source libraries (`bleak`, `even_glasses`). No cloud relay, no third-party companion app.

---

## 3. Functional Requirements

### FR-1: Channel Abstraction Layer

- **FR-1.1:** Define a `Channel` interface that all communication modules implement. The interface must cover: sending a message to the user (outbound), receiving a message from the user (inbound), and reporting channel availability.
- **FR-1.2:** The plugin must maintain a channel registry. Channels register themselves at startup and can be enabled/disabled at runtime.
- **FR-1.3:** When the state machine emits a side effect that requires user communication (e.g., `TRIGGER_REVIEW_CALL`, `TRIGGER_BLOCKER_CALL`, `TRIGGER_CONFIRMATION_CALL`), the plugin dispatches to the active channel via the `Channel` interface, not by calling Retell directly.
- **FR-1.4:** Channel selection logic: use the configured default channel. If the default channel is unavailable (e.g., glasses disconnected), fall back to the next available channel. The user can override per-interaction via the `/operant channel` command.
- **FR-1.5:** Inbound messages from any channel produce the same trigger file format (`pending/<timestamp>-<source>.json`). The `source` field identifies the channel (`phone`, `glasses`) but the trigger file schema is identical. The state machine does not inspect the source field.

### FR-2: Phone Channel Module (refactor of existing code)

- **FR-2.1:** Extract all Retell-specific logic from the plugin hooks into a `channels/phone.ts` module that implements the `Channel` interface.
- **FR-2.2:** The phone module encapsulates: `retell.ts` (API client), `scripts/tunnel.sh` (cloudflared lifecycle), the `call-retell` tool definition, voice agent prompt management, and webhook handling for call completion events.
- **FR-2.3:** The phone module's `sendMessage()` method maps to `retell.makeOutboundCall()` with the appropriate `call_mode` and `retell_llm_dynamic_variables`.
- **FR-2.4:** The phone module's inbound path: Retell webhook -> `scripts/server.ts` -> trigger file -> IPC -> `Channel.onMessage` callback -> state machine event. This is the existing flow, re-routed through the channel interface.
- **FR-2.5:** The `call-retell` tool remains registered but is scoped to the phone channel. It is only available when the phone channel is active.

### FR-3: G1 Smart Glasses Channel Module

- **FR-3.1:** Implement a `channels/glasses.ts` module that implements the `Channel` interface. This module manages a Python BLE companion subprocess.
- **FR-3.2:** The glasses module integrates a Python BLE bridge as a plugin-managed service component (or MCP server) that connects directly to the G1 via BLE using `bleak` and the `even_glasses` protocol library. Communication between the Claude Code plugin and the Python bridge uses MCP protocol or plugin-native IPC instead of stdin/stdout JSON-lines.
- **FR-3.3:** **Inbound (user dictates to pipeline):** On G1 touchpad long-press (`0xF5 0x17`), the Python companion activates the mic (`0x0E 0x01`), receives LC3 audio via `0xF1` packets, decodes to PCM, and streams to a STT service (Deepgram Nova-3 WebSocket). The transcript is forwarded to the TypeScript side as a JSON event, which writes a trigger file and sends IPC --- identical to the phone path.
- **FR-3.4:** **Outbound (pipeline pushes to user):** When the pipeline needs user input (review, blocker, confirmation), the glasses module sends a JSON command to the Python companion, which renders text on the G1 display via the `0x4E` protocol. Display is paginated (5 lines per screen, 488px width, font size 21). User swipes to navigate pages.
- **FR-3.5:** **Persistent dashboard:** When no interaction is in progress, the Python companion displays a status dashboard on the G1 HUD showing: current pipeline phase, active spec name, blocker count, revision count. Dashboard updates are pushed from the TypeScript side via JSON commands whenever the pipeline state changes.
- **FR-3.6:** **Interaction modes:** The glasses channel supports the same four modes as the phone channel: `requirements` (user dictates new feature), `blocker` (user resolves a blocker), `review` (user approves/rejects an artifact), `confirmation` (user confirms completion). The mode determines the HUD prompt text and the structure of the response.
- **FR-3.7:** **Audio handling:** The Python companion activates the G1 mic via BLE command `[0x0E, 0x01]` to the right arm. Audio arrives as LC3-encoded packets (`0xF1`). The companion decodes LC3 to 16kHz S16 mono PCM using `liblc3` (Google's reference implementation) and streams PCM chunks to Deepgram's WebSocket STT API. The 30-second firmware mic limit is handled by automatic re-activation: on receiving `[0xF5, 0x18]` (timeout), wait 500ms, re-send `[0x0E, 0x01]`, stitch audio buffers seamlessly.
- **FR-3.8:** The glasses module registers a `notify-glasses` tool (or extends the existing `call-retell` tool with a `channel` parameter) so the Claude Code agent can explicitly push messages to the glasses.

### FR-4: Webhook Server Changes

- **FR-4.1:** Add a `POST /webhook/glasses-input` endpoint to `scripts/server.ts`. This endpoint accepts `{ transcript: string, mode: string, source: "glasses", timestamp: string }` and produces a trigger file in `pending/` with the same schema as phone call triggers.
- **FR-4.2:** The glasses input endpoint does not require a Retell-style `call_analysis` payload. The transcript is raw text. Classification (requirements vs. confirmation) still happens via `classifyTranscript()` in the state machine.

### FR-5: Python BLE Companion

- **FR-5.1:** The companion is a Python project in `glasses-companion/` within the operant repo. It depends on `bleak` (BLE), `even_glasses` (G1 protocol, used as reference/fork), and `liblc3` (LC3 codec).
- **FR-5.2:** The companion is initialized via Claude Code plugin lifecycle hooks (e.g., `SessionStart` in `hooks/hooks.json`) rather than direct `child_process.spawn()`. Communication uses MCP protocol or plugin-native IPC (commands in / events out).
- **FR-5.3:** On startup, the companion scans for G1 devices (BLE names matching `Even G1_L_*` / `Even G1_R_*`), connects to both arms, sends init handshake (`[0x4D, 0x01]`), and starts the heartbeat loop (`0x25` every 8 seconds).
- **FR-5.4:** The companion handles all G1 BLE protocol details: dual-arm connection, left-first send ordering, heartbeat maintenance, sequence number management, packet chunking for text (191 bytes) and notifications (176 bytes).
- **FR-5.5:** The companion emits structured JSON events to stdout:
  ```
  {"type":"connected","left_battery":85,"right_battery":90}
  {"type":"disconnected","reason":"timeout"}
  {"type":"tap","action":"single","arm":"right"}
  {"type":"ai_start"}
  {"type":"ai_end"}
  {"type":"transcript","text":"...","final":true}
  {"type":"audio_chunk","pcm_b64":"..."}
  ```
- **FR-5.6:** The companion accepts JSON commands on stdin:
  ```
  {"cmd":"display_text","text":"...","page":1,"total":3,"mode":"ai"}
  {"cmd":"clear"}
  {"cmd":"notify","title":"...","message":"..."}
  {"cmd":"mic","enable":true}
  {"cmd":"dashboard","phase":"dev","spec":"auth-refactor","blockers":0}
  ```
- **FR-5.7:** The companion runs STT internally: LC3 decode -> PCM -> Deepgram WebSocket -> transcript events emitted to stdout. This keeps the audio pipeline entirely within the Python process, avoiding PCM streaming over stdin/stdout.

### FR-6: Module Structure (Codebase Refactor)

- **FR-6.1:** Reorganize into:
  ```
  src/
    state-machine.ts       (FSM -- unchanged, channel-agnostic)
    config.ts              (shared config, state file I/O)
    retell.ts              (Retell API client)
    channels/
      types.ts             (Channel interface + shared types)
      phone.ts             (Retell + cloudflared + voice agent)
      glasses.ts           (Python companion bridge)
  scripts/
    server.ts              (webhook server -- channel-agnostic endpoints)
    tunnel.sh              (cloudflared lifecycle)
    startup.sh             (plugin SessionStart hook)
    cleanup.sh             (plugin SessionEnd hook)
  hooks/
    hooks.json             (Claude Code plugin hook registration)
  glasses-companion/       (Python project -- BLE + LC3 + STT)
    main.py                (entry point, JSON-lines IPC)
    ble.py                 (bleak connection, dual-arm, heartbeat)
    protocol.py            (G1 command encoding/decoding)
    audio.py               (LC3 decode, mic chaining, Deepgram STT)
    display.py             (text formatting, pagination)
    requirements.txt       (bleak, deepgram-sdk, etc.)
  ```
- **FR-6.2:** The `Channel` interface:
  ```typescript
  interface Channel {
    readonly name: string;
    readonly available: boolean;
    start(): Promise<void>;
    stop(): Promise<void>;
    sendMessage(mode: ChannelMode, payload: OutboundPayload): Promise<void>;
    onMessage(callback: (msg: InboundMessage) => void): void;
    getStatus(): ChannelStatus;
  }
  ```
- **FR-6.3:** Plugin hooks (via `hooks/hooks.json` and `scripts/`) initialize both channel modules and dispatch state machine side effects through the channel interface. The hook scripts contain no Retell-specific or glasses-specific code.
- **FR-6.4:** The `/operant` command gains a `channel` subcommand: `/operant channel list`, `/operant channel set <phone|glasses>`, `/operant channel status`.

---

## 4. Non-Functional Constraints

- **NFC-1: State machine isolation.** `state-machine.ts` must have zero imports from channel modules. It emits side effects; the caller decides how to execute them. This is already the design from `00-init` --- this spec reinforces it.
- **NFC-2: Channel hot-swap.** Switching the active channel must not require restarting the pipeline or the Claude Code session. The channel registry supports runtime add/remove.
- **NFC-3: BLE availability.** The glasses channel reports `available: false` when the G1 is not connected (BLE scan finds no device, or connection drops). The pipeline falls back to phone automatically.
- **NFC-4: G1 display constraints.** The G1's display is monochrome (1-bit), 488px wide for text, 5 lines per screen at font size 21. All outbound messages must be formatted within these constraints. No images, no color, no rich formatting.
- **NFC-5: Latency.** Glasses channel interactions (tap -> dictate -> pipeline receives transcript) should complete in under 5 seconds (excluding STT processing time). This is significantly faster than the phone channel's 15-30 second connection + preamble.
- **NFC-6: No vendor dependency.** The glasses channel uses only open-source libraries (`bleak`, `even_glasses` protocol reference, `liblc3`). No cloud relay, no third-party companion app, no vendor account required for BLE operation. Deepgram is the only external service (STT), and it's swappable.
- **NFC-7: Python companion as plugin-managed service.** The Python companion runs as a Claude Code plugin-managed service component, initialized via `SessionStart` hooks. Communication uses MCP protocol or plugin-native IPC. No separate deployment, no socket server, no additional port.
- **NFC-8: macOS BLE permissions.** The terminal emulator running Claude Code must have Bluetooth permission in System Preferences > Privacy & Security > Bluetooth. No entitlement file needed for CLI apps.

---

## 5. Known Boundaries and Limitations

- **B-1: G1 only.** This spec targets Even Realities G1 hardware. G2 uses a different architecture (Even Hub).
- **B-2: No speaker on G1.** The G1 has no speaker. All outbound communication is visual (display text). The phone channel remains the only option for voice-based outbound (the pipeline talking to the user).
- **B-3: 30-second mic limit.** The G1 firmware enforces a 30-second max recording per mic activation. The companion works around this by chaining re-activations with a ~500ms gap. This is novel --- no existing project does it. It needs real-hardware testing.
- **B-4: G1 mic noise.** The G1's frame-mounted microphone performs poorly in noisy environments. Requirements dictation should happen in reasonably quiet settings.
- **B-5: LC3 codec.** G1 audio is LC3-encoded (not PCM). Decoding requires `liblc3` (C library with Python bindings). This is a build dependency that must be compiled.
- **B-6: No simultaneous outbound.** When the pipeline pushes a message, it goes to one channel (the active default). Broadcasting to both channels simultaneously is out of scope for v1.
- **B-7: Dictation length.** Continuous dictation beyond 10 minutes is untested. Battery drain from continuous mic + BLE + heartbeat may be a practical limit.
- **B-8: macOS only.** The Python companion uses `bleak` which supports macOS, Linux, and Windows, but this spec is only tested on macOS. Linux/Windows support is a future concern.
- **B-9: Deepgram dependency.** Real-time STT requires a Deepgram API key and internet connectivity. Offline STT (Whisper) is a future optimization.

---

## 6. Open Questions

- **OQ-1:** Should STT (Deepgram) run inside the Python companion process or in the TypeScript side? Running it in Python keeps audio entirely in-process (no PCM over stdin/stdout). Running it in TypeScript keeps all external API keys in one place.
- **OQ-2:** Should the Python companion use `even_glasses` as a pip dependency (GPL-3.0 license implications) or fork/rewrite the relevant protocol code under a permissive license?
- **OQ-3:** How should review summaries be formatted for the G1's tiny monochrome display? Full artifact TL;DR may be too long. Should we use a structured format (bullet points with page numbers)?

---

## 7. Existing Assets

| Asset | Location | Status |
|-------|----------|--------|
| `even_glasses` Python library | PyPI `even-glasses`, GitHub `emingenc/even_glasses` | Available -- dual BLE, heartbeat, text display. No mic. GPL-3.0. |
| G1 BLE protocol reference | `references/g1-ble-protocol.md` | Documented -- full command table from EvenDemoApp + AGiXT |
| `liblc3` (LC3 codec) | GitHub `google/liblc3` | Available -- C reference impl with Python wrapper |
| `lc3codec` (JS) | npm `lc3codec` | Available -- pure JS, archived but spec is frozen |
| Deepgram SDK | npm `@deepgram/sdk`, pip `deepgram-sdk` | Available -- WebSocket streaming STT |
| EvenDemoApp | GitHub `even-realities/EvenDemoApp` | Flutter reference impl -- protocol details for mic, images, AI flow |
| AGiXT BLE Protocol | GitHub `AGiXT/mobile` | Most complete protocol doc |
| `bleak` | PyPI `bleak` | v3.0.1 -- proven macOS BLE, dual connections via asyncio |
| Existing pipeline code | `operant/src/` | Built -- needs refactor into channel modules |
| Existing Retell integration | `src/retell.ts`, `scripts/server.ts`, plugin hooks in `hooks/hooks.json` | Built -- becomes the phone channel module |
| Existing voice agent prompt | `prompts/voice-agent.md` | Built -- phone channel only, no changes needed |
| Plugin manifest | `.claude-plugin/plugin.json` | Configured -- defines commands, agents, hooks for Claude Code |
| MentraOS Developer Console | `console.mentra.glass` | Account created (`pranav@dhoolia.com`), app registered (`com.secondaxis.operantpi`), API key in `data/.env` -- may be useful later if MentraOS stabilizes |
