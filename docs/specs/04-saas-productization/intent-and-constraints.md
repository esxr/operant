# Intent & Constraints: SaaS Productization (Plugin + Hosted Backend)

**Version:** 1.0
**Date:** 2026-06-15
**Status:** Draft
**Source:** Research reports (scratchpad/01-03) + Twitter/X ecosystem analysis
**Audience:** Implementation agents (Claude Code plugin)

---

## 1. Problem Statement

Operant is a working voice-driven autonomous dev pipeline — but it only works for one person (us) on one machine. Every external dependency (Retell voice, Twilio WhatsApp, webhook server, cloudflare tunnel) requires manual provisioning. There is no way for a second person to use it, no billing, no auth, no multi-tenant isolation.

The goal is to productize Operant as a paid service using the **hybrid model**: the Claude Code plugin remains client-side (users install it in their own Claude Code), while we host the infrastructure they can't easily self-provision — webhook routing, Retell phone numbers, Twilio messaging, billing, and auth. Plugin is free, infrastructure is the product.

**Why hybrid over full SaaS:** Managed Agents (the full server-side path) is still in beta, adds 6-8 weeks of engineering, and removes the "runs in your own session on your own codebase" advantage. Hybrid ships in 1-2 weeks, validates demand, and the cloud API we build is reused when/if we move to Phase 2.

---

## 2. Goals

- **G-1:** A new user can go from signup to first pipeline run (phone call -> shipped feature) in under 15 minutes, without provisioning any third-party accounts (Retell, Twilio, Cloudflare).
- **G-2:** Multi-tenant isolation — each user gets their own phone number, webhook routing, and trigger queue. One user's pipeline state never leaks to another.
- **G-3:** Billing via Stripe (existing account: pranav@dhoolia.com) — subscription creation automatically provisions all infrastructure (API key, Retell phone number, Twilio number, user record). Cancellation tears it all down.
- **G-4:** The existing plugin (FSM, hooks, agents, scripts) requires minimal modification. Target: 90%+ of plugin code unchanged. No changes to state-machine.ts, hooks.json, agent .md files, or SDLC/dev/audit scripts.
- **G-5:** Plugin published to the Claude Code marketplace (public, free) or installable via GitHub URL. Zero friction install. Both free and paid users install via the same `claude plugin install operant` command.
- **G-6:** Two-tier model from a single plugin install:
  - **Free tier:** The full pipeline (FSM, hooks, agents, SDLC, dev, audit) runs locally with mock mode (`SECONDAXIS_MOCK=1`) or user-provided third-party credentials. No account required. No server dependency.
  - **Paid tier:** Adds hosted backend infrastructure — dedicated Retell phone number, Twilio WhatsApp, webhook routing, tunnel-free operation. Unlocked by entering an API key via `/activate`.

---

## 3. Functional Requirements

### FR-1: Hosted Webhook Server (operant-api)

- **FR-1.1:** Express/Fastify Node.js server deployed to Railway. Always-on (not serverless). Single deployment serves all users.
- **FR-1.2:** Retell webhook receiver at `POST /webhook/call-completed/:user_id` — receives call completion payloads, stores trigger in per-user queue.
- **FR-1.3:** Twilio webhook receiver at `POST /webhook/whatsapp/:user_id` — receives inbound WhatsApp replies, stores in per-user queue.
- **FR-1.4:** Trigger polling endpoint at `GET /api/triggers/poll?since=<timestamp>` — plugin polls this (authenticated) to fetch new triggers. Returns JSON array of triggers since the given timestamp. Empty array if none.
- **FR-1.5:** Gate reply endpoint at `POST /api/gates/reply` — plugin POSTs gate replies (review approvals, blocker resolutions, confirmations) which are stored in the user's queue for trigger-gate.js to pick up.
- **FR-1.6:** Outbound call proxy at `POST /api/calls/outbound` — plugin sends call requests here instead of calling Retell directly. Server uses the user's allocated phone number from our Retell pool.
- **FR-1.7:** Outbound WhatsApp proxy at `POST /api/whatsapp/send` — plugin sends WhatsApp messages here instead of calling Twilio directly.
- **FR-1.8:** Health check at `GET /health` — returns 200 with server status.
- **FR-1.9:** All authenticated endpoints require `Authorization: Bearer <api_key>` header. Invalid/expired keys return 401.

### FR-2: User Management & Auth

- **FR-2.1:** DIY API key auth (no Clerk/Auth0 for v1). Each user gets a random 32-byte hex API key on subscription creation.
- **FR-2.2:** User record stored in SQLite (Railway) or Supabase Postgres: `user_id`, `api_key`, `email`, `retell_phone_number`, `twilio_number`, `subscription_id`, `status` (active/cancelled/trial), `created_at`, `usage_this_period`.
- **FR-2.3:** API key validation middleware on all `/api/*` endpoints. Maps key to user record, rejects if status != active/trial.
- **FR-2.4:** No web dashboard for v1. User receives API key via email on signup. Enters it as `OPERANT_API_KEY` in their plugin `.env`.

