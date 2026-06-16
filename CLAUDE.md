# Operant — Voice-Driven Development Pipeline

## Quick orientation

- **`TECH.md`** — All infrastructure accounts, credentials locations, Supabase schema, stack decisions, and provisioning checklist. Read this first when you need to interact with any external service.
- **`PRIMER.md`** — Dry-run walkthrough of the plugin (FSM states, CLI commands, hook chain, env vars, sample trigger). Consult before attempting to develop any functionality within the plugin.
- **`TESTING.md`** — Three-layer test strategy (deterministic unit/hook/integration, Agent SDK canary, LLM-as-judge eval). Read before writing or running tests.

## Repo topology

- **`esxr/operant`** (this) — Claude Code plugin (FSM, hooks, agents, commands). Runs on user's machine.
- **`esxr/operant-api`** — hosted Express server on Railway (webhook receiver, trigger queue, Retell/Twilio proxy, Stripe billing). Dumb proxy, no pipeline logic.
- **`esxr/operantlabs.com`** — Next.js dashboard + landing on Vercel (signup, API key, usage, billing portal).
- **Mode:** `OPERANT_API_KEY` set → cloud (proxy through server); unset → local (direct Retell/Twilio + tunnel).
- **Design docs:** `docs/specs/04-saas-productization/` (intent, HLD, ADR, impl-spec).
- **Full topology details:** see `PRIMER.md` § "Repo topology".

## Plugin structure

- `lib/` — compiled JS modules (state-machine, config, retell, channel, whatsapp, CLI scripts)
- `hooks/hooks.json` — all hook definitions (detect-artifact, inject-context, pre-write-guard, etc.)
- `scripts/` — shell scripts backing the hooks
- `agents/` — sdlc-writer, dev-builder, auditor
- `commands/` — /process, /status, /whitelist, /start, /stop

## Bug protocol

Bugs are tracked on `esxr/operant-api` (covers API server, dashboard, infra, and plugin-related issues).

When encountering a bug (recurring problem):
- **Check first:** `gh issue list --repo esxr/operant-api --label bug` — scan for similar symptoms/root causes before debugging from scratch
- **Log if unique:** `gh issue create --repo esxr/operant-api --label bug` with: **Symptom**, **Root cause**, **Fix**, **Files**, **Repo@commit**

---
