# BLE Stack Options for G1 on macOS

**Date:** 2026-06-06

---

## Decision: Python + bleak

Python with `bleak` is the recommended BLE stack for connecting to the G1 from macOS. Node.js BLE libraries have significant risks for the dual-connection requirement.

---

## Option Comparison

| Factor | Python `bleak` | Node.js `@stoprocent/noble` | Web Bluetooth | Electron + noble |
|--------|---------------|---------------------------|---------------|-----------------|
| macOS support | Native CoreBluetooth | Native CoreBluetooth bindings | Chrome only | Same as noble |
| Dual connections | Proven (`asyncio.gather`) | Known bug (#178) | Requires user gesture per connection | Same noble risks |
| G1 library exists | Yes (`even_glasses`) | No | No | No |
| Maintenance | Active (v3.0.1, Mar 2026) | Active but fragmented | Browser-managed | Heavy |
| Our stack fit | Subprocess bridge needed | Native TS | Browser context only | Electron overhead |

---

## Python + bleak (Recommended)

- Uses CoreBluetooth natively on macOS
- Full asyncio API
- Multiple simultaneous `BleakClient` connections -- each device separate, no mutexes
- `asyncio.gather()` for parallel dual-arm connection
- Caveat: macOS requires main thread for CoreBluetooth
- Caveat: macOS uses UUIDs not MAC addresses for discovery

### even_glasses library
- Uses bleak under the hood
- `GlassesProtocol` class with `scan_and_connect(timeout=10)`
- Handles dual-arm connection automatically
- License: GPL-3.0 (may need to fork under different license or use as reference)

### Bridge to Node.js
```
Python process (child_process.spawn)
  <- JSON-lines over stdin/stdout or Unix socket
  -> Node.js receives high-level events
```

---

## Node.js @stoprocent/noble (Backup)

- Most actively maintained noble fork
- `withBindings('mac')` for explicit CoreBluetooth
- TypeScript definitions included
- `connectAsync()`, `waitForPoweredOnAsync()` APIs
- Direct connect without scan: `connect(peripheralAddress)`

### NUS (Nordic UART) in noble
```typescript
const UART_SERVICE = '6e400001b5a3f393e0a9e50e24dcca9e';
const TX_CHAR = '6e400002b5a3f393e0a9e50e24dcca9e';
const RX_CHAR = '6e400003b5a3f393e0a9e50e24dcca9e';

await peripheral.connectAsync();
const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
  [UART_SERVICE], [TX_CHAR, RX_CHAR]
);
await rx.subscribeAsync();
rx.on('data', (data) => { /* handle */ });
await tx.writeAsync(Buffer.from([0x4D, 0x01]), false);
```

### Risk: Dual Connection Bug
GitHub noble/noble#178 -- communication only possible with last connected device. May be fixed in @stoprocent fork but not confirmed for macOS.

---

## macOS BLE Permissions

- Terminal emulator must have Bluetooth permission in System Preferences > Privacy & Security > Bluetooth
- BLE library inherits permissions from the terminal process
- No entitlement file needed for CLI apps
- macOS Sequoia: reported Electron BLE issues, CLI noble should work

---

## Sources

- https://github.com/stoprocent/noble
- https://www.npmjs.com/package/@stoprocent/noble
- https://github.com/hbldh/bleak
- https://bleak.readthedocs.io/
- https://pypi.org/project/even-glasses/
- https://github.com/noble/noble/issues/178
- https://github.com/danielgjackson/ble-uart
