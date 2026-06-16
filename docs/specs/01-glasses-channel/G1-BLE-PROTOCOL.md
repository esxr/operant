# Even Realities G1 — Complete BLE Protocol Specification

> Compiled from: AGiXT protocol doc, EvenDemoApp (official Flutter demo), emingenc/even_glasses (Python),
> radioegor146/even-utils (Java reverse-engineering). Last updated 2026-06-06.

---

## 1. BLE Transport Layer

### 1.1 Service & Characteristic UUIDs (Nordic UART Service)

| Role | UUID |
|------|------|
| **UART Service** | `6E400001-B5A3-F393-E0A9-E50E24DCCA9E` |
| **TX Characteristic** (phone writes to glasses) | `6E400002-B5A3-F393-E0A9-E50E24DCCA9E` |
| **RX Characteristic** (glasses notifies phone) | `6E400003-B5A3-F393-E0A9-E50E24DCCA9E` |
| **CCCD Descriptor** (enable notifications) | `00002902-0000-1000-8000-00805f9b34fb` |

### 1.2 Dual-BLE Architecture

The G1 has **two independent BLE radios** — one in each arm (temple):

- **Left arm** — advertises with `_L_` in device name
- **Right arm** — advertises with `_R_` in device name
- Device name pattern: `G1_[channel]_[L|R]_[serial]` (regex: `G\d+_\d+_[LR]_\w+`)
- Both devices sharing the same channel number belong to the same pair

**Connection procedure:**
1. Scan for BLE devices matching the `G1_` naming pattern
2. Group discovered devices by channel number
3. Connect to both L and R peripherals via `connectGatt()`
4. For each: discover services, find UART service, locate TX/RX characteristics
5. Enable notifications on RX characteristic (write `0x01 0x00` to CCCD descriptor)
6. Send initialization handshake: `[0x4D, 0x01]` (Init command) — sent to left arm
7. Send debug mode enable: `[0xF4, 0x01]` — sent to both arms
8. Request MTU of **251 bytes** (Android: `gatt.requestMtu(251)`)
9. Start heartbeat timer

**Write ordering:** For commands targeting both arms, send to **left first**, wait for acknowledgment, then send to **right**. Platform-specific inter-packet delays: 8ms (iOS), 5ms (Android).

**Write types:** `WRITE_TYPE_NO_RESPONSE` or `WRITE_TYPE_DEFAULT` depending on command.

### 1.3 Generic Response Codes

All commands that expect a response use these status bytes:

| Byte | Meaning |
|------|---------|
| `0xC9` | Success |
| `0xCA` | Failure |
| `0xCB` | Continue / more data follows |

Response format: `[command_byte, status_byte, ...]`

### 1.4 Serial Number Format

Format: `S[Frame][Color][Serial]`
- Frame: `S100` = Round, `S110` = Square
- Color: `AA` = Grey, `BB` = Brown, `CC` = Green
- Example: `S110LAAL103842` = Square, Grey

---

## 2. Heartbeat Protocol (0x25)

**Critical** — the glasses disconnect after ~32 seconds without a heartbeat.

| Field | Value |
|-------|-------|
| Command | `0x25` |
| Target | Both arms |
| Interval | Every 5-8 seconds (code uses 5s or 8s depending on implementation) |
| Disconnect timeout | ~32 seconds of inactivity |

**Packet format (6 bytes):**
```
[0x25, length_lo, length_hi, seq, 0x04, seq]
```
- `length_lo` / `length_hi`: total packet length as little-endian uint16 (always `0x06, 0x00`)
- `seq`: heartbeat sequence counter, 0x00-0xFF, wraps around (independent from global seq)

**No response expected.**

---

## 3. Control Commands (Phone -> Glasses)

### 3.1 Microphone Control (0x0E)

| Field | Value |
|-------|-------|
| Command | `0x0E` |
| Target | Both arms (mic is on right arm) |
| Direction | Phone -> Glasses |

**Send:** `[0x0E, enable]`
- `enable`: `0x01` = turn on, `0x00` = turn off

