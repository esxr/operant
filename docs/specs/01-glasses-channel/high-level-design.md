# High-Level Design: Multi-Channel Architecture + G1 Smart Glasses Channel

**Version:** 2.0  
**Date:** 2026-06-06  
**Status:** Draft  
**Based on:** Intent & Constraints v2.0 (`01-glasses-channel`)  
**Depends on:** `00-init` HLD v2.0 (base pipeline architecture)  
**Changes from v1.0:** Replaced MentraOS with Python BLE companion (`bleak` + `even_glasses` fork + `liblc3` + Deepgram). Architecture is now: G1 <-BLE-> Python BLE bridge <-MCP/plugin IPC-> Claude Code plugin.

---

## 1. Overview

This design adds a channel abstraction layer to operant and implements the G1 smart glasses as a second communication channel alongside the existing phone call channel. The state machine from `00-init` is untouched --- it already emits side effects without knowing how they're executed. This design formalizes that boundary and adds the glasses-specific components.

The glasses channel is built on a **Python BLE bridge** that connects directly to the G1 via BLE, handling the full protocol (dual-arm connection, heartbeat, mic activation, LC3 decoding, text display). The Claude Code plugin communicates with the BLE bridge via MCP protocol or plugin-native IPC.

## 2. Goals and Non-Goals

### Goals

- Channel-agnostic state machine --- side effects dispatched through a `Channel` interface
- G1 glasses as a full input/output channel via direct BLE (no intermediary app)
- Persistent HUD dashboard showing pipeline status
- Module-based codebase: `channels/phone.ts`, `channels/glasses.ts`, shared `Channel` interface
- Both channels coexist; user picks a default, fallback is automatic
- Full control over audio pipeline (LC3 -> PCM -> STT) with no vendor dependency

### Non-Goals

- G2 / Even Hub support (different architecture entirely)
- Chat or web UI channel (future --- but the interface is designed to support it)
- Simultaneous broadcast to multiple channels
- Offline STT (Deepgram cloud STT for v1; Whisper self-hosted is future)
- Phone companion app (BLE connects directly from macOS, no phone needed)
- MentraOS integration (evaluated and rejected --- flaky app, unreliable support)

## 3. System Architecture

### Component Diagram

```
                                         ┌──────────────┐
                                         │  G1 Glasses  │
                                         │  (mic+display│
                                         │   +touchpad) │
                                         └──────┬───────┘
                                                │ BLE (Nordic UART)
                                                │ Left arm + Right arm
                                         ┌──────▼───────────────────────┐
                                         │  BLE Bridge Service          │
                                         │  (glasses-companion/main.py) │
                                         │                              │
                                         │  bleak ── dual BLE conn      │
                                         │  protocol ── G1 commands     │
                                         │  liblc3 ── LC3→PCM decode    │
                                         │  deepgram ── PCM→transcript  │
                                         │  heartbeat ── 0x25 every 8s  │
                                         └──────┬───────────────────────┘
                                                │ MCP or Plugin Native IPC
          ┌─────────────────────────────────────┤
          │                                     │
          │ PSTN                                │
          │                                     │
┌─────────▼──────────┐                          │
│   Retell.ai        │                          │
│   Voice Agent      │                          │
│   (gpt-4o-mini)    │                          │
└─────────┬──────────┘                          │
          │ Webhook (HTTPS)                     │
┌─────────▼──────────┐                          │
│ Cloudflared Tunnel │                          │
└─────────┬──────────┘                          │
          │ localhost:3456                       │
┌─────────▼─────────────────────────────────────▼──────────────┐
│                    operant server                              │
│                    (scripts/server.ts)                        │
│                                                              │
│  POST /webhook/call-completed     (phone channel inbound)    │
│  POST /webhook/glasses-input      (glasses channel inbound)  │
│  GET  /health                                                │
└─────────────────────────┬────────────────────────────────────┘
                          │ IPC (process.send)
┌─────────────────────────▼────────────────────────────────────┐
│               Claude Code Plugin (hooks + glue)               │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │              Channel Registry                          │  │
│  │  ┌─────────────────┐    ┌──────────────────────────┐   │  │
│  │  │ channels/       │    │ channels/                │   │  │
│  │  │ phone.ts        │    │ glasses.ts               │   │  │
│  │  │                 │    │                          │   │  │
│  │  │ - src/retell.ts │    │ - BLE bridge service     │   │  │
│  │  │ - scripts/      │    │   (plugin-managed)       │   │  │
│  │  │   tunnel.sh     │    │                          │   │  │
│  │  │ - voice-agent   │    │ - MCP / plugin IPC       │   │  │
│  │  │   prompt mgmt   │    │ - notify-glasses tool    │   │  │
│  │  │ - call-retell   │    │ - dashboard updates      │   │  │
│  │  │   tool          │    │                          │   │  │
│  │  └────────┬────────┘    └────────────┬─────────────┘   │  │
│  │           │                          │                 │  │
│  │           └──────────┬───────────────┘                 │  │
│  │                      │ Channel interface               │  │
│  └──────────────────────┼─────────────────────────────────┘  │
│                         │                                    │
│  ┌──────────────────────▼─────────────────────────────────┐  │
│  │              State Machine                              │  │
│  │              (state-machine.ts)                          │  │
│  │              UNCHANGED from 00-init                      │  │
│  │              - emits SideEffects                         │  │
│  │              - no channel imports                        │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                              │
│  hooks/hooks.json ←→    scripts/*.sh                         │
│  SessionStart           PreToolUse / PostToolUse / Stop      │
└──────────────────────────────────────────────────────────────┘
```

