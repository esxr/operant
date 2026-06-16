# Operant — Voice-Driven Development Pipeline

## Quick orientation

- **`TECH.md`** — All infrastructure accounts, credentials locations, Supabase schema, stack decisions, and provisioning checklist. Read this first when you need to interact with any external service.
- **`PRIMER.md`** — Dry-run walkthrough of the plugin (FSM states, CLI commands, hook chain, env vars, sample trigger). Consult before attempting to develop any functionality within the plugin.

## Plugin structure

- `lib/` — compiled JS modules (state-machine, config, retell, channel, whatsapp, CLI scripts)
- `hooks/hooks.json` — all hook definitions (detect-artifact, inject-context, pre-write-guard, etc.)
- `scripts/` — shell scripts backing the hooks
- `agents/` — sdlc-writer, dev-builder, auditor
- `commands/` — /process, /status, /whitelist, /start, /stop

---
