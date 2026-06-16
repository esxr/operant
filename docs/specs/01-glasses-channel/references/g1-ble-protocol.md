# Even Realities G1 BLE Protocol Reference

**Source:** Synthesized from EvenDemoApp, AGiXT BLE Protocol.txt, even-utils, Gadgetbridge  
**Date:** 2026-06-06

---

## 1. Connection Architecture

### Dual-BLE Design
Two independent BLE radios -- one per arm (left and right). Each is a separate BLE peripheral using Nordic UART Service (NUS).

### BLE Service & Characteristic UUIDs
```
UART Service:      6E400001-B5A3-F393-E0A9-E50E24DCCA9E
TX Characteristic:  6E400002-B5A3-F393-E0A9-E50E24DCCA9E  (Write -- app to glasses)
RX Characteristic:  6E400003-B5A3-F393-E0A9-E50E24DCCA9E  (Notify -- glasses to app)
```

### Device Discovery
- Scan for BLE peripherals with names containing `"Even G1"`
- Left arm: name contains `_L_`, right arm: `_R_`
- Pair by matching the channel number (second component split by `_`)
- Example: `Even G1_L_1234` and `Even G1_R_1234`

### Init Sequence
1. Connect to both arms
2. Enable notifications on RX characteristic for each
3. Send `[0x4D, 0x01]` to both L and R immediately
4. Send `[0xF4, 0x01]` to both
5. Request MTU 251
6. Start heartbeat timer

### Write Protocol
- Send to **left** arm first, wait for ACK (`0xC9`), then send to **right**
- Exception: BMP images can be sent to both simultaneously
- Inter-packet delay: 5ms (Android) / 8ms (iOS)

### Generic Response Format
```
Byte 0: [Command ID]   (echoes the command)
Byte 1: [Status]
  0xC9 = Success
  0xCA = Failure
  0xCB = Continue
```

---

## 2. Complete Command Table

### Control Commands (App -> Glasses)

| Cmd | Name | Arm | Parameters | Response |
|-----|------|-----|------------|----------|
| `0x0E` | Mic Control | Right | `0x01`=enable, `0x00`=disable | `[0x0E, status, enable]` |
| `0x15` | Send BMP Packet | Both | `[0x15, seq, data...]` first pkt has 4-byte addr header | Fire-and-forget |
| `0x16` | BMP CRC Check | Both | `[0x16, crc3, crc2, crc1, crc0]` (CRC32-XZ, big-endian) | Check `response[5]` |
| `0x18` | Clear Screen | Both (L then R) | `[0x18]` | Generic |
| `0x20` | BMP End | Both | `[0x20, 0x0D, 0x0E]` | Generic |
| `0x25` | Heartbeat | Both (L then R) | `[0x25, 0x06, 0x00, hb_seq, 0x04, hb_seq]` | Validate `response[4]==0x04` |
| `0x4B` | Notification | Left | `[0x4B, msgId, chunkCount, seq, json...]` max 176 bytes/chunk | Generic |
| `0x4D` | Init Handshake | Both | `[0x4D, 0x01]` | Generic |
| `0x4E` | Send Text | Both (L then R) | See Text Protocol below | Generic |

### Getter Commands

| Cmd | Name | Arm | Response |
|-----|------|-----|----------|
| `0x23 0x74` | Firmware Info | Either | ASCII string with version |
| `0x29` | Brightness | Right | `[0x29, 0x65, brightness(0-0x2A), auto(0/1)]` |
| `0x2C 0x01` | Battery | Either | L: charging/case info; R: battery % + voltage |
| `0x3A` | Wear Detection | Either | `[0x3A, 0xC9, enabled(0/1)]` |
| `0x3B` | Display Settings | Right | `[0x3B, 0xC9, height(0-8), depth(1-9)]` |

### Setter Commands

| Cmd | Name | Arm | Format |
|-----|------|-----|--------|
| `0x01` | Brightness | Right | `[0x01, val(0-0x2A), auto(0/1)]` |
| `0x03` | Silent Mode | Both | `[0x03, 0x0C]`=on, `[0x03, 0x0A]`=off |
| `0x06` | Dashboard | Both | See Dashboard section |
| `0x0B` | Head-Up Angle | Right | `[0x0B, angle(0-0x3C), level]` |
| `0x26` | Display Settings | Both | `[0x26, 0x08, 0x00, seq, 0x02, preview, height, depth]` |
| `0x27` | Wear Detection | Both | Enable/disable |

