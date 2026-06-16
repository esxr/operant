# High-Level Design: SaaS Productization

**Version:** 1.0
**Date:** 2026-06-15
**Status:** Draft
**Input:** Intent & Constraints v1.0

## 1. Overview

Productize Operant as a freemium plugin with a hosted backend. The plugin is a single install (`claude plugin install operant`) that works in two modes:

- **Free/local mode** (no API key): Full pipeline with mock gates or user-provided Retell/Twilio credentials. Zero server dependency. This is today's plugin, unchanged.
- **Paid/cloud mode** (API key set): Plugin proxies all Retell/Twilio calls through our hosted API (`api.operantlabs.com`). We provide the phone number, WhatsApp, and webhook routing. No tunnel, no third-party accounts needed.

The mode is detected at startup by checking whether `OPERANT_API_KEY` is set in the environment. No feature flags, no license checks.

## 2. Goals and Non-Goals

### Goals

- Freemium model: free plugin, paid infrastructure
- Single `claude plugin install` for both tiers
- Stripe billing with auto-provisioning/teardown
- Multi-tenant webhook routing (per-user phone numbers, trigger queues)
- 90%+ of plugin code unchanged — only `retell.ts`, `whatsapp.ts`, `config.ts`, and `startup.sh` modified

### Non-Goals

- Web dashboard (v1 is CLI-only)
- Team/org features or multi-seat
- Custom voice agent per user
- Full SaaS (Managed Agents) — that's Phase 2
- Landing page CMS — static HTML on Hostinger is sufficient

## 3. System Architecture

### Component Diagram

```
FREE MODE (no API key):

  User's Phone ──► Retell (user's account) ──► Cloudflare Tunnel ──► Local Webhook Server
                                                                            │
  Claude Code + Operant Plugin ◄── reads pending/ ◄────────────────────────┘
    │ FSM, hooks, agents (unchanged)
    └── retell.ts / whatsapp.ts call Retell/Twilio directly (user's keys)


PAID MODE (OPERANT_API_KEY set):

  User's Phone ──► Retell (our account) ──► api.operantlabs.com ──► per-user trigger queue
                                                   ▲                         │
  Twilio WhatsApp ─────────────────────────────────┘                         │
                                                                             │
  Claude Code + Operant Plugin ◄── polls /api/triggers/poll ◄───────────────┘
    │ FSM, hooks, agents (unchanged)
    └── retell.ts / whatsapp.ts proxy through api.operantlabs.com (our keys)

                                            ┌───────────────────────────┐
                                            │   api.operantlabs.com     │
                                            │   (Railway, Express)      │
                                            │                           │
                                            │   /webhook/call-completed │
                                            │   /webhook/whatsapp       │
                                            │   /api/triggers/poll      │
                                            │   /api/calls/outbound     │
                                            │   /api/whatsapp/send      │
                                            │   /api/auth/verify        │
                                            │                           │
                                            │   Supabase Postgres       │
                                            │   (users, triggers, usage)│
                                            │                           │
                                            │   Stripe webhooks         │
                                            │   (provision/teardown)    │
                                            └───────────────────────────┘
```

## 4. Component Breakdown

### 4.1 operant-api (new, hosted)

A standalone Express server deployed to Railway. Single process, stateless (all state in Supabase).

**Modules:**

| Module | Responsibility |
|--------|---------------|
| `routes/webhooks.ts` | Retell + Twilio inbound webhook handlers. Parse payload, identify user by phone number, enqueue trigger. |
| `routes/api.ts` | Authenticated endpoints: trigger poll, outbound call proxy, WhatsApp proxy, auth verify, status. |
| `routes/stripe.ts` | Stripe webhook handlers: `customer.subscription.created`, `customer.subscription.deleted`, `invoice.payment_failed`. |
| `middleware/auth.ts` | API key validation. Looks up key in Supabase `users` table, attaches user to request. |
| `services/provisioner.ts` | On subscription: create user row, generate API key, allocate Retell phone number, configure webhook URL, send welcome email. On cancel: deactivate user, release phone number. |
| `services/retell-proxy.ts` | Proxies outbound call requests to Retell API using our master credentials. Injects user's allocated `from_number`. |
| `services/twilio-proxy.ts` | Proxies outbound WhatsApp messages to Twilio API using our master credentials. |
| `db.ts` | Supabase client. Tables: `users`, `triggers`, `usage`. |

**No business logic lives in this server.** It is a dumb proxy + queue. All pipeline intelligence remains in the plugin.

### 4.2 Plugin modifications (minimal)

