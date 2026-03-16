# CC Prompt: WoT Scoring API + LightningEnable — Investigation, Cleanup & Registration

## IMPORTANT: Dev DB vs Production DB

**You are working locally against a dev copy of the SQLite database. The production database runs on Railway and is NOT accessible from your environment.** This means:

- You **CAN** probe live API endpoints via `curl` — these hit the real internet.
- You **CANNOT** read or query the production database directly. Your local DB may be empty or stale.
- All DB operations (reads, inserts, updates, deletes) **MUST** be packaged as standalone `.mjs` scripts in `scripts/` that Ryan will run on Railway via `railway ssh -- node scripts/<name>.mjs`.
- Do NOT use inline `node -e "..."` snippets that query the DB — those will run against your empty local DB and return nothing useful.
- Do NOT make decisions based on what you see in your local DB. Base decisions on what you learn from probing live endpoints + the documentation.

Pattern to follow: see `scripts/register-sats4ai.mjs` and `scripts/register-maximumsats.mjs` for the correct pattern. Those scripts use `process.env.DB_PATH || '/data/402index.db'` and are designed to be run on Railway.

## Context

402index.io is a registry of L402/x402 paid API endpoints. We're preparing for a launch post (Stacker News + Twitter) and need to clean up our data quality.

Two providers need investigation:

1. **WoT Scoring API** (`wot.klabo.world`) — A Web of Trust scoring service for Nostr. We already have ~12+ WoT endpoints in the production database from Satring aggregation, most showing as "degraded" (returning 400 errors). The WoT API uses an L402 Lightning paywall with proper `WWW-Authenticate` headers on paid endpoints and has a free tier (10 requests/day per IP). We need to figure out the correct endpoint configuration, write a fix script, and let Ryan run it on prod. **Note: MaximumSats (same operator — klabo.world) also has WoT endpoints but those are separate services already registered.**

2. **LightningEnable** (`api.lightningenable.com`) — A Lightning payment infrastructure company that also offers L402-protected proxy endpoints. Their site shows proper L402 flow documentation (request → 402 + invoice → pay → retry with X-Payment-Hash). They have an L402 proxy at `/l402/proxy/{proxyId}/*` and pricing/status endpoints. Need to determine if there are concrete L402-gated endpoints we can register, or if this is primarily infrastructure tooling (like Stripe for Lightning).

We also need a cleanup pass to remove dead/zombie rows from tonight's discovery work.

## Part 1: WoT Scoring API Investigation

### Base URL: `https://wot.klabo.world`

### Step 1: Understand existing DB state (do NOT query locally)

We know from production queries that ~12+ WoT endpoints exist in the DB from Satring aggregation, most showing "degraded" with 400 errors. The existing entries likely have incorrect `http_method` (POST instead of GET) or are missing required query parameters in the URL.

**Do not attempt to query the local DB for existing entries — it won't have production data.** Instead, the fix script you write (Step 5) should use `ON CONFLICT(url, protocol) DO UPDATE` to handle any existing entries, and include a cleanup step that removes any wot.klabo.world entries that don't match the confirmed paid endpoint list (to clear out stale Satring entries for free endpoints or malformed URLs).

### Step 2: Fetch the OpenAPI spec

```bash
curl -s https://wot.klabo.world/openapi.json | node -e "
  const chunks = [];
  process.stdin.on('data', c => chunks.push(c));
  process.stdin.on('end', () => {
    const spec = JSON.parse(Buffer.concat(chunks).toString());
    console.log('Paths:', Object.keys(spec.paths || {}).length);
    for (const [path, methods] of Object.entries(spec.paths || {})) {
      for (const [method, detail] of Object.entries(methods)) {
        console.log(method.toUpperCase(), path, '-', detail.summary || '');
      }
    }
  });
"
```

### Step 3: Probe paid endpoints

