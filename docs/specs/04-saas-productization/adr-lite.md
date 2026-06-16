# ADR-Lite: SaaS Productization

**Version:** 1.0
**Date:** 2026-06-15
**Status:** Draft
**Input:** Intent & Constraints v1.0, HLD v1.0, Research reports (scratchpad/01-05)

---

## ADR-020: Database — Supabase Postgres over SQLite

**Decision:** Use Supabase Postgres (free tier, project ref `bztxagedcvsfjmulzipq`, Sydney region) for all server-side persistence.

**Alternatives:**
1. SQLite on Railway — zero config, single file, fast reads
2. Supabase Postgres — managed, 500MB free, real Postgres, REST API, RLS, auth
3. PlanetScale/Neon — managed MySQL/Postgres, free tiers available

**Rationale:** Railway's filesystem is ephemeral across deploys — SQLite would lose data on every `git push`. Supabase is already in our stack (pegg-app project exists), CLI is installed, and the free tier gives us managed Postgres with 500MB, which is more than enough for 50 users. Row Level Security enables the customer dashboard later (ADR-025). Resolves **OQ-2** from intent doc.

**Consequences:** Adds a network hop for every DB query (vs in-process SQLite). Acceptable at our scale. If we need sub-ms reads later, add a local cache layer.

---

## ADR-021: Billing — Stripe with CLI-driven setup

**Decision:** Use existing Stripe account (`acct_1Poyy0K8lRaQYg7j`). Single product "Operant Pro" at $49/month. Stripe Checkout for signup, webhooks for provisioning/teardown.

**Alternatives:**
1. Lemon Squeezy — MoR (handles tax), 5% + 50c, fast setup
2. Stripe — 2.9% + 30c, no MoR, existing account + CLI
3. Polar.sh — dev-tool native, GitHub integration, 5% + 50c

**Rationale:** Stripe account already exists, CLI is pre-authed, live mode keys are active. Lower fees than MoR platforms (2.9% vs 5%). Tax compliance deferred — not worth the complexity for first 10 users. Stripe Checkout eliminates the need for a custom payment UI. Resolves **OQ-1** from intent doc.

**Consequences:** We're responsible for sales tax compliance eventually. For v1 with < 50 users, the risk is minimal. Add Stripe Tax ($0.50/txn) when revenue exceeds $10K/month.

---

## ADR-022: API key delivery — Dashboard, not email

**Decision:** API key shown in customer dashboard at `operantlabs.com/dashboard` after Stripe Checkout success redirect. No email delivery for v1.

**Alternatives:**
1. Email delivery (manual for first 10, then Resend API)
2. Stripe Checkout success page with inline API key display
3. Customer dashboard with persistent access to API key

**Rationale:** User requested a dashboard instead of email-only. Research (scratchpad/05) shows Next.js + Supabase RLS is the fastest path ($0, 1-2 days). The dashboard also shows usage metrics and subscription status — more valuable than a one-time email. Stripe Checkout `success_url` redirects to `/dashboard?session_id={CHECKOUT_SESSION_ID}`, dashboard looks up the session, finds the user, shows the API key. Resolves **OQ-HLD-1**.

**Consequences:** Requires building a small Next.js app (4 pages: landing, dashboard, pricing, auth). Adds ~2 days to the MVP timeline. But eliminates the "check your email" friction and provides a home for usage data.

---

## ADR-023: Trigger delivery — Polling for v1

**Decision:** Plugin polls `GET /api/triggers/poll?since=<timestamp>` every 5 seconds. Poller writes to local `pending/` directory.

**Alternatives:**
1. Polling (5s interval) — simple, stateless, ~720 req/hr per active user
2. SSE (Server-Sent Events) — zero-latency, zero wasted requests, persistent connection
3. WebSocket — bidirectional, complex, overkill

**Rationale:** Polling is trivially implementable as a background Node.js script. The 5s worst-case latency is invisible to users (a phone call takes minutes). SSE requires managing persistent connections from a shell-started background process, which is fragile. The poller writes to `pending/` in the same format as the local webhook server — zero changes to `process-trigger.js` or `trigger-gate.js`. Resolves **OQ-HLD-2**.

**Consequences:** ~720 requests/hour per active user. At 50 concurrent users = 36K req/hr = 10 req/s. Trivial for a Railway Express server. Switch to SSE if we hit 500+ concurrent users or if latency becomes a complaint.

---

## ADR-024: Phone pool — Manual for launch, API automation later

**Decision:** Pre-provision 5 Retell phone numbers manually via dashboard. Allocate to users in `phone_pool` table. Automate via Retell API when pool drops below 3.

**Alternatives:**
1. Fully manual — provision by hand, allocate by hand
2. Manual provision, automated allocation — provision by hand, `provisioner.ts` allocates on subscription
3. Fully automated — `provisioner.ts` provisions AND allocates via Retell API

**Rationale:** Provisioning a phone number via Retell API (`POST /create-phone-number`) works, but we need to verify area code availability and cost implications first. Manual provisioning for 5 numbers takes 10 minutes. Automated allocation (picking an unassigned number from `phone_pool`) is trivial SQL. Automate provisioning when we exceed 20 users and manual becomes a chore. Resolves **OQ-HLD-4**.

**Consequences:** Manual bottleneck at scale. Acceptable for first 20 users. Add `provisioner.ts` auto-provision when `SELECT COUNT(*) FROM phone_pool WHERE user_id IS NULL` < 3.