| File | Change | Size |
|------|--------|------|
| `src/config.ts` | Add `OPERANT_API_KEY`, `OPERANT_API_URL`, `getMode()` helper (returns `"cloud"` or `"local"`) | ~15 lines |
| `src/retell.ts` | `makeOutboundCall()`: if cloud mode, POST to `$API_URL/api/calls/outbound` instead of Retell directly. Else, existing behavior. | ~20 lines changed |
| `src/whatsapp.ts` | `sendTwilioMessage()`: if cloud mode, POST to `$API_URL/api/whatsapp/send`. Else, existing behavior. | ~15 lines changed |
| `scripts/startup.sh` | Add mode detection block: if `OPERANT_API_KEY` set, verify with server, skip tunnel/local-server. Else, existing flow. | ~15 lines added |
| `commands/activate.md` | New command: prompt for API key, write to `.env`, verify. | ~20 lines |
| `commands/status.md` | Extend: if cloud mode, fetch usage from server and display. | ~10 lines added |

**Untouched:** `state-machine.ts`, `channel.ts`, `hooks.json`, all `scripts/*.sh` (except startup.sh), all `agents/*.md`, all skills, `process-trigger.js`, `trigger-gate.js` (reads from `pending/` which the poller populates).

### 4.3 Trigger poller (new, in plugin)

A lightweight Node.js script (`lib/cli/poll-triggers.js`) started as a background process by `startup.sh` in cloud mode.

- Polls `GET $API_URL/api/triggers/poll?since=<last_timestamp>` every 5 seconds
- Writes each received trigger as a JSON file to `$DATA_DIR/pending/<trigger-id>.json`
- Format is identical to what the local webhook server writes today
- `process-trigger.js` and `trigger-gate.js` continue reading from `pending/` — zero changes

Lifecycle: started by `startup.sh`, PID written to `$DATA_DIR/poller.pid`, killed by `cleanup.sh`.

### 4.4 Stripe integration

```
operantlabs.com "Get Started" button
  → Stripe Checkout (hosted)
    → success_url: operantlabs.com/welcome?session_id={CHECKOUT_SESSION_ID}
    → Stripe fires webhook: customer.subscription.created
      → api.operantlabs.com/webhook/stripe
        → provisioner.ts: create user, gen API key, allocate phone, send email
          → User receives email: "Your API key is op_xxxx. Run: claude plugin install operant && /activate"
```

Stripe setup via CLI:
```bash
stripe products create --name="Operant Pro" --description="Voice-driven dev pipeline"
stripe prices create --product=<prod_id> --unit-amount=4900 --currency=usd --recurring[interval]=month
stripe webhook endpoints create --url=https://api.operantlabs.com/webhook/stripe --events customer.subscription.created,customer.subscription.deleted,invoice.payment_failed
```

### 4.5 Database schema (Supabase Postgres)

```sql
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  api_key       TEXT NOT NULL UNIQUE,
  stripe_customer_id    TEXT,
  stripe_subscription_id TEXT,
  status        TEXT NOT NULL DEFAULT 'active',  -- active, cancelled, suspended
  retell_phone_number   TEXT,       -- allocated from pool, e.g. +16502001234
  registered_phone      TEXT,       -- user's personal phone for WhatsApp routing
  usage_minutes_this_period NUMERIC DEFAULT 0,
  usage_reset_at        TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE triggers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users(id),
  payload       JSONB NOT NULL,    -- raw Retell/Twilio webhook payload
  source        TEXT NOT NULL,     -- 'retell' | 'twilio' | 'mock'
  polled        BOOLEAN DEFAULT false,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_triggers_user_poll ON triggers(user_id, polled, created_at);

CREATE TABLE phone_pool (
  number        TEXT PRIMARY KEY,   -- e.g. +16502001234
  user_id       UUID REFERENCES users(id),  -- NULL = available
  provisioned_at TIMESTAMPTZ DEFAULT now()
);
```

### 4.6 Landing page (operantlabs.com)

Static HTML hosted on Hostinger. No CMS, no framework. Content:

- Hero: "Call a phone number. Describe a feature. Get shipped code."
- 60-second demo video (screen recording of pipeline running)
- How it works (3 steps): Install plugin → Activate → Call
- Pricing: Free (mock mode + BYO keys) / Pro $49/mo (we handle everything)
- CTA: "Get Started" → Stripe Checkout link
- FAQ: What's Claude Code? Do I need my own API keys? etc.

Domain: `operantlabs.com` (Hostinger, existing account)
Checkout link points to Stripe Checkout session URL.

