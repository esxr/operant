# Implementation Spec: SaaS Productization

**Version:** 1.0
**Date:** 2026-06-15
**Status:** Draft
**Input:** Intent v1.0, HLD v1.0, ADR-Lite v1.0 (ADR-020 through ADR-028)

---

## 1. Deliverables

Two codebases, one DB, one Stripe product:

| Deliverable | Repo | Deploy |
|-------------|------|--------|
| **operant-api** | `esxr/operant-api` (new) | Railway |
| **operantlabs.com** | `esxr/operantlabs.com` (existing) | Vercel (`prj_BS04kVqPJEZS07dURSXokRvWPst5`) |
| **Plugin modifications** | `esxr/operant` (this repo) | Claude Code marketplace |
| **Supabase schema** | migration in `operant-api/supabase/` | Supabase (`bztxagedcvsfjmulzipq`) |
| **Stripe product** | CLI-created | Stripe (`acct_1Poyy0K8lRaQYg7j`) |

---

## 2. operant-api (Express on Railway)

### 2.1 Project structure

```
operant-api/
├── src/
│   ├── index.ts              # Express app + server startup
│   ├── db.ts                 # Supabase client init
│   ├── middleware/
│   │   └── auth.ts           # API key validation middleware
│   ├── routes/
│   │   ├── webhooks.ts       # POST /webhook/call-completed/:user_id, /webhook/whatsapp/:user_id
│   │   ├── api.ts            # GET /api/triggers/poll, POST /api/calls/outbound, etc.
│   │   └── stripe.ts         # POST /webhook/stripe
│   └── services/
│       ├── provisioner.ts    # User provisioning/teardown on Stripe events
│       ├── retell-proxy.ts   # Proxy outbound calls to Retell API
│       └── twilio-proxy.ts   # Proxy outbound WhatsApp to Twilio API
├── package.json
├── tsconfig.json
└── .env.example
```

### 2.2 API Contracts

#### `POST /webhook/call-completed/:user_id`

Unauthenticated (Retell calls this). Receives Retell call-completed payload.

```
Request: Retell webhook payload (JSON body)
  - call_id: string
  - from_number: string
  - to_number: string
  - call_analysis: object
  - transcript: string
  - ...rest of Retell payload

Response: 200 OK (empty body)

Side effect: INSERT into triggers table
  { user_id: <from URL param>, payload: <full body>, source: 'retell', polled: false }
```