The WoT API uses GET for most endpoints with query parameters. Paid endpoints (1-10 sats) return 402 with `WWW-Authenticate: L402` when the free tier is exhausted. You're probing from your local machine (not Railway), so you likely have 10 free requests per IP. You need to determine whether the 402 challenge fires on every request or only after the free tier is exhausted.

**Critical question: Does the API return 402 on every request, or only after the free tier is exhausted?**

Probe strategy — test a cheap endpoint both ways:

```bash
# First: does a bare GET return 402 or 200?
curl -s -D - "https://wot.klabo.world/score?pubkey=npub1placeholder000000000000000000000000000000000000000000000000" 2>&1 | head -20

# If it returns 200 (free tier), the health checker will mark it "healthy" even though
# it's really a freemium endpoint that only gates after 10/day.
# If it returns 402, we can register it normally.
```

**If the free tier returns 200:**
These endpoints will show as "healthy" to the health checker since it just checks for 402 + valid L402 headers. This is actually fine for our index — a freemium L402 endpoint is still an L402 endpoint. But we should note this in the description.

**If it returns 402 immediately:**
Standard L402 registration path. Verify `WWW-Authenticate` header has L402/LSAT scheme with macaroon and invoice.

Test across categories to confirm consistent behavior:

```bash
# Score (1 sat, GET)
curl -s -D - "https://wot.klabo.world/score?pubkey=npub1placeholder000000000000000000000000000000000000000000000000" 2>&1 | head -20

# Spam check (2 sats, GET)
curl -s -D - "https://wot.klabo.world/spam?pubkey=npub1placeholder000000000000000000000000000000000000000000000000" 2>&1 | head -20

# Audit (5 sats, GET)
curl -s -D - "https://wot.klabo.world/audit?pubkey=npub1placeholder000000000000000000000000000000000000000000000000" 2>&1 | head -20

# Batch endpoint (10 sats, POST)
curl -s -D - -X POST -H "Content-Type: application/json" \
  -d '{"pubkeys":["npub1placeholder000000000000000000000000000000000000000000000000"]}' \
  "https://wot.klabo.world/batch" 2>&1 | head -20

# Free endpoint (should be 200 always)
curl -s -D - "https://wot.klabo.world/top" 2>&1 | head -20
```

### Step 4: Determine what needs to happen with existing entries

After probing, categorize each existing DB entry:

**Category A — Valid L402 endpoint, correct in DB:**
→ Keep as-is (or update http_method/probe_body if wrong)

**Category B — Valid L402 endpoint, but needs fixes:**
→ Fix http_method (most WoT endpoints are GET, not POST)
→ Add/fix query parameter in URL if needed for probe
→ Note: GET endpoints generally don't need probe_body. But if the endpoint requires a query param like `?pubkey=...` to avoid a 400, we have a problem — our health checker sends the URL as stored. So either:
  - Store the URL with a test pubkey in the query string: `https://wot.klabo.world/score?pubkey=npub1placeholder000000000000000000000000000000000000000000000000`
  - Or if the endpoint returns 402 even without params, store it bare

**Category C — Free endpoint, not L402-gated:**
→ Remove from DB (DELETE health_checks first, then service)

**Category D — Invalid/broken URL:**
→ Remove from DB

### Step 5: Write cleanup + registration script

Create `scripts/fix-wot-endpoints.mjs` that:

1. Removes all existing wot.klabo.world entries (DELETE health_checks → DELETE services)
2. Re-registers only confirmed L402 paid endpoints with correct metadata
3. Does NOT register free endpoints (/top, /graph, /health, /stats, /metadata, /event, /external, /export, /relay, /authorized, /communities, /publish, /providers, /decay/top, /ws/scores)

Known paid endpoints from docs (verify each with probing):