### Module Dependency Graph

```
hooks/hooks.json (Claude Code plugin hook registration)
  ├── SessionStart  → scripts/startup.sh (init channels, start server)
  ├── PostToolUse   → scripts/detect-artifact.sh
  ├── Stop          → scripts/validate-state.sh
  └── SessionEnd    → scripts/cleanup.sh

src/
  ├── state-machine.ts          (FSM logic — no channel deps)
  ├── config.ts                 (shared config, state file I/O)
  ├── channels/types.ts         (Channel interface, shared types)
  ├── channels/phone.ts         (Retell channel)
  │     └── src/retell.ts       (Retell API client)
  └── channels/glasses.ts       (G1 glasses channel)
        └── MCP server ('glasses-ble-server') or plugin-managed subprocess

scripts/
  ├── server.ts                 (webhook server — channel-agnostic)
  ├── tunnel.sh                 (cloudflared lifecycle)
  └── inject-context.sh         (UserPromptSubmit hook)

glasses-companion/ (Python — standalone, no TS deps)
  ├── main.py                   (entry point, JSON-lines IPC loop)
  ├── ble.py                    (bleak scan, dual-arm connect, heartbeat)
  ├── protocol.py               (G1 command encode/decode, 0x4E/0x4B/0x0E/etc.)
  ├── audio.py                  (mic activation, LC3 decode, 30s chaining, Deepgram STT)
  └── display.py                (text pagination, dashboard formatting)
```

## 4. Data Flow

### Flow A: Requirements via Glasses

```
1.  User long-presses G1 left TouchBar
2.  G1 sends [0xF5, 0x17] (AI start) via BLE to Python companion
3.  Companion sends [0x0E, 0x01] to right arm (enable mic)
4.  G1 streams LC3 audio via [0xF1, seq, data...] packets
5.  Companion decodes LC3 → PCM (16kHz S16 mono) via liblc3
6.  Companion streams PCM to Deepgram WebSocket → interim transcripts
7.  Companion displays interim transcript on G1 via 0x4E (text show mode 0x71)
8.  At 30s timeout: companion receives [0xF5, 0x18], waits 500ms,
    re-sends [0x0E, 0x01], audio resumes (seamless chaining)
9.  User releases TouchBar → [0xF5, 0x18] → companion disables mic [0x0E, 0x00]
10. Companion emits JSON: {"type":"transcript","text":"...","final":true}
11. channels/glasses.ts receives event, POSTs to scripts/server.ts /webhook/glasses-input
12. scripts/server.ts writes trigger file to pending/, sends IPC
13. Plugin hook receives IPC → emits operant:input-received
14. State machine: same triage → classify → create spec flow as phone
```