### Glasses -> App Events

| Cmd | Name | Source | Format |
|-----|------|--------|--------|
| `0xF1` | Audio Data | Right | `[0xF1, seq(0-255), lc3_data...]` |
| `0xF5` | TouchBar/State | Either | `[0xF5, subcmd, ...]` |

---

## 3. TouchBar Events (0xF5)

| Subcmd | Name | Description |
|--------|------|-------------|
| `0x00` | Double Tap | Exit feature, return to dashboard |
| `0x01` | Single Tap | Page forward (R arm) / page back (L arm) |
| `0x04` | Triple Tap On | Toggle silent mode on |
| `0x05` | Triple Tap Off | Toggle silent mode off |
| `0x17` | AI Start | Long-press left TouchBar -- start Even AI |
| `0x18` | AI Record Over | Recording ended (release or 30s timeout) |

Additional 0xF5 state events: head position, wear status, charging, battery changes, case lid.

---

## 4. Heartbeat (0x25)

**Must send every 8-30 seconds. Disconnect at 32 seconds of silence.**

```
[0x25, 0x06, 0x00, hb_seq & 0xFF, 0x04, hb_seq & 0xFF]
```

Heartbeat sequence is independent from other packet sequences.

---

## 5. Microphone & Audio

### Activation Flow
1. Glasses -> App: `[0xF5, 0x17]` (user long-presses left TouchBar)
2. App -> Glasses: `[0x0E, 0x01]` to **right arm**
3. Glasses -> App: `[0x0E, 0xC9, 0x01]` (success)
4. Audio streams via `0xF1` packets from right arm
5. On release or 30s timeout: `[0xF5, 0x18]`
6. App -> Glasses: `[0x0E, 0x00]` (disable)

### Audio Format
```
LC3 codec, 16kHz, mono, 10ms frames
Encoded frame: 20 bytes
Decoded frame: 320 bytes (160 S16 PCM samples)
BLE packet (0xF1): 200 bytes LC3 = 10 frames = 100ms audio
Max recording: 30 seconds per activation
```

### 30-Second Chaining
Re-send `[0x0E, 0x01]` after receiving `[0xF5, 0x18]` with 500ms delay. Gap: ~500-700ms, handled by STT systems naturally.

---

## 6. Text Display (0x4E)

### Packet Structure
```
Byte 0: 0x4E
Byte 1: syncSeq (increments per screen)
Byte 2: totalPackageNum
Byte 3: currentPackageNum (0-based)
Byte 4: newScreen (status byte)
Byte 5-6: new_char_pos (big-endian)
Byte 7: currentPageNum (1-based)
Byte 8: maxPageNum (1-based)
Byte 9+: UTF-8 text (max 191 bytes per packet)
```

### newScreen Byte
| Value | Meaning |
|-------|---------|
| `0x31` | New content + AI displaying (auto mode) |
| `0x41` | New content + AI complete (final page) |
| `0x51` | New content + manual mode |
| `0x61` | New content + network error |
| `0x71` | New content + text show mode (non-AI) |

### Display Constraints
- Width: 488 pixels
- Font: 21pt
- Lines per screen: 5
- Vertical centering: prepend `\n\n` for <4 lines, `\n` for 4 lines

---

## 7. Image Display (0x15)

- 1-bit BMP, 576x136 pixels
- 194 bytes per chunk
- First packet: `[0x15, seq, 0x00, 0x1C, 0x00, 0x00, data...]`
- End: `[0x20, 0x0D, 0x0E]`, then CRC check via `0x16`
- CRC: CRC32-XZ over `[0x00, 0x1C, 0x00, 0x00] + bmp_data`

---

## 8. Notification (0x4B)

Left arm only. Max 176 bytes per JSON chunk.

```json
{
  "ncs_notification": {
    "msg_id": 1234567890,
    "app_identifier": "com.even.test",
    "title": "Title",
    "subtitle": "Subtitle",
    "message": "Body text",
    "display_name": "App Name"
  }
}
```

---

## 9. Dashboard (0x06)

Subcommand `0x01`: Set time + weather. Subcommand `0x06`: Set dashboard mode (Full/Dual/Minimal).

---

## Sources

- https://github.com/even-realities/EvenDemoApp
- https://github.com/AGiXT/mobile/blob/main/Even%20Realities%20G1%20BLE%20Protocol.txt
- https://github.com/radioegor146/even-utils
- https://gadgetbridge.org/gadgets/others/even_realities/