| Path | Method | Price | Category |
|------|--------|-------|----------|
| /score | GET | 1 sat | utility |
| /decay | GET | 1 sat | utility |
| /nip05 | GET | 1 sat | utility |
| /personalized | GET | 2 sats | utility |
| /similar | GET | 2 sats | utility |
| /recommend | GET | 2 sats | utility |
| /compare | GET | 2 sats | utility |
| /nip05/reverse | GET | 2 sats | utility |
| /timeline | GET | 2 sats | utility |
| /spam | GET | 2 sats | utility |
| /verify | POST | 2 sats | utility |
| /weboftrust | GET | 3 sats | utility |
| /anomalies | GET | 3 sats | utility |
| /sybil | GET | 3 sats | utility |
| /predict | GET | 3 sats | utility |
| /audit | GET | 5 sats | utility |
| /trust-path | GET | 5 sats | utility |
| /reputation | GET | 5 sats | utility |
| /influence | GET | 5 sats | utility |
| /trust-circle | GET | 5 sats | utility |
| /trust-circle/compare | GET | 5 sats | utility |
| /follow-quality | GET | 5 sats | utility |
| /network-health | GET | 5 sats | utility |
| /compare-providers | GET | 5 sats | utility |
| /batch | POST | 10 sats | utility |
| /nip05/batch | POST | 5 sats | utility |
| /spam/batch | POST | 10 sats | utility |
| /sybil/batch | POST | 10 sats | utility |
| /influence/batch | POST | 10 sats | utility |

That's **29 paid endpoints** (24 GET, 5 POST).

For the upsert:
- `provider`: 'WoT Scoring'
- `source`: 'discovery'
- `payment_asset`: 'BTC'
- `payment_network`: 'Lightning'
- `category`: 'utility' (these are Nostr trust/identity tools)
- `http_method`: per endpoint (GET or POST)
- `probe_body`: null for GET endpoints, specific JSON for POST batch endpoints
- `name`: "WoT Scoring: {Endpoint Name}"
- `description`: from OpenAPI spec or docs

**Important for GET endpoints:** The URL stored in the DB is what the health checker probes. If the endpoint returns 400 without query params, you need to store the URL WITH a test pubkey param. If it returns 402 even without params, store it bare. Determine this from probing.

## Part 2: LightningEnable Investigation

### Base URL: `https://api.lightningenable.com`

### Step 1: Investigate L402 endpoints

**Do not query the local DB for existing entries — it won't have production data.** Any LightningEnable entries from Satring will be handled by the registration/cleanup script via upsert.

From the docs and screenshots, LightningEnable's L402 offering seems to be:
- `/api/l402/pricing` — GET pricing info (likely free/informational)
- `/api/l402/status` — GET auth status (likely free/informational)
- `/l402/proxy/{proxyId}/*` — The actual L402-protected proxy endpoint

The proxy is their core L402 product — it's a gateway that adds L402 paywalls to any API. This means their L402 endpoints aren't fixed — they're dynamic per-merchant proxies.

```bash
# Check if they have any demo/test endpoints
curl -s -D - https://api.lightningenable.com/api/l402/pricing 2>&1 | head -20
curl -s -D - https://api.lightningenable.com/api/l402/status 2>&1 | head -20

# Check .well-known
curl -s https://api.lightningenable.com/.well-known/l402-services | head -100

# Check their store page for concrete endpoints
curl -s https://api.lightningenable.com/store 2>&1 | head -200

# Check if they list sample proxy endpoints
curl -s -D - https://api.lightningenable.com/l402/proxy/demo 2>&1 | head -20
```

**Key question: Is LightningEnable a provider of L402 APIs, or a provider of L402 infrastructure?**

If it's purely infrastructure (like Stripe — they don't sell APIs, they enable others to sell APIs), then there are no endpoints to register. If they have their own demo/store L402 endpoints, register those.

### Step 3: Decision

Based on probing results:
- If LightningEnable has concrete L402-gated endpoints → create `scripts/register-lightningenable.mjs`
- If it's purely infrastructure → remove any existing DB entries that aren't L402-gated, note in journal that LightningEnable is infra-only
- Their payments/refunds/rates endpoints require API keys (`X-API-Key`), not L402 — do NOT register those