**Response:** `[0x0E, status, enable_echo]`
- `status`: `0xC9` (success) or `0xCA` (failure)

### 3.2 Send Text / AI Result (0x4E)

| Field | Value |
|-------|-------|
| Command | `0x4E` |
| Target | Both arms |
| Max display width | 488 pixels |
| Font size | 21 (customizable) |
| Lines per screen | 5 |

**Packet format (9-byte header + data):**
```
Byte 0: 0x4E          — command
Byte 1: seq            — sequence number (0x00-0xFF)
Byte 2: total_packages — total chunks for this content (0x01-0xFF)
Byte 3: current_package — current chunk index (0x00-0xFF)
Byte 4: screen_status  — display state (see below)
Byte 5: new_char_pos0  — character position low byte (big-endian int16)
Byte 6: new_char_pos1  — character position high byte
Byte 7: page_number    — current page (1-255)
Byte 8: max_pages      — total pages (1-255)
Byte 9+: data          — UTF-8 encoded text
```

**Screen Status Byte (Byte 4) — combined from upper + lower nibble:**

| Upper Nibble | Meaning |
|-------------|---------|
| `0x30` | Even AI: displaying (streaming) |
| `0x40` | Even AI: display complete |
| `0x50` | Even AI: manual pagination mode |
| `0x60` | Even AI: network error |
| `0x70` | Text show mode (non-AI) |

| Lower Nibble | Meaning |
|-------------|---------|
| `0x01` | New content / new screen |

Combined examples: `0x31` = new AI content displaying, `0x41` = AI display complete + new, `0x71` = text show new content.

**Chunking:** Text data exceeding MTU is split into chunks of max 191 bytes each. Each chunk gets a header with sequence/total/current tracking.

**Pagination:** 5 lines per screen. Pages = ceil(total_lines / 5).

### 3.3 Send Notification (0x4B)

| Field | Value |
|-------|-------|
| Command | `0x4B` |
| Target | Left arm |
| Max chunk size | 176 bytes payload (180 minus 4-byte header) |

**Packet format:**
```
Byte 0: 0x4B          — command
Byte 1: notify_id     — notification message ID
Byte 2: total_chunks  — total number of chunks (0x01-0xFF)
Byte 3: chunk_index   — current chunk sequence (0x00-0xFF)
Byte 4+: JSON payload — UTF-8 encoded JSON (max 176 bytes per chunk)
```

**Notification JSON structure:**
```json
{
  "msg_id": 1,
  "type": 1,
  "app_identifier": "com.example.app",
  "title": "Notification Title",
  "subtitle": "Optional Subtitle",
  "message": "Notification body text",
  "display_name": "App Name",
  "time_s": 1717689600,
  "date": "2026-06-06 12:00:00"
}
```

### 3.4 Clear Notification (0x4C)

| Field | Value |
|-------|-------|
| Command | `0x4C` |
| Target | Left arm |

**Send:** `[0x4C]`
**Response:** Generic success/failure.

### 3.5 Set Notification Settings (0x04)

| Field | Value |
|-------|-------|
| Command | `0x04` |
| Target | Left arm |
| Max chunk size | 180 bytes per chunk |

**Packet format:**
```
Byte 0: 0x04
Byte 1: chunk_count (0x01-0xFF)
Byte 2: sequence (0x00-0xFF)
Byte 3+: JSON config (max 180 bytes)
```

**Configuration JSON:**
```json
{
  "calendar_enable": true,
  "Call_enable": true,
  "Msg_enable": true,
  "Ios_mail_enable": true,
  "app": {
    "List": [
      {"id": "com.example.app", "name": "App Name"}
    ],
    "enable": true
  }
}
```

### 3.6 Image / BMP Display (0x15 + 0x20 + 0x16)

| Field | Value |
|-------|-------|
| Image format | 1-bit BMP, 576x136 pixels |
| Chunk size | 194 bytes per packet |
| Target | Both arms |

**Three-step process:**

**Step 1 — Send image data packets (0x15):**