### FR-3: Billing (Stripe)

- **FR-3.1:** Stripe subscription product (existing account: pranav@dhoolia.com): **$49/month** — includes 1 dedicated phone number, 60 minutes voice/month, WhatsApp messaging, webhook routing.
- **FR-3.2:** Stripe webhook `customer.subscription.created` triggers auto-provisioning:
  1. Create user record in DB
  2. Generate API key
  3. Allocate Retell phone number from pool (via Retell API `POST /create-phone-number`)
  4. Configure Retell phone number webhook URL to `https://api.operant.dev/webhook/call-completed/:user_id`
  5. Send welcome email with API key + install instructions
- **FR-3.3:** Stripe webhook `customer.subscription.deleted` triggers teardown:
  1. Set user status to `cancelled`
  2. Release Retell phone number back to pool (or delete)
  3. API key becomes invalid on next request
- **FR-3.4:** Usage tracking: server increments `usage_this_period` on each outbound call. Overage alert at 80% of included minutes. Hard cap at 120% (with grace period notification).
- **FR-3.5:** Stripe Checkout for signup flow — hosted checkout page, no custom payment UI needed. Redirect to `checkout.stripe.com` with success URL that shows API key.

### FR-4: Retell Multi-Tenant

- **FR-4.1:** Single Retell account, shared voice agent (our existing `agent_fd50bd6b1cf61664e75e2a8dd9`), per-user phone numbers.
- **FR-4.2:** Inbound call routing: Retell webhook includes `to_number` — server maps this to user_id via DB lookup.
- **FR-4.3:** Outbound calls: server uses `POST /v2/create-phone-call` with the user's allocated `from_number` and `override_agent_id` pointing to our shared agent. Dynamic variables carry per-user context (spec name, artifact summary, etc.).
- **FR-4.4:** Phone number pool: pre-provision 5-10 numbers at launch. Allocate on subscription, release on cancellation. Alert when pool runs low (< 3 available).

### FR-5: Twilio Multi-Tenant

- **FR-5.1:** Single Twilio account, shared WhatsApp Business number for v1. Per-user WhatsApp numbers are not needed — outbound messages identify by content, inbound replies route by `From` number matched against user's registered phone.
- **FR-5.2:** Inbound WhatsApp routing: match `From` number against user records to determine which user's queue to write the reply to.

### FR-6: Plugin Modifications