## Part 3: Dead Row Cleanup

Tonight's discovery work (batch provider investigation, new registrations) may have left orphaned or incorrect entries. **All DB operations must be packaged as scripts for Ryan to run on Railway.**

### Create `scripts/db-diagnostic.mjs`

Write a read-only diagnostic script that prints (but does NOT delete) the following:

1. **Services with zero health checks** (registered but never checked — LEFT JOIN health_checks WHERE NULL)
2. **Persistent failures** (consecutive_failures >= 7)
3. **`.well-known` zombie URLs** (url LIKE '%/.well-known/%')
4. **Duplicate URLs** (same URL appearing multiple times, GROUP BY url HAVING COUNT > 1)
5. **Non-L402 batch providers** that we confirmed are NOT L402-compliant from the previous batch investigation:
   - URLs matching: aiprox.dev, certvera.com, isitarug.com, lightningprox.com, lpxpoly.com, satsforai.com
   - These use LightningProx spend-token model, not standard L402

The script should print results grouped by category with counts. **Do NOT delete anything** — this is diagnostic only. Ryan will review the output and decide what to clean up.

### Create `scripts/cleanup-non-l402.mjs`

Write a separate cleanup script that removes confirmed non-L402 entries. This script should:

1. Find entries matching the non-L402 providers listed above (aiprox, certvera, isitarug, lightningprox.com, lpxpoly, satsforai)
2. For each: DELETE health_checks WHERE service_id = ?, then DELETE services WHERE id = ?
3. Wrap each deletion in try/catch for FK constraint resilience
4. Print what was removed with URLs and names
5. Print summary count

Ryan will run both scripts on Railway:
```
railway ssh -- node scripts/db-diagnostic.mjs
railway ssh -- node scripts/cleanup-non-l402.mjs
```

## Commit

Combine all work into a single commit:

```bash
git add scripts/fix-wot-endpoints.mjs scripts/db-diagnostic.mjs scripts/cleanup-non-l402.mjs
# Also add scripts/register-lightningenable.mjs if LightningEnable has L402 endpoints
git commit -m "WoT endpoint fix, LightningEnable investigation, DB diagnostic and cleanup scripts"
git push origin master
```

## Self-Landing

When finished, self-land per ~/agent-state/CLAUDE.md:
- Journal with descriptor (e.g., `journals/2026-03-06-wot-lightningenable-cleanup.md`)
- Update continuation.md with pending manual actions
- Append to status.md Recent Log
- `git add . && git commit && git push` the agent-state repo
- Never use bare `YYYY-MM-DD.md` for journal filenames. Never modify status.md top-level fields.

## Do NOT do these things

- Do not modify the health checker, aggregators, or web UI
- Do not run cleanup/registration against production — Ryan will do that via `railway ssh`
- Do not register free WoT endpoints (those aren't L402-gated)
- Do not register LightningEnable's API-key-gated merchant endpoints (those aren't L402)
- Do not auto-delete entries from the diagnostic without clear evidence they're wrong
- Do not register MaximumSats WoT endpoints again (those are already registered separately)

## Definition of Done

- WoT Scoring API fully investigated via live probing: which endpoints return L402 402, which are free, what query params are needed
- `scripts/fix-wot-endpoints.mjs` written — wipes stale Satring entries and re-registers confirmed L402 endpoints with correct http_method, URL (with query params if needed), and probe_body
- LightningEnable investigated via live probing: L402 endpoints identified or classified as infra-only
- `scripts/db-diagnostic.mjs` written — read-only diagnostic for Ryan to run on prod
- `scripts/cleanup-non-l402.mjs` written — removes confirmed non-L402 LightningProx entries
- All scripts use `process.env.DB_PATH || '/data/402index.db'` pattern (NOT hardcoded paths)
- All scripts tested locally (they'll run against local DB, which is fine for syntax/logic verification)
- Committed and pushed to master
- Agent-state landed