First packet:
```
[0x15, seq, 0x00, 0x1C, 0x00, 0x00, data0...data193]
```
- `seq`: packet index (0x00 for first)
- `0x00, 0x1C, 0x00, 0x00`: storage address (little-endian, fixed)
- `data`: up to 194 bytes of BMP data

Subsequent packets:
```
[0x15, seq, data0...data193]
```
- Address bytes omitted after first packet
- Inter-packet delay: 8ms (iOS), 5ms (Android)

**Step 2 — Send termination command (0x20):**
```
[0x20, 0x0D, 0x0E]
```
- Timeout: 3 seconds, up to 10 retries

**Step 3 — Send CRC32 verification (0x16):**
```
[0x16, crc_b3, crc_b2, crc_b1, crc_b0]
```
- CRC32-XZ computed over: `[0x00, 0x1C, 0x00, 0x00] + raw_image_data`
- CRC bytes in **big-endian** order
- Success when response byte at index 5 equals `0xC9`

### 3.7 Clear Screen (0x18)

| Field | Value |
|-------|-------|
| Command | `0x18` |
| Target | Both arms |

**Send:** `[0x18]`
**Effect:** Clears all bitmaps and text from display.
**Response:** Generic success/failure.

Alternative clear method via TouchBar emulation:
```
[0xF5, 0x18, 0x00, 0x00, 0x00]
```

### 3.8 Set Brightness (0x01)

| Field | Value |
|-------|-------|
| Command | `0x01` |
| Target | Right arm |
| Range | 0x00-0x2A (0-42) |

**Send:** `[0x01, brightness_level, auto_brightness]`
- `brightness_level`: 0x00 (dimmest) to 0x2A (brightest)
- `auto_brightness`: `0x00` (off) or `0x01` (on)

**Response:** Generic success/failure.

### 3.9 Set Silent Mode (0x03)

| Field | Value |
|-------|-------|
| Command | `0x03` |
| Target | Both arms |

**Send:** `[0x03, mode, 0x00]`
- `mode`: `0x0C` = silent on, `0x0A` = silent off

**Response:** Generic success/failure.

### 3.10 Dashboard Settings (0x06)

| Field | Value |
|-------|-------|
| Command | `0x06` |
| Target | Both arms |

**Packet header:**
```
Byte 0: 0x06
Byte 1: total_length (low byte)
Byte 2: 0x00 (pad / length high byte)
Byte 3: sequence (0x00-0xFF)
Byte 4+: subcommand + payload
```

#### Subcommand 0x01 — Set Time & Weather

```
Byte 4:  0x01 (subcommand)
Byte 5-8: epoch_seconds (32-bit, 4 bytes)
Byte 9-16: epoch_milliseconds (64-bit, 8 bytes)
Byte 17: weather_icon_id (0x00-0x10)
Byte 18: temperature_celsius (signed byte)
Byte 19: unit_flag (0x00 = Celsius, 0x01 = Fahrenheit)
Byte 20: time_format (0x00 = 24H, 0x01 = 12H)
```

**Weather Icon IDs:**
| ID | Weather |
|----|---------|
| 0x00 | None |
| 0x01 | Night/Clear |
| 0x02 | Clouds |
| 0x03 | Drizzle |
| 0x04 | Heavy Drizzle |
| 0x05 | Rain |
| 0x06 | Heavy Rain |
| 0x07 | Thunder |
| 0x08 | Thunderstorm |
| 0x09 | Snow |
| 0x0A | Mist |
| 0x0B | Fog |
| 0x0C | Sand |
| 0x0D | Squalls |
| 0x0E | Tornado |
| 0x0F | Freezing |
| 0x10 | Sunny |

#### Subcommand 0x02 — Set Dashboard Mode

```
Byte 4: 0x02 (subcommand)
Byte 5: display_mode
Byte 6: secondary_pane
```

**Display modes:**
| Value | Mode |
|-------|------|
| 0x00 | Full |
| 0x01 | Dual |
| 0x02 | Minimal |

**Secondary pane (for Dual mode):**
| Value | Pane |
|-------|------|
| 0x00 | Quick Notes |
| 0x01 | Stocks |
| 0x02 | News |
| 0x03 | Calendar |
| 0x04 | Navigation / Citywalk |
| 0x05+ | Empty |

