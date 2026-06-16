---
name: pipeline-knowledge
description: |
  Knowledge about the operant-pi voice pipeline -- FSM states, transitions,
  phases, artifact sequence, human gates, and how the autonomous development
  loop works. Use when Claude needs to understand pipeline behavior, interpret
  pipeline state, route decisions based on FSM state, or debug pipeline issues.
---

# Operant-Pi Pipeline Knowledge

Knowledge base for the voice-driven autonomous development pipeline. Users call a phone number, describe a feature, and the system autonomously specs it (4 SDLC phases with review callbacks), builds it (3-agent dev), audits it, and confirms with the user.

## FSM States (14)

| State | Description |
|-------|-------------|
| `idle` | No active work. Pipeline waiting for inbound call. |
| `call_active` | Inbound call in progress. Retell is transcribing. |
| `triage` | Call ended. Transcript is being classified (requirements vs confirmation vs unknown). |
| `sdlc_intent` | Writing the intent-and-constraints document. |
| `sdlc_review` | Artifact written, waiting for user review (approve/reject via call or WhatsApp). |
| `sdlc_hld` | Writing the high-level-design document. |
| `sdlc_adr` | Writing the ADR-lite document. |
| `sdlc_eis` | Writing the executable implementation spec. |
| `dev` | Development phase active. Code being implemented from approved spec. |
| `dev_blocked` | Blocker encountered during dev. Escalation call to user in progress. |
| `audit` | Audit phase active. Implementation being verified against spec. |
| `confirmation` | All phases complete. Confirmation call to user in progress. |
| `demo_calling` | Demo call being placed (for investor presentations). |
| `complete` | Feature shipped. Pipeline returns to idle after cleanup. |

## Phases (7)

Each phase groups related FSM states:

| Phase | States | Description |
|-------|--------|-------------|
| **idle** | `idle` | Waiting for work |
| **triage** | `call_active`, `triage` | Inbound call processing |
| **sdlc** | `sdlc_intent`, `sdlc_review`, `sdlc_hld`, `sdlc_adr`, `sdlc_eis` | Specification production with review gates |
| **dev** | `dev`, `dev_blocked` | Code implementation |
| **audit** | `audit` | Implementation verification |
| **demo** | `demo_calling` | Investor demo mode |
| **confirmation** | `confirmation`, `complete` | User confirmation and cleanup |

## Artifact Sequence

The SDLC phase produces 4 artifacts in strict order. Each artifact triggers a review gate before the next can begin.

| # | Artifact | File | Trigger State | After Review |
|---|----------|------|---------------|--------------|
| 1 | Intent and Constraints | `intent-and-constraints.md` | `sdlc_intent` | -> `sdlc_review` -> `sdlc_hld` |
| 2 | High-Level Design | `high-level-design.md` | `sdlc_hld` | -> `sdlc_review` -> `sdlc_adr` |
| 3 | ADR-Lite | `adr-lite.md` | `sdlc_adr` | -> `sdlc_review` -> `sdlc_eis` |
| 4 | Implementation Spec | `implementation-spec.md` | `sdlc_eis` | -> `sdlc_review` -> `dev` |

## Human Gates

Human gates are points where the pipeline pauses for user input. Communication happens via Retell voice calls or Twilio WhatsApp messages, routed by the channel router based on complexity.

| Gate | Trigger | Channel | User Action |
|------|---------|---------|-------------|
| **Artifact review** | After each SDLC artifact is written | WhatsApp (simple) or Voice (complex) | Approve or request changes |
| **Blocker escalation** | Blocker file written during dev | Voice (always) | Provide resolution guidance |
| **Audit confirmation** | All FRs pass audit | WhatsApp or Voice | Confirm feature is complete |

### Channel Routing

- **Simple gates** (artifact reviews with no open questions): WhatsApp message with PDF attachment
- **Complex gates** (blockers, rejections, first-time reviews): Retell voice call
- **Timeout escalation**: If WhatsApp gets no response within N minutes, escalate to voice call

## FSM Transitions

Key transitions and what triggers them:

| Event | From | To | Trigger |
|-------|------|----|---------|
| `CALL_STARTED` | `idle` | `call_active` | Retell webhook: call started |
| `CALL_ENDED` | `call_active` | `triage` | Retell webhook: call ended |
| `REQUIREMENTS_CLASSIFIED` | `triage` | `sdlc_intent` | Transcript classified as requirements |
| `ARTIFACT_PRODUCED` | `sdlc_*` | `sdlc_review` | PostToolUse hook detects artifact write |
| `REVIEW_APPROVED` | `sdlc_review` | next `sdlc_*` or `dev` | Webhook: user approved via call/WhatsApp |
| `REVIEW_REJECTED` | `sdlc_review` | previous `sdlc_*` | Webhook: user requested changes |
| `BLOCKER_DETECTED` | `dev` | `dev_blocked` | PostToolUse hook detects blocker file |
| `BLOCKER_RESOLVED` | `dev_blocked` | `dev` | Webhook: user provided resolution |
| `DEV_COMPLETE` | `dev` | `audit` | Stop hook: no new blockers, all FRs done |
| `AUDIT_PASSED` | `audit` | `confirmation` | Stop hook: no revision files written |
| `AUDIT_FAILED` | `audit` | `dev` | PostToolUse hook: revision file written |
| `CONFIRMED` | `confirmation` | `complete` | Webhook: user confirmed completion |

## Hook-to-FSM Mapping

How Claude Code hooks drive the pipeline:

| Hook | What It Does |
|------|-------------|
| **SessionStart** | Infer FSM state from filesystem, clean stale PIDs, output pipeline context |
| **SessionEnd** | Kill server + tunnel, clean PIDs |
| **PostToolUse (Write/Edit)** | Detect artifact writes, blocker files, revision files -> advance FSM |
| **PostToolUse (Bash)** | Scan output for blocker patterns (permission denied, build failed, etc.) |
| **UserPromptSubmit** | Inject pipeline context (phase, state, active spec, blocker/revision counts) |
| **Stop** | Detect state drift, check for phase completion (dev complete, audit passed) |
| **SubagentStop** | Detect agent completion, inspect filesystem for new artifacts |
| **PreCompact** | Preserve pipeline state across context compaction |
| **PreToolUse (Write/Edit)** | Block spec writes during review state |

## Directory Structure

```
spec/
  <feature-name>/
    REQUIREMENTS.md              # From call transcript
    intent-and-constraints.md    # SDLC artifact 1
    high-level-design.md         # SDLC artifact 2
    adr-lite.md                  # SDLC artifact 3
    implementation-spec.md       # SDLC artifact 4
    blockers/                    # Dev blocker files
    revisions/                   # Audit revision files
  .operant/
    current-state.txt            # FSM state
    active-spec.txt              # Active feature name
    server.pid                   # Webhook server PID
    tunnel.pid                   # Cloudflare tunnel PID
    tunnel_url.txt               # Current tunnel URL
    calls/                       # Raw call data
    pending/                     # Unprocessed trigger files
    processed/                   # Processed trigger files
```

## Agent Mapping

| Pipeline Phase | Agent | Purpose |
|---------------|-------|---------|
| sdlc_intent / sdlc_hld / sdlc_adr / sdlc_eis | `sdlc-writer` | Produce the next SDLC artifact |
| dev / dev_blocked | `dev-builder` | Implement code from approved spec |
| audit | `auditor` | Verify implementation against spec |