- **FR-6.1:** New env vars in `config.ts`: `OPERANT_API_KEY`, `OPERANT_API_URL` (defaults to `https://api.operant.dev`).
- **FR-6.2:** Replace `retell.ts` direct API calls: `makeOutboundCall()` calls `POST $OPERANT_API_URL/api/calls/outbound` instead of Retell directly. Server proxies to Retell with user's phone number.
- **FR-6.3:** Replace `whatsapp.ts` direct Twilio calls: outbound messages go through `POST $OPERANT_API_URL/api/whatsapp/send`.
- **FR-6.4:** New trigger poller: replaces local webhook server. Runs as a background process started by `startup.sh`. Polls `GET $OPERANT_API_URL/api/triggers/poll?since=<ts>` every 5 seconds when pipeline is active. Writes received triggers to local `pending/` directory (same format as today — downstream scripts unchanged).
- **FR-6.5:** `trigger-gate.js` modification: instead of waiting for local filesystem changes in `pending/`, also accepts triggers arriving via the poller. The poller writes to `pending/` so trigger-gate's existing polling logic works unchanged.
- **FR-6.6:** `startup.sh` modification: detect mode on startup. If `OPERANT_API_KEY` is set, verify against server (`curl $OPERANT_API_URL/api/auth/verify`). If not set or missing, start in free/local mode (today's behavior — user must provide own Retell/Twilio creds or use mock). No hard failure either way.
- **FR-6.7:** New `/activate` command: prompts user for API key, writes to `.env`, verifies against server. Transitions plugin from free to paid mode.
- **FR-6.8:** `scripts/tunnel.sh` stays available for free-tier users (they need it for local webhook server). Paid-tier users skip it (webhook server is hosted). `startup.sh` conditionally starts tunnel only when in free/local mode.
- **FR-6.9:** `scripts/register-webhook.sh` stays available for free-tier users. Paid-tier users skip it (webhook URL is set during phone number provisioning).

### FR-7: Marketplace Publishing

- **FR-7.1:** Plugin published to official Claude Code marketplace via `platform.claude.com/plugins/submit`. Requires passing quality/security review.
- **FR-7.2:** Fallback: public GitHub repo with install instructions (`claude plugin add github:esxr/operant`).
- **FR-7.3:** Plugin README includes: 30-second pitch, install command, activation flow (get API key from operant.dev, run `/activate`), first-feature-free offer.

---

## 4. Non-Functional Constraints

- **NFC-1: Minimal plugin disruption.** No changes to: `state-machine.ts`, `hooks.json`, agent `.md` files, `detect-artifact.sh`, `inject-context.sh`, `check-blockers.sh`, `pre-write-guard.sh`, `pre-agent-guard.sh`, `subagent-complete.sh`. These are the core pipeline — they must not be touched.
- **NFC-2: Polling latency.** Trigger polling must deliver triggers to the plugin within 10 seconds of webhook receipt. 5-second poll interval is acceptable for v1.
- **NFC-3: No user data persistence on our server beyond routing.** We store: user record, trigger queue (TTL 24h), usage counters. We do NOT store: transcripts, spec content, code, call recordings. Those stay on the user's machine.
- **NFC-4: API key is the only secret for paid users.** Paid users must not need to configure Retell API keys, Twilio credentials, or any other third-party tokens. Free users configure their own credentials (or use mock mode).
- **NFC-5: Free tier is fully functional without our server.** The plugin must work end-to-end in free/local mode with zero dependency on our hosted backend. This is not a "degraded" mode — it's the real free product. Paid mode is an upgrade, not a fix.
- **NFC-6: Railway deployment.** Server must deploy via `git push` to Railway. No Docker, no K8s, no custom infra. Single process, SQLite for persistence (or Supabase Postgres if SQLite proves insufficient).
- **NFC-7: Cost ceiling.** Hosted server infra must cost < $25/month at 0-50 users. Scale costs linearly with users, not exponentially.

---

## 5. Known Boundaries

- **B-1:** No web dashboard in v1. Users manage everything via CLI (plugin commands) and email.
- **B-2:** No team/org features. Single user per subscription. Multi-seat comes later.
- **B-3:** No custom voice agent personality. All users share the same Retell agent with dynamic variables for per-call context.
- **B-4:** No SSO, no OAuth, no social login. API key only.
- **B-5:** No usage dashboard or call history UI. Usage tracked server-side, surfaced via `/status` command output.
- **B-6:** Free tier has no time limit or feature cap — it's the real product running locally. The constraint is self-provisioning (user brings own Retell/Twilio/tunnel).
- **B-7:** No automated complexity classification for pricing. Flat $49/month subscription, not per-feature pricing (simplifies billing infra). Per-feature pricing is a Phase 2 consideration.
- **B-8:** Plugin requires Claude Code Max plan ($100/mo from Anthropic) for subagent support. We cannot control or bundle this. Users bring their own Claude Code subscription.

---

## 6. Open Questions

- **OQ-1:** ~~Lemon Squeezy vs Polar.sh?~~ Resolved: using Stripe (existing account).
- **OQ-2:** SQLite on Railway vs Supabase Postgres? SQLite is simpler (zero config) but Railway's ephemeral filesystem means we'd need a persistent volume. Supabase free tier gives managed Postgres with 500MB. Leaning Supabase.
- **OQ-3:** Should the trigger poller be a separate background process (started by `startup.sh`) or integrated into the existing webhook server code as a polling client? Separate process is simpler to reason about but adds a PID to manage.
- **OQ-4:** Marketplace review timeline? If the official marketplace review takes weeks, we should ship via GitHub URL first and submit to marketplace in parallel.
- **OQ-5:** Do we need a landing page (operant.dev) for v1, or can we drive everything through the marketplace listing + GitHub README + Twitter thread?

---

## 7. Acceptance Criteria

- **AC-1:** A new paid user can: subscribe via Stripe Checkout, receive API key via email, install plugin (`claude plugin install operant`), run `/activate`, and make their first phone call — all within 15 minutes. A free user can: install the same plugin and run a mock dry-run immediately with zero signup.
- **AC-2:** Phone call completes -> trigger appears in user's local `pending/` dir within 10 seconds -> pipeline processes it normally (same as today's local flow).
- **AC-3:** Review gates (WhatsApp/voice) work end-to-end through the hosted proxy — user receives outbound messages, replies are routed back to the correct user's plugin.
- **AC-4:** Second user's pipeline runs concurrently without interfering with first user's state, triggers, or phone number.
- **AC-5:** Subscription cancellation renders API key invalid within 1 minute. Plugin gracefully falls back to free/local mode (not a crash — just downgrades).
- **AC-6:** Server handles 50 concurrent users with < 200ms p95 latency on polling endpoint.
- **AC-7:** Free-tier user: installs plugin, runs `SECONDAXIS_MOCK=1` dry run immediately with zero configuration, zero signup, zero server dependency. Full pipeline works end-to-end in mock mode.