### 3.11 Dashboard Show State (0x26 variant)

**Send:** `[0x26, 0x07, 0x00, 0x01, 0x02, state, position]`
- `state`: `0x01` = ON, `0x00` = OFF
- `position`: dashboard position index

### 3.12 Set Display Settings (0x26)

| Field | Value |
|-------|-------|
| Command | `0x26` |
| Target | Both arms |

**Send:**
```
[0x26, 0x08, 0x00, seq, 0x02, preview, height, depth]
```
- `preview`: `0x01` = preview mode, `0x00` = final/commit
- `height`: 0x00-0x08
- `depth`: 0x01-0x09

**Response:** `[0x26, 0x06, 0x00, seq, 0x02, status]`

**Important:** Must send twice — first with preview=1, then after a delay with preview=0 to commit.

### 3.13 Set Head-Up Angle (0x0B)

| Field | Value |
|-------|-------|
| Command | `0x0B` |
| Target | Right arm |
| Range | 0-60 degrees |

**Send:** `[0x0B, angle, 0x01]`
- `angle`: 0x00-0x3C (0-60 degrees)

**Response:** `[0x0B, status]` where status = `0xC9` or `0xCA`

### 3.14 Set Wear Detection (0x27)

| Field | Value |
|-------|-------|
| Command | `0x27` |
| Target | Both arms |

**Send:** `[0x27, enable]`
- `enable`: `0x01` = on, `0x00` = off

When enabled, glasses send `0xF5` events on wear state changes.

### 3.15 Init Command (0x4D)

| Field | Value |
|-------|-------|
| Command | `0x4D` |
| Target | Left arm |

**Send:** `[0x4D, 0x01]` (alternative: `[0x4D, 0xFB]`)

Sent immediately after BLE connection established.

### 3.16 Hard Reset (0x23 0x72)

**Send:** `[0x23, 0x72]` to both arms. No response.

### 3.17 Sequence Sync (0x22 0x05)

| Field | Value |
|-------|-------|
| Target | Right arm |

**Send:** `[0x22, 0x05, 0x00, seq, 0x01]`
**Response:** `[0x22, 0x05, 0x00, seq, 0x01, 0x00, 0x01]`

### 3.18 Dashboard Lock (0x50)

| Field | Value |
|-------|-------|
| Target | Right arm |

**Send:** `[0x50, 0x06, 0x00, 0x00, 0x01, 0x01]`
**Response:** Echo of command.

### 3.19 Debug Mode (0xF4)

**Send:** `[0xF4, enable]` to both arms.
- `enable`: `0x01` = on, `0x00` = off

### 3.20 Quick Note (0x1E / 0x21)

| Field | Value |
|-------|-------|
| Command | `0x1E` or `0x21` |
| Target | Both arms |

**NoteAdd packet format:**
```
Byte 0: command (0x1E)
Byte 1: payload_length (low byte)
Byte 2: 0x03 (fixed)
Byte 3: versioning_byte
Byte 4-6: fixed_bytes
Byte 7: note_number
Byte 8: 0x03 (fixed)
Byte 9: name_length
Byte 10+: name_bytes (UTF-8)
Then: text_length byte
Then: 0x03 (fixed)
Then: text_bytes (UTF-8)
```

### 3.21 Button Configuration (0x08 / 0x26)

Remappable gesture functions:

| Gesture | Command | Payload | Function |
|---------|---------|---------|----------|
| Head up -> None | `0x08` | `0x06, 0x00, 0x00, 0x03, 0x02` | Disable |
| Head up -> Dashboard | `0x08` | `0x06, 0x00, 0x00, 0x03, 0x00` | Show dashboard |
| Double tap -> None | `0x26` | `0x06, 0x00, 0x0A, 0x05, 0x00` | Disable |
| Double tap -> Transcribe | `0x26` | `0x06, 0x00, 0x0B, 0x05, 0x05` | Start transcription |
| Double tap -> Teleprompter | `0x26` | `0x06, 0x00, 0x0C, 0x05, 0x03` | Open teleprompter |
| Double tap -> Translate | `0x26` | `0x06, 0x00, 0x0D, 0x05, 0x02` | Start translation |
| Double tap -> Dashboard | `0x26` | `0x06, 0x00, 0x11, 0x05, 0x04` | Show dashboard |