---

## ADR-025: Customer dashboard — Next.js + Supabase RLS + Stripe Customer Portal

**Decision:** Build a lightweight Next.js dashboard at `operantlabs.com`. 4 pages: landing (marketing), auth (Supabase Auth with GitHub/Google OAuth), dashboard (API key, usage, call history), billing (Stripe Customer Portal embed). Deploy to Vercel (free tier) or Railway.

**Alternatives:**
1. No dashboard — email-only API key, CLI for usage (B-1 from intent)
2. Stigg — embeddable billing portal widget, free < $10K MRR
3. Retool/Forest Admin — internal admin tools, not customer-facing
4. Next.js + Supabase RLS — custom, 1-2 days, $0

**Rationale:** User explicitly requested a dashboard over email-only. Next.js + Supabase is the standard YC-company stack for lightweight dashboards. Supabase Auth provides OAuth login (GitHub, Google). Supabase RLS ensures each user only sees their own rows. Stripe Customer Portal handles subscription management (cancel, update payment, view invoices) with zero custom billing UI. Total custom pages: 2 (dashboard home + API key display). Research (scratchpad/05) confirms this is the right-sized solution.

**Consequences:** Adds ~2 days to MVP. But replaces 3 things that would otherwise need manual handling (API key delivery, usage visibility, billing management). The dashboard becomes the operantlabs.com landing page too — one deploy, one domain.

---

## ADR-026: Trigger TTL — 24h with Supabase cron cleanup

**Decision:** Triggers in the `triggers` table have a 24h TTL. Supabase `pg_cron` extension runs `DELETE FROM triggers WHERE created_at < now() - interval '24 hours'` daily.

**Alternatives:**
1. No TTL — triggers grow forever (bad)
2. 24h TTL with app-level cleanup — delete in API code on each poll
3. 24h TTL with pg_cron — database handles it, zero app code

**Rationale:** Triggers that haven't been polled in 24h are stale (the user's plugin wasn't running). pg_cron is built into Supabase and requires zero app code. Resolves **OQ-HLD-5**.

**Consequences:** A user who doesn't run their plugin for > 24h loses pending triggers. This is acceptable — triggers represent real-time events (call completions) that are meaningless if not processed promptly.

---

## ADR-027: Free tier boundary — no API key = local mode

**Decision:** The free/paid boundary is a single environment variable: `OPERANT_API_KEY`. If set, plugin runs in cloud mode (proxies through our API). If unset, plugin runs in local mode (today's behavior). No feature flags, no license files, no server-side feature gating.

**Alternatives:**
1. Server-side feature flags — plugin checks `/api/features` on startup
2. License key with embedded capabilities — decoded locally
3. Environment variable check — `OPERANT_API_KEY` present or not

**Rationale:** The free tier IS today's plugin, unchanged. There's nothing to gate — the free user simply doesn't have an API key, so the plugin falls back to direct Retell/Twilio calls (their own keys) or mock mode. This is the simplest possible implementation: one `if` statement in `config.ts`. No server roundtrip needed to determine tier. References **G-6** from intent, **NFC-5** (free tier fully functional without server).

**Consequences:** A paid user who loses connectivity gracefully degrades to free/local mode (if they have their own Retell/Twilio keys). A user could theoretically set a fake API key — the server rejects it on first call, plugin errors, user removes it. No real abuse vector since the free tier has no artificial limitations.

---

## ADR-028: Landing page + dashboard — single Next.js deploy

**Decision:** `operantlabs.com` serves both the marketing landing page AND the customer dashboard from a single Next.js app. Routes: `/` (landing), `/pricing`, `/auth` (login/signup), `/dashboard` (authenticated). Deploy to Vercel (free tier, auto-deploy from GitHub).

**Alternatives:**
1. Separate deploys — static HTML on Hostinger for landing, Next.js on Vercel for dashboard
2. Single Next.js on Railway — same process as API server
3. Single Next.js on Vercel — separate from API server on Railway

**Rationale:** One deploy = one domain = one repo = less to manage. Vercel's free tier handles Next.js natively with zero config. The API server on Railway is a separate concern (it handles webhooks, proxying, and billing — not page rendering). Keeping them separate follows the dumb-proxy principle from the HLD. DNS: `operantlabs.com` → Vercel, `api.operantlabs.com` → Railway.

**Consequences:** Two deploys to manage (Vercel for frontend, Railway for API). But they have different scaling profiles and failure modes — a dashboard outage shouldn't take down webhook processing. This separation is a feature, not overhead.

---

## Summary of resolved questions

| Question | Resolution | ADR |
|----------|-----------|-----|
| OQ-1 (billing provider) | Stripe (existing account) | ADR-021 |
| OQ-2 (SQLite vs Postgres) | Supabase Postgres | ADR-020 |
| OQ-3 (poller architecture) | Separate background process | ADR-023 |
| OQ-HLD-1 (API key delivery) | Dashboard, not email | ADR-022 |
| OQ-HLD-2 (polling vs SSE) | Polling 5s | ADR-023 |
| OQ-HLD-3 (email provider) | N/A — dashboard replaces email | ADR-022 |
| OQ-HLD-4 (phone pool mgmt) | Manual provision, auto allocate | ADR-024 |
| OQ-HLD-5 (trigger TTL) | 24h, pg_cron cleanup | ADR-026 |
| B-1 (no dashboard) | Overridden — dashboard added | ADR-025 |