Validation: look up `user_id` in `users` table. If not found or status != 'active', return 200 (swallow — don't leak user existence to Retell).

#### `POST /webhook/whatsapp/:user_id`

Unauthenticated (Twilio calls this). Receives Twilio inbound WhatsApp message.

```
Request: application/x-www-form-urlencoded (Twilio format)
  - From: whatsapp:+61416052430
  - Body: "Approved. Looks good."
  - MessageSid: string

Response: 200 OK (empty body, or TwiML <Response/>)

Side effect: INSERT into triggers table
  { user_id: <from URL param>, payload: { from_number: From, body: Body, message_sid: MessageSid, source: 'twilio' }, source: 'twilio', polled: false }
```

Alternative routing: if no `user_id` in URL (shared WhatsApp number), look up user by `From` number matched against `users.registered_phone`.

#### `GET /api/triggers/poll`

Authenticated (API key required).

```
Request:
  Headers: Authorization: Bearer <api_key>
  Query: ?since=<ISO timestamp>&limit=<int, default 10>

Response: 200 OK
  Body: { triggers: [{ id, payload, source, created_at }] }

Side effect: UPDATE triggers SET polled = true WHERE id IN (<returned ids>)
```

Query: `SELECT * FROM triggers WHERE user_id = $1 AND polled = false AND created_at > $2 ORDER BY created_at ASC LIMIT $3`

#### `POST /api/calls/outbound`

Authenticated. Proxies outbound voice call to Retell.

```
Request:
  Headers: Authorization: Bearer <api_key>
  Body: {
    to_number: string,        // user's personal phone
    dynamic_variables: object, // per-call context (spec_name, artifact_summary, etc.)
    metadata: object           // optional metadata
  }

Response: 200 OK
  Body: { call_id: string, status: "created" }

Side effect:
  1. Look up user's retell_phone_number from users table
  2. POST to Retell /v2/create-phone-call with:
     - from_number: user's allocated number
     - to_number: from request body
     - override_agent_id: RETELL_AGENT_ID (shared agent)
     - retell_llm_dynamic_variables: from request body
  3. Increment usage_minutes_this_period (estimated, trued up on call completion)
```

#### `POST /api/whatsapp/send`

Authenticated. Proxies outbound WhatsApp message to Twilio.

```
Request:
  Headers: Authorization: Bearer <api_key>
  Body: { to: string, body: string }

Response: 200 OK
  Body: { message_sid: string }

Side effect:
  1. POST to Twilio Messages API with:
     - From: TWILIO_WHATSAPP_NUMBER (our shared number)
     - To: whatsapp:<to>
     - Body: <body>
```

#### `GET /api/auth/verify`

Authenticated. Returns user info if API key is valid.

```
Response: 200 OK
  Body: { user_id, email, status, retell_phone_number, usage_minutes_this_period, usage_reset_at }

Response: 401 Unauthorized
  Body: { error: "Invalid API key" }
```

#### `GET /api/usage`

Authenticated. Returns usage data for dashboard.

```
Response: 200 OK
  Body: {
    minutes_used: number,
    minutes_included: 60,
    calls_this_period: number,
    period_start: ISO timestamp,
    period_end: ISO timestamp
  }
```

#### `GET /health`

Unauthenticated.

```
Response: 200 OK
  Body: { status: "ok", version: string, uptime: number }
```

#### `POST /webhook/stripe`

Unauthenticated (Stripe calls this). Validates Stripe signature.

```
Request: Stripe webhook payload (raw body needed for signature verification)
  Headers: Stripe-Signature: <sig>

Events handled:
  - customer.subscription.created → provisioner.provision(customer_email, subscription_id)
  - customer.subscription.deleted → provisioner.teardown(subscription_id)
  - invoice.payment_failed → set user status = 'suspended'

Response: 200 OK
```

### 2.3 Middleware: auth.ts

```typescript
// Pseudocode
export async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Missing API key' });

  const { data: user } = await supabase
    .from('users')
    .select('*')
    .eq('api_key', token)
    .single();

  if (!user || user.status === 'cancelled') {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  if (user.status === 'suspended') {
    return res.status(403).json({ error: 'Subscription suspended — update payment' });
  }

  req.user = user;
  next();
}
```

### 2.4 Service: provisioner.ts

```
provision(email, stripe_customer_id, stripe_subscription_id):
  1. Generate API key: 'op_' + crypto.randomBytes(32).toString('hex')
  2. Allocate phone: SELECT number FROM phone_pool WHERE user_id IS NULL LIMIT 1
  3. UPDATE phone_pool SET user_id = <new_user_id> WHERE number = <allocated>
  4. INSERT into users (email, api_key, stripe_customer_id, stripe_subscription_id, retell_phone_number, status='active')
  5. Configure Retell webhook: PATCH /update-agent/<agent_id> — NOT needed (webhook URL includes user_id, set per-number)
     Actually: update the phone number's inbound webhook via Retell API
  6. Return { api_key, phone_number }

teardown(stripe_subscription_id):
  1. SELECT user from users WHERE stripe_subscription_id = $1
  2. UPDATE users SET status = 'cancelled' WHERE id = user.id
  3. UPDATE phone_pool SET user_id = NULL WHERE user_id = user.id
```

### 2.5 Environment variables (operant-api)

```env
# Supabase
SUPABASE_URL=https://bztxagedcvsfjmulzipq.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role_key>

# Retell (master account)
RETELL_API_KEY=<from plugin .env>
RETELL_AGENT_ID=agent_fd50bd6b1cf61664e75e2a8dd9

# Twilio (master account)
TWILIO_ACCOUNT_SID=<from plugin .env>
TWILIO_AUTH_TOKEN=<from plugin .env>
TWILIO_WHATSAPP_NUMBER=+14155238886

# Stripe
STRIPE_WEBHOOK_SECRET=<from stripe webhook endpoint create>
STRIPE_SECRET_KEY=<from stripe config>

# Server
PORT=3000
NODE_ENV=production
```

---

## 3. Plugin Modifications

### 3.1 `src/config.ts` — Add cloud mode detection

Add to existing exports:

```typescript
export function getOperantApiKey(): string | null {
  return process.env.OPERANT_API_KEY ?? null;
}

export function getOperantApiUrl(): string {
  return process.env.OPERANT_API_URL ?? 'https://api.operantlabs.com';
}

export function getMode(): 'cloud' | 'local' {
  return getOperantApiKey() ? 'cloud' : 'local';
}
```

No other changes to config.ts. Existing functions unchanged.

### 3.2 `src/retell.ts` — Conditional proxy

Modify `makeOutboundCall()` only. Add cloud-mode branch at the top:

```typescript
// At top of file, add import:
import { getMode, getOperantApiKey, getOperantApiUrl } from './config.js';

// In makeOutboundCall(), add before existing code:
export function makeOutboundCall(fromNumber, toNumber, agentId, metadata, dynamicVariables) {
  if (getMode() === 'cloud') {
    return cloudOutboundCall(toNumber, metadata, dynamicVariables);
  }
  // ... existing Retell direct call code (unchanged) ...
}

// New function:
function cloudOutboundCall(toNumber, metadata, dynamicVariables) {
  const apiUrl = getOperantApiUrl();
  const apiKey = getOperantApiKey();
  const body = JSON.stringify({ to_number: toNumber, dynamic_variables: dynamicVariables, metadata });

  return new Promise((resolve, reject) => {
    const url = new URL(`${apiUrl}/api/calls/outbound`);
    const req = https.request({
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error(`API error ${res.statusCode}: ${data}`));
        else resolve(JSON.parse(data));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
```

All other retell.ts functions (`createAgent`, `updateAgentWebhook`, `getCallDetails`, etc.) remain unchanged — they're only used in local mode.

### 3.3 `src/whatsapp.ts` — Conditional proxy

Same pattern. Modify the outbound send function:

```typescript
import { getMode, getOperantApiKey, getOperantApiUrl } from './config.js';

// In sendTwilioMessage() or equivalent, add cloud branch:
if (getMode() === 'cloud') {
  return cloudSendWhatsApp(to, body);
}
// ... existing Twilio direct code ...

function cloudSendWhatsApp(to, body) {
  const apiUrl = getOperantApiUrl();
  const apiKey = getOperantApiKey();
  const payload = JSON.stringify({ to, body });
  // Same HTTPS POST pattern as cloudOutboundCall
}
```

### 3.4 `src/cli/poll-triggers.ts` — New file

```typescript
/**
 * @module cli/poll-triggers
 *
 * Background poller for cloud mode. Fetches triggers from operant-api
 * and writes them to local pending/ directory.
 *
 * Usage: node lib/cli/poll-triggers.js
 * Started by startup.sh in cloud mode. PID written to $DATA_DIR/poller.pid.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import https from 'node:https';
import { getDataDir, ensureDataDir, getOperantApiKey, getOperantApiUrl } from '../config.js';

const POLL_INTERVAL = 5000; // 5 seconds
let lastTimestamp = new Date(Date.now() - 60000).toISOString(); // start 1 min ago

async function poll() {
  const apiUrl = getOperantApiUrl();
  const apiKey = getOperantApiKey();
  if (!apiKey) { process.exit(0); } // no key = local mode, shouldn't be running

  const url = `${apiUrl}/api/triggers/poll?since=${encodeURIComponent(lastTimestamp)}&limit=10`;

  try {
    const data = await httpGet(url, apiKey);
    const parsed = JSON.parse(data);
    const triggers = parsed.triggers ?? [];

    if (triggers.length > 0) {
      const pendingDir = join(getDataDir(), 'pending');
      mkdirSync(pendingDir, { recursive: true });

      for (const trigger of triggers) {
        const filename = `${trigger.id}.json`;
        writeFileSync(join(pendingDir, filename), JSON.stringify(trigger.payload, null, 2));
        lastTimestamp = trigger.created_at;
      }
      process.stderr.write(`[poller] Fetched ${triggers.length} trigger(s)\n`);
    }
  } catch (err) {
    process.stderr.write(`[poller] Error: ${err.message}\n`);
  }
}

function httpGet(url, apiKey) { /* standard node:https GET with Bearer auth */ }

// Main loop
ensureDataDir();
writeFileSync(join(getDataDir(), 'poller.pid'), String(process.pid));
setInterval(poll, POLL_INTERVAL);
poll(); // immediate first poll
```

### 3.5 `scripts/startup.sh` — Mode detection

Add after existing data dir setup, before server/tunnel start:

```bash
# ── Mode detection ─────────────────────────────────────────────────
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-.}"
MODE="local"

if [ -n "${OPERANT_API_KEY:-}" ]; then
  # Verify API key with server
  API_URL="${OPERANT_API_URL:-https://api.operantlabs.com}"
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $OPERANT_API_KEY" \
    "$API_URL/api/auth/verify" 2>/dev/null || echo "000")

  if [ "$HTTP_CODE" = "200" ]; then
    MODE="cloud"
    echo "[PIPELINE] Cloud mode active (api.operantlabs.com)"
  else
    echo "[PIPELINE] API key invalid or server unreachable (HTTP $HTTP_CODE). Falling back to local mode."
  fi
fi

if [ "$MODE" = "cloud" ]; then
  # Start trigger poller instead of local server + tunnel
  node "$PLUGIN_ROOT/lib/cli/poll-triggers.js" &
  echo $! > "$DATA_DIR/poller.pid"
  echo "[PIPELINE] Trigger poller started (PID $(cat "$DATA_DIR/poller.pid"))"
else
  # Existing local mode: start server + tunnel (unchanged)
  # ... existing startup.sh code ...
fi
```

### 3.6 `scripts/cleanup.sh` — Kill poller

Add:

```bash
# Kill trigger poller if running
if [ -f "$DATA_DIR/poller.pid" ]; then
  kill "$(cat "$DATA_DIR/poller.pid")" 2>/dev/null
  rm -f "$DATA_DIR/poller.pid"
fi
```

### 3.7 `commands/activate.md` — New command

```markdown
---
description: Activate paid mode by entering your API key
argument-hint: [api-key]
allowed-tools: Bash, Read, Write
---

Activate paid mode for the Operant plugin:

1. If an API key was provided as argument, use it. Otherwise ask the user.
2. Verify the key: `curl -s -H "Authorization: Bearer $KEY" https://api.operantlabs.com/api/auth/verify`
3. If valid (200): append `OPERANT_API_KEY=<key>` to the plugin .env file.
4. Report success: "Paid mode activated. Your phone number is <number>. Restart the session to apply."
5. If invalid (401): report "Invalid API key. Get one at operantlabs.com"
```

---

## 4. Supabase Schema

Execute on project `bztxagedcvsfjmulzipq`:

```sql
-- Enable pg_cron for trigger cleanup
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Core tables
CREATE TABLE users (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                       TEXT NOT NULL UNIQUE,
  api_key                     TEXT NOT NULL UNIQUE,
  stripe_customer_id          TEXT UNIQUE,
  stripe_subscription_id      TEXT UNIQUE,
  status                      TEXT NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active', 'cancelled', 'suspended')),
  retell_phone_number         TEXT,
  registered_phone            TEXT,
  usage_minutes_this_period   NUMERIC NOT NULL DEFAULT 0,
  usage_calls_this_period     INTEGER NOT NULL DEFAULT 0,
  usage_reset_at              TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days'),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE triggers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payload     JSONB NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('retell', 'twilio', 'mock')),
  polled      BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_triggers_poll ON triggers(user_id, polled, created_at)
  WHERE polled = false;

CREATE TABLE phone_pool (
  number          TEXT PRIMARY KEY,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  provisioned_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS for dashboard (ADR-025)
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE triggers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own row" ON users
  FOR SELECT USING (auth.uid()::text = id::text);

CREATE POLICY "Users read own triggers" ON triggers
  FOR SELECT USING (user_id = auth.uid());

-- Trigger TTL cleanup (ADR-026): daily at 3am UTC
SELECT cron.schedule('trigger-cleanup', '0 3 * * *',
  $$DELETE FROM triggers WHERE created_at < now() - interval '24 hours'$$
);
```

---

## 5. Stripe Setup

Via CLI:

```bash
# Create product
stripe products create \
  --name="Operant Pro" \
  --description="Voice-driven dev pipeline — dedicated phone number, WhatsApp, webhook routing"

# Create price ($49/month)
stripe prices create \
  --product=<PRODUCT_ID> \
  --unit-amount=4900 \
  --currency=usd \
  --recurring[interval]=month

# Create webhook endpoint
stripe webhook endpoints create \
  --url=https://api.operantlabs.com/webhook/stripe \
  --events customer.subscription.created,customer.subscription.deleted,invoice.payment_failed
```

Store `STRIPE_WEBHOOK_SECRET` from the endpoint creation response in Railway env vars.

---

## 6. operantlabs.com (Next.js Dashboard)

### 6.1 Pages

| Route | Auth | Purpose |
|-------|------|---------|
| `/` | No | Landing page — hero, how it works, pricing, CTA |
| `/pricing` | No | Pricing details + Stripe Checkout redirect |
| `/auth` | No | Supabase Auth — GitHub/Google OAuth login |
| `/dashboard` | Yes | API key display, usage meters, phone number, call history |
| `/dashboard/billing` | Yes | Stripe Customer Portal redirect |

### 6.2 Auth flow

1. User clicks "Get Started" on landing page
2. Redirected to Stripe Checkout (with `client_reference_id` = email)
3. Stripe webhook fires → `provisioner.ts` creates user + API key
4. Stripe Checkout `success_url` → `/auth?checkout=success`
5. User signs in via Supabase Auth (GitHub/Google — same email)
6. Dashboard loads → shows API key, phone number, usage

### 6.3 Supabase Auth config

- Enable GitHub and Google OAuth providers in Supabase dashboard
- Set redirect URLs to `https://operantlabs.com/auth/callback`
- RLS policies (defined in section 4) restrict data access to own user row

### 6.4 Key dashboard component: API key display

```tsx
// Pseudocode
const { data: user } = await supabase
  .from('users')
  .select('api_key, retell_phone_number, usage_minutes_this_period, usage_calls_this_period')
  .single();

// Show:
// - API key (copyable, partially masked by default with "reveal" toggle)
// - Phone number: +1 (650) 200-XXXX
// - Usage: 12 / 60 minutes used this period
// - "Manage Billing" → Stripe Customer Portal
```

---

## 7. DNS Configuration

| Domain | Record | Value |
|--------|--------|-------|
| `operantlabs.com` | CNAME | `cname.vercel-dns.com` (Vercel) |
| `api.operantlabs.com` | CNAME | `<railway-app>.up.railway.app` (Railway) |

Set in Hostinger DNS management panel.

---

## 8. Implementation Order

Build in this sequence (each step is independently deployable/testable):

### Sprint 1: operant-api core (Day 1-2)
1. Scaffold Express project with TypeScript
2. Implement `db.ts` (Supabase client)
3. Implement `middleware/auth.ts`
4. Implement `routes/webhooks.ts` (Retell + Twilio inbound)
5. Implement `routes/api.ts` (trigger poll, outbound proxies, auth verify)
6. Deploy to Railway, set env vars
7. Test: curl trigger poll endpoint with mock API key

### Sprint 2: Stripe + provisioning (Day 2-3)
1. Create Stripe product + price + webhook endpoint via CLI
2. Implement `routes/stripe.ts` (webhook handler)
3. Implement `services/provisioner.ts` (provision + teardown)
4. Test: Stripe CLI `stripe trigger customer.subscription.created` → verify user created in DB

### Sprint 3: Plugin modifications (Day 3-4)
1. Add `getMode()`, `getOperantApiKey()`, `getOperantApiUrl()` to `config.ts`
2. Add cloud branch to `retell.ts` `makeOutboundCall()`
3. Add cloud branch to `whatsapp.ts` send function
4. Create `poll-triggers.ts`
5. Modify `startup.sh` for mode detection
6. Modify `cleanup.sh` to kill poller
7. Create `/activate` command
8. Build (`npm run build`), test locally with `SECONDAXIS_MOCK=1`

### Sprint 4: Dashboard (Day 4-5)
1. Replace `esxr/operantlabs.com` content with Next.js app (keep Vercel project)
2. Landing page (`/`) — port existing pitch page design
3. Auth page (`/auth`) — Supabase Auth with GitHub/Google
4. Dashboard page (`/dashboard`) — API key, usage, phone number
5. Billing redirect (`/dashboard/billing`) — Stripe Customer Portal
6. Deploy to Vercel, test end-to-end

### Sprint 5: DNS + E2E test (Day 5-6)
1. Configure `api.operantlabs.com` CNAME in Hostinger
2. Pre-provision 5 Retell phone numbers, insert into `phone_pool`
3. Full E2E test: Stripe Checkout → provision → install plugin → /activate → phone call → pipeline runs → gates work
4. Fix issues, iterate

---

## 9. Acceptance Criteria Traceability

| AC | Verified By |
|----|-------------|
| AC-1 (15-min onboarding) | Sprint 5 E2E test — time the full flow |
| AC-2 (trigger in 10s) | Sprint 3 — test poller latency with stopwatch |
| AC-3 (gates work E2E) | Sprint 5 — make real call, verify WhatsApp gate round-trips |
| AC-4 (multi-tenant isolation) | Sprint 2 — create 2 test users, verify trigger isolation |
| AC-5 (cancellation) | Sprint 2 — `stripe trigger customer.subscription.deleted`, verify 401 |
| AC-6 (50 users, 200ms p95) | Defer — load test after launch if needed |
| AC-7 (free tier works) | Sprint 3 — test with no API key, verify mock mode unchanged |