---

## 4. Getter Commands (Phone -> Glasses)

### 4.1 Get Firmware Info (0x23 0x74)

| Field | Value |
|-------|-------|
| Target | Both arms |

**Send:** `[0x23, 0x74]`
**Response:** 203 bytes of raw ASCII text
- Example: `"net build time: 2024-12-28 20:21:57, app build time 2024-12-28 20:20:45, ver 1.4.5, JBD DeviceID 4010"`

### 4.2 Get Brightness (0x29)

| Target | Right arm |
|--------|-----------|

**Send:** `[0x29]`
**Response:** `[0x29, 0x65, brightness, auto_enabled]`

### 4.3 Get Silent Mode (0x2B)

| Target | Both arms |
|--------|-----------|

**Send:** `[0x2B]`
**Response:** `[0x2B, 0x69, silent_flag, unknown]`
- `silent_flag`: `0x0C` = silent on, `0x0A` = silent off
- `unknown`: `0x06` or `0x08`

### 4.4 Get Battery State (0x2C 0x01)

| Target | Both arms |
|--------|-----------|

**Send:** `[0x2C, 0x01]`
**Response:** `[0x2C, 0x66, battery_percent, ...]`
- `battery_percent`: 0x00-0x64 (0-100%)
- Additional bytes contain charging state and flags

### 4.5 Get Head-Up Angle (0x32)

| Target | Right arm |
|--------|-----------|

**Send:** `[0x32]`
**Response:** `[0x32, 0xC9, angle_enabled, ...]`

### 4.6 Get Device Serial Number (0x34)

| Target | Both arms |
|--------|-----------|

**Send:** `[0x34]`
**Response:** Bytes 2-18 contain serial number as ASCII string.

### 4.7 Get Time Since Boot (0x37)

| Target | Both arms |
|--------|-----------|

**Send:** `[0x37]`
**Response:** `[0x37, 0x49, epoch_b3, epoch_b2, epoch_b1, epoch_b0, ...]`
- 32-bit epoch in seconds

### 4.8 Get Wear Detection (0x3A)

| Target | Both arms |
|--------|-----------|

**Send:** `[0x3A]`
**Response:** `[0x3A, 0xC9, enabled]`

### 4.9 Get Display Settings (0x3B)

| Target | Right arm |
|--------|-----------|

**Send:** `[0x3B]`
**Response:** `[0x3B, 0xC9, height, depth]`

### 4.10 Get Buried Point / Usage Data (0x3E)

| Target | Both arms |
|--------|-----------|

**Send:** `[0x3E]`
**Response:** `[0x3E, 0xC9, ...197_bytes_of_usage_data...]`

### 4.11 Incomplete / TODO Getters

| Command | Name |
|---------|------|
| `0x2A` | Get Anti-Shake Settings |
| `0x2C 0x02` | Get Firmware/Software Info |
| `0x2D` | Get MAC Address |
| `0x2E` | Get App Whitelist |
| `0x33` | Get Glasses Serial Number |
| `0x35` | Get ESB Channel Info |
| `0x36` | Get ESB Notification Count |

---

## 5. Incoming Events (Glasses -> Phone)

### 5.1 Audio Stream (0xF1)

| Field | Value |
|-------|-------|
| Command | `0xF1` |
| Direction | Glasses -> Phone |
| Packet size | 202 bytes total |

**Packet format:**
```
Byte 0: 0xF1        — command
Byte 1: seq          — sequence number (0x00-0xFF)
Byte 2-201: data     — LC3 encoded audio frame (200 bytes)
```

Audio extraction from Android code: bytes 2-201 (200 bytes) are extracted and passed to LC3 decoder.

### 5.2 TouchBar / State Events (0xF5)

All events: `[0xF5, subcommand, payload...]`