### Flow B: Outbound Review via Glasses

```
1.  State machine emits TRIGGER_REVIEW_CALL side effect
2.  Plugin hook checks active channel → glasses
3.  channels/glasses.ts sends JSON command to Python companion:
      {"cmd":"display_text","text":"...","page":1,"total":3,"mode":"review"}
4.  Companion formats text for G1 (488px, 5 lines, paginated)
5.  Companion sends to G1 via 0x4E protocol (L first, then R)
6.  User reads, taps right TouchBar to page forward, left to page back
7.  User long-presses to dictate response → same audio flow as Flow A
8.  Transcript POSTed to /webhook/glasses-input with mode=review
9.  State machine: REVIEW_APPROVED or REVIEW_REJECTED, same as phone path
```

### Flow C: Blocker Escalation via Glasses

```
1.  Dev agent writes blocker file, exits
2.  Stop hook detects new blocker → state machine emits TRIGGER_BLOCKER_CALL
3.  Plugin hook checks active channel → glasses
4.  channels/glasses.ts sends JSON command:
      {"cmd":"display_text","text":"BLOCKER: ...","page":1,"total":1,"mode":"blocker"}
5.  Companion renders blocker on G1 display
6.  User reads, long-presses to dictate resolution
7.  Response POSTed to /webhook/glasses-input with mode=blocker
8.  Pipeline continues (same as 00-init Flow B steps 8-9)
```

### Flow D: Persistent Dashboard

```
1.  On pipeline state change, plugin hook emits operant:phase-changed
2.  channels/glasses.ts sends JSON command:
      {"cmd":"dashboard","phase":"dev","spec":"auth-refactor","blockers":0,"revisions":1}
3.  Companion formats dashboard for G1 display (compact, single screen)
4.  Companion sends to G1 via 0x4E (text show mode 0x71)
5.  Dashboard auto-updates on every state transition
6.  Dashboard is replaced when an interaction starts, restored when it ends
```

## 5. Technology Choices

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Channel interface | TypeScript interface in `channels/types.ts` | Same language as everything else; compile-time enforcement |
| BLE connectivity | Python `bleak` v3.0.1 | Native CoreBluetooth on macOS, proven dual-connection, asyncio |
| G1 protocol | Fork/reference `even_glasses` | Handles dual-arm connect, heartbeat, text display. 79 stars, most mature G1 Python lib |
| LC3 decoding | Google `liblc3` (C + Python wrapper) | Reference implementation, 16kHz/10ms/20-byte frames match G1 output exactly |
| STT | Deepgram Nova-3 WebSocket | Sub-300ms latency, native 16kHz linear16 mono support, $0.0077/min |
| Bridge ↔ plugin | MCP protocol or plugin-native IPC | Plugin framework manages service lifecycle; no sockets, no extra ports |
| G1 display | BLE command `0x4E` | Direct protocol: 488px, 5 lines, font 21, paginated |
| Phone channel | Retell.ai (unchanged) | Already built, still needed as fallback |

## 6. Key Design Decisions

- **D-1: Channel interface, not channel base class.** Channels implement a TypeScript interface, not extend an abstract class. Phone and glasses channels share no implementation --- their internals are completely different (Python+BLE vs PSTN+voice agent). An interface enforces the contract without forcing artificial code sharing.

- **D-2: Server stays channel-agnostic.** `scripts/server.ts` gets a new endpoint (`/webhook/glasses-input`) but the trigger file format is identical to phone triggers. The server doesn't import channel code --- it just writes files and sends IPC. Channel identification is a `source` field in the trigger file.

