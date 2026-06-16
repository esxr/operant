# Operant

Voice-driven autonomous development pipeline for Claude Code. Phone calls become shipped features.

## What it does

Operant turns a phone call into a complete development cycle. You describe what you want built, and Operant drives it through spec writing, implementation, automated auditing, and a live demo -- all inside Claude Code.

**Pipeline stages:** Call -> Triage -> Spec (Intent, HLD, ADR, Implementation) -> Build -> Audit -> Demo -> Confirmation

Each stage has human gates: you review and approve before the pipeline advances.

## Install

```bash
# Add the operant marketplace (one-time)
claude plugin marketplace add esxr/operant

# Install the plugin
claude plugin install operant
```

## Quick start

### Free mode (mock voice, no API keys needed)

1. Install the plugin (see above)
2. Restart Claude Code
3. Run `/process` with a trigger file, or use `/start` and `/stop` to manage the voice server

The plugin runs in mock mode by default -- it simulates voice calls locally so you can try the full pipeline without any external accounts.

### Paid mode (real voice calls via Retell.ai)

1. Sign up at [operantlabs.com](https://operantlabs.com)
2. Get your API key from the dashboard
3. Run `/activate <your-api-key>` in Claude Code
4. Run `/start` to spin up the voice pipeline

## Commands

| Command | Description |
|---------|-------------|
| `/process [trigger-file]` | Manually process a call trigger through the pipeline |
| `/status` | Show pipeline state, active spec, pending calls |
| `/start` | Start the voice pipeline (webhook server + tunnel + Retell registration) |
| `/stop` | Stop the voice pipeline |
| `/whitelist` | Manage caller whitelist (list, add, remove) |
| `/activate [api-key]` | Activate paid cloud mode |

## Agents

- **sdlc-writer** -- Produces spec artifacts (intent, HLD, ADR, implementation spec)
- **dev-builder** -- Implements features from the spec
- **auditor** -- Automated code audit with browser-based proof-of-working

## Requirements

- [Claude Code](https://claude.ai/claude-code) (requires Max plan, $100/mo from Anthropic)
- Node.js 18+

## License

Proprietary. Copyright Operant Labs.