| Subcommand | Event | Payload |
|------------|-------|---------|
| `0x00` | Exit / Double tap (close) | Variable |
| `0x01` | Page forward / Head up gesture | Variable |
| `0x02` | Single tap | Variable |
| `0x03` | Head down gesture | Variable |
| `0x04` | Triple tap | Variable |
| `0x05` | Triple tap (alternate) | Variable |
| `0x06` | Glasses worn (put on) | None |
| `0x07` | Glasses removed (taken off) | Variable |
| `0x08` | Case lid opened | None |
| `0x09` | Charging status changed | `0x00` or `0x01` |
| `0x0A` | Reserved | Variable |
| `0x0B` | Case lid closed | Variable |
| `0x0E` | Case charging state | `0x00` or `0x01` |
| `0x0F` | Case battery level | `0x00`-`0x64` (percentage) |
| `0x11` | BLE pairing success | Variable |
| `0x12` | Reserved | Variable |
| `0x17` | **Long press (Even AI start)** | Variable |
| `0x18` | Press and release (Even AI stop) | Variable |
| `0x1E` | Dashboard open (double tap) | Variable |
| `0x1F` | Dashboard close (double tap) | Variable |
| `0x20` | Double tap (translate/transcribe mode) | Variable |

---

## 6. Even AI Activation Flow

Complete sequence for voice interaction:

```
1. User long-presses left TouchBar
2. Glasses -> Phone: [0xF5, 0x17]           (Even AI start event)
3. Phone -> Glasses: [0x0E, 0x01]           (Enable microphone on right arm)
4. Glasses -> Phone: [0x0E, 0xC9, 0x01]    (Mic enabled successfully)
5. Glasses -> Phone: [0xF1, seq, data...]   (LC3 audio stream begins)
   ... continuous audio frames for up to 30 seconds ...
6. User releases TouchBar OR 30s timeout
7. Glasses -> Phone: [0xF5, 0x18]           (Recording stopped)
8. Phone -> Glasses: [0x0E, 0x00]           (Disable microphone)
9. Phone processes audio (STT + LLM)
10. Phone -> Glasses: [0x4E, ...]           (Send AI result text)
    - screen_status = 0x31 (AI displaying, new content) for first page
    - screen_status = 0x41 (AI complete) for final page
    - screen_status = 0x51 if user taps to enter manual mode
    - screen_status = 0x61 on network error
```

**Debounce:** Android requires 500ms debounce to prevent duplicate BLE commands on mic enable.

**Retry:** If mic enable fails while `isReceivingAudio` is true, retry after 1-second delay.

---

## 7. LC3 Audio Codec Specification

| Parameter | Value |
|-----------|-------|
| **Codec** | LC3 (Low Complexity Communication Codec) |
| **Sample Rate** | 16,000 Hz |
| **Frame Duration** | 10 ms (10,000 us) |
| **Encoded Frame Size** | 20 bytes |
| **Bitrate** | 16 kbps (derived: 20 bytes * 8 bits / 10ms) |
| **Channels** | 1 (mono) |
| **PCM Format** | S16 (signed 16-bit) |
| **Samples Per Frame** | `lc3_frame_samples(10000, 16000)` = 160 |
| **PCM Bytes Per Frame** | 320 (160 samples * 2 bytes) |

**Decoder initialization:**
```c
lc3_setup_decoder(10000, 16000, 0, decoder_memory);
// dtUs=10000, srHz=16000, srHz_pcm=0 (same as srHz), mem=allocated
```

**Decoding each frame:**
```c
lc3_decode(decoder, lc3_frame_20_bytes, 20, LC3_PCM_FORMAT_S16, pcm_output, 1);
```

**RNNoise:** The Android implementation also applies RNNoise for noise suppression post-decode.

The official demo app bundles a complete LC3 codec C library (34 files) including: attdet, bits, bwdet, energy, fastmath, lc3, ltpf, mdct, plc, rnnoise, sns, spec, tables, tns — with ARM NEON optimizations.

---

## 8. Dashboard Protocol (Reverse-Engineered — even-utils)

### 8.1 Dashboard Update Packet (0x06)