- **D-3: Python BLE bridge as plugin service.** The bridge runs as a Claude Code plugin-managed subprocess or MCP server (configured in `.mcp.json`). Plugin framework handles service lifecycle and IPC via `SessionStart`/`SessionEnd` hooks. No manual `child_process.spawn()`, no WebSocket, no HTTP server, no extra port.  
  *Resolves OQ-1 from v1.0.*

- **D-4: STT runs inside the Python companion.** Deepgram WebSocket connection is managed by the Python process. Audio never leaves the companion as raw PCM --- only transcripts are emitted as JSON events. This avoids streaming binary audio over stdin/stdout and keeps the Deepgram API key in one place (Python env or `.env` file).  
  *Resolves OQ-1 from v2.0.*

- **D-5: Structured bullet-point format for G1 reviews.** The G1's 488px monochrome display can't render long prose. Review summaries are formatted as numbered bullet points with a "Page X/Y" header. Each page fits 5 lines. User taps right TouchBar to advance, left to go back.  
  *Resolves OQ-3.*

- **D-6: Glasses handle all interaction types.** The glasses channel supports all four modes (requirements, review, blocker, confirmation). Complex reviews work because the summary is pre-generated by the LLM (same `artifact_summary` as phone), just formatted differently for the display.

- **D-7: Rewrite G1 protocol code, don't depend on `even_glasses` directly.** The `even_glasses` library is GPL-3.0, which would infect the operant codebase. Instead, use it as a **reference** and rewrite the relevant protocol handling (dual-arm connect, heartbeat, command encoding) under our own license. The BLE protocol is documented in `references/g1-ble-protocol.md`.  
  *Resolves OQ-2 from v2.0.*

- **D-8: Channel abstraction lives in operant, not extracted.** Simple interface + registry (~50 lines). Premature to extract.

- **D-9: Rename IPC event from `operant:call-completed` to `operant:input-received`.** The event represents "user sent input to the pipeline" regardless of channel. The payload gains a `source: "phone" | "glasses"` field.

- **D-10: Separation of scripts and source.** `retell.ts` stays in `src/`, while `tunnel.sh` and `server.ts` live in `scripts/`. Hook scripts in `scripts/` are shell-based, matching the Claude Code plugin hook mechanism (`hooks/hooks.json`).

- **D-11: 30-second mic chaining is automatic and invisible.** The Python companion handles re-activation internally. The TypeScript side never sees the 30-second boundary --- it just receives a continuous transcript stream. A ~500ms silence is inserted at each boundary; Deepgram handles this naturally.

## 7. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| G1 BLE disconnect during dictation | H | Auto-reconnect in companion. Partial transcript saved. Dashboard shows "reconnecting..." |
| 30-second mic chaining fails (firmware rejects re-enable) | H | 500ms debounce before re-send. Fallback: accept 30s segments as separate transcripts. Needs real-hardware testing. |
| LC3 decoding issues (`liblc3` build fails) | M | Fallback: `lc3codec` npm package (pure JS, archived but functional). Can run LC3 decode in Node.js instead. |
| `bleak` macOS BLE permissions denied | M | Clear error message: "Grant Bluetooth permission to Terminal in System Preferences" |
| G1 mic quality in noisy environments | M | Dashboard shows live transcript so user can verify before sending. Fallback: phone channel. |
| Deepgram outage → no STT | M | Glasses channel reports `available: false` for dictation (display still works). Fallback: phone channel. |
| Python not installed or wrong version | L | Check at startup: `python3 --version`. Require 3.10+. |
| `bleak` dual-connection issues on specific macOS versions | M | Pin bleak version. Test on Sequoia. Fallback: phone channel. |

## 8. Open Questions

### Resolved (from v1.0)

