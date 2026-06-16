# G1 Open-Source Libraries & Companion Apps Survey

**Date:** 2026-06-06

---

## Tier 1: Best for Building On (Python / Desktop)

### even_glasses (Python) -- RECOMMENDED BASE
- **Repo:** https://github.com/emingenc/even_glasses
- **PyPI:** `pip install even-glasses`
- **Language:** Python, uses `bleak` for BLE
- **Stars:** 79 | **License:** GPL-3.0 | **Last updated:** Nov 2024
- **Features:** Device scanning, dual BLE connection, heartbeat, text display (with RSVP), notifications, status monitoring
- **Runs on:** macOS, Linux, Windows (anywhere bleak runs)
- **Mic/Audio:** NOT supported -- display only
- **Verdict:** Best Python foundation. Handles the hardest parts (dual BLE, protocol, heartbeat). Needs mic support added.

### G1 Voice AI Assistant (Python)
- **Repo:** https://github.com/emingenc/G1_voice_ai_assistant
- **Stars:** 25 | **Last updated:** Nov 2024
- **Features:** Real-time AI conversation, emotional TTS, G1 display, multi-LLM support
- **Built on:** `even_glasses` library
- **Verdict:** Good reference for voice AI pipeline on top of `even_glasses`. Heavy deps (Docker/Redis/LangGraph).

---

## Tier 2: Mobile Companion Apps

### Even Realities EvenDemoApp (Flutter) -- CANONICAL REFERENCE
- **Repo:** https://github.com/even-realities/EvenDemoApp
- **Stars:** 467 | **Language:** Dart/Flutter
- **Features:** Even AI (mic), image transmission, text display, TouchBar gestures
- **Mic/Audio:** YES -- full LC3 stream, 30s limit documented
- **Verdict:** THE authoritative protocol reference. Not usable directly but essential for implementation details.

### AGiXT Mobile (Flutter)
- **Repo:** https://github.com/AGiXT/mobile
- **Stars:** 9 | **395 commits**
- **Features:** G1 pairing, wake word (Vosk), multi-lang STT, streaming TTS, Wear OS companion
- **Key asset:** `Even Realities G1 BLE Protocol.txt` -- most complete protocol doc
- **Verdict:** Heavy app but the BLE Protocol.txt alone is invaluable.

### g1-basis-android (Kotlin)
- **Repo:** https://github.com/rodrigofalvarez/g1-basis-android
- **Stars:** 18 | Published on Maven Central
- **Features:** Connection mgmt, text display, battery monitoring, multi-app shared access
- **Verdict:** Best Android-native library. Clean architecture but Kotlin only.

---

## Tier 3: Reference / Niche

### OpenClaw Glasses (TypeScript)
- **Repo:** https://github.com/littlebotshi/openclaw-glasses
- **Stars:** 30 | **License:** MIT
- **Features:** Voice AI assistant, wake word
- **Caveat:** Delegates BLE to MentraOS, doesn't handle it directly
- **Verdict:** Good TS architecture reference, but depends on MentraOS.

### Gadgetbridge (Java/Android)
- **Info:** https://gadgetbridge.org/gadgets/others/even_realities/
- **Status:** Partial support (pairing, notifications, battery, weather, brightness -- no mic/AI)
- **Verdict:** Battle-tested BLE connection handling reference. Java only.

### EvenComfort (Python)
- **Repo:** https://github.com/hqrrr/EvenComfort
- **Features:** IoT sensor data -> G1 display
- **Verdict:** Simple example of pushing data to G1 via `even_glasses`.

### even-utils (Java)
- **Repo:** https://github.com/radioegor146/even-utils
- **Features:** Custom dashboard map/news
- **Verdict:** Documents some undocumented protocol features.

---

## Key Finding

No Node.js/TypeScript library exists for direct G1 BLE. Python with `bleak` + `even_glasses` is the only viable desktop path without building from scratch.