**Outer envelope:**
```
Byte 0: 0x06       — command
Byte 1-2: length   — little-endian uint16 (total remaining bytes)
Byte 3: sync_id    — request/response correlation ID
Byte 4+: payload   — subcommand-specific data
```

**Reply validation:** response must be >= 4 bytes, first byte = `0x06`, fourth byte matches sync_id.

### 8.2 News Update Data (inside 0x06 payload)

**News data wrapper (type 0x05):**
```
Byte 0: 0x05       — news update type
Byte 1-2: total_packets (uint16 LE)
Byte 3-4: current_packet_index (uint16 LE)
Byte 5+: payload
```

**News update fields (inside payload):**
```
Byte 0: display_mode       — 0=FULL, 1=DUAL, 2=MINIMAL
Byte 1: display_area_kind  — 0=QUICKNOTE, 1=STOCKS, 2=NEWS, 3=SCHEDULE, 4=CITYWALK
Byte 2: news_display_mode  — 0=LOADING, 1=NO_DATA_SELECTED, 2=SHOW_NEWS, 3=UNKNOWN, 4=SHOW_MORE_SOURCES
Byte 3: news_index         — 1-4 (validated, throws if out of range)
Byte 4: operation           — 0=UNKNOWN, 1=UPDATE, 2=DELETE
Byte 5+: news_data         — see below
```

**News data content:**
```
Byte 0: 0x01               — source marker
Byte 1: source_length      — max 64 bytes
Byte 2+: source_string     — UTF-8
Then:
Byte N: 0x02               — text marker
Byte N+1..N+2: text_length — uint16 LE, max 280 bytes
Byte N+3+: text_string     — UTF-8
```

### 8.3 Citywalk / Map Update Data (inside 0x06 payload)

**Citywalk data wrapper (type 0x07):**
```
Byte 0: 0x07               — citywalk update type
Byte 1-2: total_packets (uint16 LE)
Byte 3-4: current_packet_index (uint16 LE)
Byte 5+: payload
```

**Citywalk map update fields:**
```
Byte 0: display_mode        — 0=FULL, 1=DUAL, 2=MINIMAL
Byte 1: display_area_kind   — 4=CITYWALK
Byte 2: citywalk_display_mode — 0=LOADING, 1=REDUCE_MOVEMENT, 2=UPDATING_MAP, 3=SHOW_MAP
Byte 3: 0x01                — fixed padding
Byte 4+: raw map data       — bitmap bytes
```

**Citywalk cursor update fields:**
```
Byte 0: display_mode
Byte 1: display_area_kind
Byte 2: citywalk_display_mode
Byte 3-4: cursor_x (int16 LE)
Byte 5-6: cursor_y (int16 LE)
Byte 7+: cursor_bitmap_data
```

**Chunk size:** 180 bytes per packet for map data.

---

## 9. Additional Undocumented / Partially Documented Commands

| Command | Name | Notes |
|---------|------|-------|
| `0x09` | Set Teleprompter Text | TODO in protocol doc |
| `0x0A` | Set Navigation Info | TODO |
| `0x10` | Calibration/Reset | Format: `[0x10, len, 0x00, id, params...]` |
| `0x38` | Apple Notification Service | TODO |
| `0x39` | Display Toggle | Format: `[0x39, 0x05, 0x00, param_lo, param_hi, 0x01]` |
| `0x3C` | Get/Set Message Mode | TODO |
| `0x3D` | Get/Set Language Settings | Partial: `[0x3D, 0x06, 0x00, 0x14, 0x01, 0x02]` |
| `0x58` | Set Calendar Event | TODO |

---

## 10. Command Quick-Reference Table

