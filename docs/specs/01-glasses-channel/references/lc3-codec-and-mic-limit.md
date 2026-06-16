# LC3 Codec Decoding & 30-Second Mic Limit Workaround

**Date:** 2026-06-06

---

## 1. LC3 Codec Libraries

### Node.js / TypeScript

| Library | Type | Status | Notes |
|---------|------|--------|-------|
| **`lc3codec`** (npm) | Pure JS | Archived (Jan 2024) | LC3 v1.0 spec is frozen, so archived is fine. Supports Node 10+ and browsers. |
| **Google `liblc3`** (C) | Native / WASM | Active | Reference impl. Can compile to WASM via Emscripten. No pre-built npm package. |

### Python

| Library | Type | Notes |
|---------|------|-------|
| **Google `liblc3` Python wrapper** | ctypes/cffi | In `liblc3` repo `python/` dir. Build C lib, then use wrapper. No PyPI package. |

### G1-Specific LC3 Parameters

| Parameter | Value |
|-----------|-------|
| Sample Rate | 16,000 Hz |
| Frame Duration | 10 ms |
| Encoded Frame Size | 20 bytes |
| Decoded Frame Size | 320 bytes (160 S16 samples) |
| Bitrate | 16 kbps |
| Channels | 1 (mono) |

### BLE Packet -> PCM Pipeline

```
0xF1 BLE packet (202 bytes total)
  -> strip header (bytes 0-1: cmd + seq)
  -> 200 bytes LC3 data
  -> split into 10 x 20-byte frames
  -> LC3 decode each -> 160 S16 PCM samples (320 bytes)
  -> concatenate -> 3200 bytes PCM = 100ms audio per BLE packet
```

---

## 2. 30-Second Mic Limit

### What Happens at 30 Seconds

The limit is **firmware-enforced**. At 30 seconds (or on TouchBar release):
1. Glasses send `[0xF5, 0x18]` (recording stopped)
2. Audio stream ceases
3. This happens regardless of whether the user is still holding the TouchBar

### Chaining Workaround

```
State: RECORDING
  -> receive [0xF5, 0x18] (30s timeout)
  -> wait 500ms (debounce -- firmware rejects rapid re-enable)
  -> send [0x0E, 0x01] to right arm (re-enable mic)
  -> receive [0x0E, 0xC9, 0x01] (mic re-enabled)
  -> audio stream resumes with new sequence numbers
  -> stitch PCM buffers, insert ~500-700ms silence for the gap
  -> STT handles the gap naturally (within normal speech pause range)
```

**No existing project implements continuous chaining.** This is novel.

### Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Firmware rejects rapid re-enable | Medium | 500ms delay after stop event |
| Audio gap causes STT errors | Low | 500-700ms is within normal speech pause |
| Sequence number reset | Low | Track internally, don't rely on continuity |
| Battery drain (continuous mic) | Medium | Test actual drain; 15 min continuous use |

### Alternative: Phone Mic

Even's own app supports "Phone Mic" mode -- audio captured by the phone, not the glasses. **No 30-second limit.** Better audio quality. Requires phone to be accessible.

---

## 3. STT Options

### Deepgram Nova-3 (Recommended)

- **Format match:** `linear16, 16000Hz, mono` -- exact match for decoded G1 LC3
- **Latency:** Sub-300ms streaming
- **Protocol:** WebSocket, persistent bidirectional
- **Chunk size:** 100ms (3200 bytes) -- matches G1 per-packet output
- **SDK:** `@deepgram/sdk` (npm)
- **Pricing:** $0.0077/minute

### AssemblyAI Universal-3 Pro

- **Format:** `pcm_s16le` at 16000Hz -- also exact match
- **Latency:** ~300ms P50
- **Advantage:** Better alphanumeric accuracy

### Self-Hosted Whisper

- **Advantage:** No API costs, local processing
- **Disadvantage:** Requires GPU, batch-oriented, not truly real-time

---

## Sources

- https://www.npmjs.com/package/lc3codec
- https://github.com/google/liblc3
- https://github.com/even-realities/EvenDemoApp
- https://github.com/AGiXT/mobile/blob/main/Even%20Realities%20G1%20BLE%20Protocol.txt
- https://developers.deepgram.com/docs/live-streaming-audio
- https://www.assemblyai.com/products/streaming-speech-to-text