## 5. Data Flow

### 5.1 Paid user: inbound call → pipeline start

```
1. User calls their Operant number (+1650200XXXX)
2. Retell receives call, runs voice agent, user describes feature
3. Call ends → Retell fires POST to api.operantlabs.com/webhook/call-completed/:user_id
4. Server: parse payload, insert into triggers table (user_id, payload, polled=false)
5. Plugin poller: GET /api/triggers/poll → receives trigger JSON
6. Poller: writes trigger to local pending/dry-run-001.json
7. inject-context.sh (UserPromptSubmit): detects pending trigger, outputs ACTION
8. Claude runs process-trigger.js on the local file → FSM transitions as normal
9. Pipeline continues entirely locally (SDLC → dev → audit → confirmation)
```

### 5.2 Paid user: outbound review gate

```
1. sdlc-writer writes intent-and-constraints.md
2. detect-artifact.sh fires → FSM to sdlc_review → gate-pending.json written
3. inject-context.sh: "BLOCKING: RUN GATE"
4. Claude runs trigger-gate.js in background
5. trigger-gate.js: cloud mode detected → POST to api.operantlabs.com/api/whatsapp/send
6. Server: proxies to Twilio with our credentials → WhatsApp message sent to user
7. User replies on WhatsApp → Twilio webhook hits api.operantlabs.com/webhook/whatsapp/:user_id
8. Server: enqueues reply as trigger
9. Poller: picks up reply, writes to pending/
10. trigger-gate.js: finds reply in pending/ (existing polling logic) → FSM transition
```

### 5.3 Free user: local mode

```
1. User installs plugin, no API key set
2. startup.sh: no OPERANT_API_KEY → starts local server + tunnel (today's flow)
3. User calls their own Retell number (their own account)
4. Webhook hits local server via tunnel → writes to pending/ directly
5. Everything works as today. Zero changes.
```

## 6. Technology Choices

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Server framework | Express | Already used in `scripts/server.ts`. Minimal learning curve. |
| Hosting | Railway | Git-push deploy, always-on, $5-20/mo. Fastest for Node.js. |
| Database | Supabase Postgres (free tier) | Managed, 500MB free, real Postgres. Railway's filesystem is ephemeral so SQLite won't persist. |
| Billing | Stripe | Existing account, CLI available, Checkout for hosted payments, webhook-driven provisioning. |
| Landing page | Static HTML on Hostinger | Domain already owned (operantlabs.com). No framework needed for a single page. |
| Email | Stripe receipts + Resend (or manual for v1) | Stripe sends payment receipts automatically. API key delivery can be manual email for first 10 users, then Resend API. |
| Domain for API | api.operantlabs.com | Subdomain of landing page domain. CNAME to Railway. |

## 7. Open Questions

- **OQ-HLD-1: API key delivery mechanism.** Stripe Checkout `success_url` can include a `{CHECKOUT_SESSION_ID}` param. The welcome page could call our API to look up the newly created API key and display it. Alternatively: just send it via email. The session-based approach is faster UX but requires a small server-rendered page (or client-side JS on the landing page that calls our API). **Default recommendation:** Email for v1 — simpler, more reliable, works even if user closes the checkout tab.

- **OQ-HLD-2: Poller vs SSE.** Polling every 5s adds 5s worst-case latency and generates ~720 requests/hour per active user. SSE (Server-Sent Events) would be zero-latency and zero wasted requests. But SSE requires keeping a persistent connection open, which is harder to manage in a background shell process. **Default recommendation:** Polling for v1 — simple, stateless, good enough. SSE for v2 if latency matters.

- **OQ-HLD-3: Welcome email provider.** For the first 10 users, we can manually email API keys. At scale, need a transactional email service. Options: Resend ($0, 100 emails/day free), SendGrid, SES. **Default recommendation:** Manual for first 10, then Resend.

- **OQ-HLD-4: Phone number pool management.** Pre-provision numbers manually via Retell dashboard, or automate via API in provisioner.ts? Manual is faster for launch (provision 5 numbers by hand). API automation needed once we exceed ~20 users. **Default recommendation:** Manual for launch, automate in provisioner.ts when pool management becomes a chore.

- **OQ-HLD-5: Trigger TTL and cleanup.** Triggers in the database should expire after some period to avoid unbounded growth. 24h TTL seems reasonable — if a plugin doesn't poll within 24h, the trigger is stale anyway. **Default recommendation:** 24h TTL, cron job or Supabase scheduled function to clean up.