| Cmd | Name | Dir | Target | Response |
|-----|------|-----|--------|----------|
| `0x01` | Set Brightness | P->G | R | Generic |
| `0x03` | Set Silent Mode | P->G | Both | Generic |
| `0x04` | Set Notification Settings | P->G | L | Generic |
| `0x06` | Dashboard Settings | P->G | Both | Generic |
| `0x08` | Button Config | P->G | Both | Generic |
| `0x0B` | Set Head-Up Angle | P->G | R | `0x0B C9/CA` |
| `0x0E` | Microphone Control | P->G | Both | `0x0E status enable` |
| `0x10` | Calibration | P->G | Both | `0x10 06 00 id params C9` |
| `0x15` | Send BMP Data | P->G | Both | None (use 0x20) |
| `0x16` | Send CRC Check | P->G | Both | `... C9` at byte 5 |
| `0x18` | Clear Screen | P->G | Both | Generic |
| `0x1E` | Quick Note | P->G | Both | Generic |
| `0x20` | Packet End | P->G | Both | Generic |
| `0x22` | Sequence Sync | P->G | R | Echo |
| `0x23 0x72` | Hard Reset | P->G | Both | None |
| `0x23 0x74` | Get Firmware Info | P->G | Both | ASCII text |
| `0x25` | Heartbeat | P->G | Both | None |
| `0x26` | Display Settings | P->G | Both | `0x26 06 00 seq 02 status` |
| `0x27` | Set Wear Detection | P->G | Both | Generic |
| `0x29` | Get Brightness | P->G | R | `0x29 0x65 bright auto` |
| `0x2B` | Get Silent Mode | P->G | Both | `0x2B 0x69 flag unk` |
| `0x2C 0x01` | Get Battery | P->G | Both | `0x2C 0x66 pct ...` |
| `0x32` | Get Head-Up Angle | P->G | R | `0x32 C9 enabled` |
| `0x34` | Get Serial Number | P->G | Both | ASCII bytes 2-18 |
| `0x37` | Get Boot Time | P->G | Both | `0x37 0x49 epoch32` |
| `0x3A` | Get Wear Detection | P->G | Both | `0x3A C9 enabled` |
| `0x3B` | Get Display Settings | P->G | R | `0x3B C9 height depth` |
| `0x3E` | Get Usage Data | P->G | Both | `0x3E C9 197bytes` |
| `0x4B` | Send Notification | P->G | L | Generic |
| `0x4C` | Clear Notification | P->G | L | Generic |
| `0x4D` | Init | P->G | L | Generic |
| `0x4E` | Send Text/AI Result | P->G | Both | None |
| `0x50` | Dashboard Lock | P->G | R | Echo |
| `0xF1` | Audio Stream | G->P | Both | N/A |
| `0xF4` | Debug Mode | P->G | Both | None |
| `0xF5` | TouchBar/State Events | G->P | Both | N/A |

**Legend:** P->G = Phone to Glasses, G->P = Glasses to Phone, L = Left arm, R = Right arm

---

## 11. Firmware

- **Latest known version:** v1.5.6
- **Download:** `https://cdn.evenreal.co/firmware/3adb8ebbd35c2343409d6d0c9fe6cbb9.zip`
- **OTA procedure:** Not publicly documented

---

## 12. Implementation Notes

### Timeouts
| Operation | Timeout |
|-----------|---------|
| AI data send | 2000ms |
| Heartbeat/exit | 1500ms |
| BMP termination (0x20) | 3000ms |
| Generic commands | 300-1000ms |
| Default BLE response | 1000ms |

### Retry Logic
- BMP termination: up to 10 retries
- Text display: up to 5 retries
- Generic requests: 3 retries with 100ms between attempts
- Mic enable: recursive retry with 1s delay if still receiving audio

### Packet Splitting
- Text (0x4E): chunks of 191 bytes (MTU - 9 byte header)
- Notifications (0x4B): chunks of 176 bytes (180 - 4 byte header)
- BMP (0x15): chunks of 194 bytes
- Dashboard (0x06): chunks of 180 bytes
- General: 17-byte chunks for basic commands (20 - 3 byte header)

### Display Specifications
| Parameter | Value |
|-----------|-------|
| Display width | 488 pixels (Even AI mode) |
| Display resolution (BMP) | 576 x 136 pixels |
| BMP bit depth | 1-bit (monochrome) |
| Default font size | 21 |
| Lines per screen | 5 |
| Custom font | `even.ttf` (bundled in even-utils) |