- [x] OQ-1 (v1): Mini app as forked child or co-located? → Child process (D-3)
- [x] OQ-2 (v1): Reuse tunnel or separate? → N/A (no tunnel needed --- direct BLE)
- [x] OQ-3 (v1): Review format for G1? → Structured bullet points, paginated (D-5)
- [x] OQ-4 (v1): Full SDLC review on glasses? → Yes, all modes (D-6)
- [x] OQ-5 (v1): Fork Mentra app? → N/A (no Mentra app --- direct BLE)
- [x] OQ-6 (v1): Extract channel abstraction? → No (D-8)
- [x] OQ-1 (v2): STT in Python or TypeScript? → Python (D-4)
- [x] OQ-2 (v2): Use even_glasses as dep or rewrite? → Rewrite, use as reference (D-7)

### Remaining

- [ ] **OQ-3 (v2):** Review summary formatting --- how many bullet points per page? Should we truncate long summaries or always paginate?

## 9. Traceability

| Requirement | HLD Section | Decision |
|-------------|-------------|----------|
| FR-1.1 Channel interface | 3. Channel Registry | D-1 |
| FR-1.2 Channel registry | 3. Channel Registry | D-8 |
| FR-1.3 Side effect dispatch | 3. State Machine (unchanged) | D-2 |
| FR-1.4 Channel selection + fallback | 7. Risks | D-1 |
| FR-1.5 Uniform trigger file format | 4. Flow A step 11-12 | D-2, D-9 |
| FR-2.1 Phone module extraction | 3. Module Dependency Graph | D-10 |
| FR-2.2 Phone encapsulation | 3. channels/phone.ts, scripts/ | D-10 |
| FR-2.3 Phone sendMessage | 4. (unchanged from 00-init) | -- |
| FR-2.4 Phone inbound path | 4. (unchanged) | D-9 |
| FR-2.5 call-retell tool scoping | 3. channels/phone.ts | D-1 |
| FR-3.1 Glasses module | 3. channels/glasses.ts | D-1 |
| FR-3.2 Python BLE companion | 3. Component Diagram | D-3 |
| FR-3.3 Inbound dictation | 4. Flow A | D-4, D-11 |
| FR-3.4 Outbound push | 4. Flow B, Flow C | D-5 |
| FR-3.5 Persistent dashboard | 4. Flow D | -- |
| FR-3.6 Interaction modes | 4. Flows A-C | D-6 |
| FR-3.7 Audio handling | 4. Flow A steps 3-8 | D-4, D-11 |
| FR-3.8 notify-glasses tool | 3. channels/glasses.ts | D-1 |
| FR-4.1 /webhook/glasses-input | 3. scripts/server.ts endpoints | D-2 |
| FR-4.2 Raw transcript input | 4. Flow A step 11 | D-2 |
| FR-5.1 Python project | 3. Module Dependency Graph | D-3 |
| FR-5.2 Spawned child process | 3. Component Diagram | D-3 |
| FR-5.3 BLE scan + connect | 4. Flow A steps 2-3 | D-7 |
| FR-5.4 G1 protocol handling | 3. glasses-companion/ | D-7 |
| FR-5.5 JSON events (stdout) | 4. Flow A step 10 | D-3 |
| FR-5.6 JSON commands (stdin) | 4. Flows B-D | D-3 |
| FR-5.7 STT in Python | 4. Flow A steps 5-6 | D-4 |
| FR-6.1 src/ + scripts/ reorganization | 3. Module Dependency Graph | D-10 |
| FR-6.2 Channel interface def | 3. Channel Registry | D-1 |
| FR-6.3 Plugin hooks as pure glue | 3. hooks/hooks.json + scripts/ | D-2 |
| FR-6.4 /operant channel cmd | (command layer, not HLD) | -- |
| NFC-1 FSM isolation | 3. State Machine box | D-2 |
| NFC-2 Channel hot-swap | 6. D-1 (interface) | D-1 |
| NFC-3 BLE availability | 7. Risk: disconnect | D-1 |
| NFC-4 G1 display constraints | 6. D-5 | D-5 |
| NFC-5 Latency | 4. Flow A (no call setup) | -- |
| NFC-6 No vendor dependency | 5. Technology Choices | D-7 |
| NFC-7 Child process | 3. Module Dependency Graph | D-3 |
| NFC-8 macOS BLE permissions | 7. Risk: permissions | -- |
