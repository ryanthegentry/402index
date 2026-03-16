# CC Prompt: Sats4AI Endpoint Registration

## Context

402index.io is a registry of L402/x402 paid API endpoints. Sats4AI (sats4ai.com) is an L402 provider with 10 real API endpoints, but they're registered wrong in our database. The only entry we have is for their `.well-known/l402-services` discovery URL, which is a JSON document — not an L402-gated endpoint. The health checker probes it and gets 200 (it's just a JSON file), so it shows as degraded.

Sats4AI's `.well-known/l402-services` response (already fetched, pasting the key data) lists 10 actual L402-gated endpoints:

1. `https://sats4ai.com/api/l402/image` — Image Generation (100 sats)
2. `https://sats4ai.com/api/l402/text-generation` — Text Generation (21 sats)
3. `https://sats4ai.com/api/l402/sms` — SMS Messaging (1500 sats, dynamic)
4. `https://sats4ai.com/api/l402/video` — Video Generation (50 sats)
5. `https://sats4ai.com/api/l402/video-image` — Video from Image (100 sats)
6. `https://sats4ai.com/api/l402/music` — Music Generation (200 sats)
7. `https://sats4ai.com/api/l402/speech` — Speech Transcription (10 sats)
8. `https://sats4ai.com/api/l402/vision` — Image Analysis (21 sats)
9. `https://sats4ai.com/api/l402/3d-model` — 3D Model Generation (350 sats)
10. `https://sats4ai.com/api/l402/file-conversion` — File Conversion (100 sats)

All are POST-only with `Content-Type: application/json`. They also have an MCP server at `https://sats4ai.com/api/mcp`.

## Goal

Register all 10 Sats4AI endpoints correctly in the database so the health checker can verify them. Expected outcome: 10 new L402 healthy endpoints after the next health check cycle.

## Research Phase (Do This First)

Before writing any code, probe each of the 10 endpoints to confirm they return proper L402 402 responses:

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" -d '{}' https://sats4ai.com/api/l402/image
```

Do this for all 10. We expect 402 responses. For each 402, also check the response headers:

```bash
curl -s -D - -X POST -H "Content-Type: application/json" -d '{}' https://sats4ai.com/api/l402/image 2>&1 | head -20
```

Verify that the `WWW-Authenticate` header contains a valid L402 challenge with `macaroon=` and `invoice=` fields. Document what you find for each endpoint.

If any endpoints return something other than 402 (e.g., 406, 400, 200), note what they return and what additional headers or body they need. The `.well-known` response documents the expected request schemas — some may require specific fields in the POST body to trigger the 402 challenge.

## Implementation

### Step 1: Write a registration script

Create `scripts/register-sats4ai.mjs` that:

1. Connects to the SQLite database (same pattern as `scripts/apply-faucet-post.mjs` — `process.env.DB_PATH || '/data/402index.db'`)
2. For each of the 10 endpoints that returned valid 402 + L402 challenge in your research:
   - INSERT a new service row with:
     - `id`: generate a UUID (use `crypto.randomUUID()`)
     - `name`: from the `.well-known` response (e.g., "Sats4AI: Image Generation")
     - `description`: from the `.well-known` response
     - `url`: the actual endpoint URL (e.g., `https://sats4ai.com/api/l402/image`)
     - `protocol`: 'L402'
     - `price_sats`: from the `.well-known` pricing
     - `price_usd`: convert using a reasonable BTC/USD rate (~$90k) — just for initial data, health checker will update
     - `payment_asset`: 'BTC'
     - `payment_network`: 'Lightning'
     - `category`: map from service type (e.g., 'ai' for image/text/vision, 'communication' for SMS, 'media' for video/music, 'utility' for file conversion)
     - `provider`: 'Sats4AI'
     - `source`: 'well-known' (new source type — these came from automated discovery)
     - `http_method`: 'POST'
     - `health_status`: 'unknown' (let the health checker verify on next cycle)
   - Use `ON CONFLICT(url, protocol) DO UPDATE` in case any endpoints already exist

3. Handle the existing `.well-known` entry:
   - Find the existing entry: `SELECT id, url FROM services WHERE url LIKE '%sats4ai.com/.well-known%'`
   - Delete it — it's a discovery document, not an L402 endpoint
   - Print what was removed

4. Print a summary: how many registered, how many skipped, the old entry removed

### Step 2: Test locally

Run the script against the local dev database to verify it works:
```bash
node scripts/register-sats4ai.mjs
```

### Step 3: Verify the health checker will probe correctly

Read `src/health/checker.js` to confirm that L402 endpoints with `http_method='POST'` get probed with POST. This was added in the recent auto-detection work. Verify that:
- POST is sent with `Content-Type: application/json` and `{}` body (or empty body)
- The L402 validation parses `WWW-Authenticate` header for macaroon + invoice

If the health checker currently doesn't send `Content-Type: application/json` on POST probes, that might cause 406 from Sats4AI. If so, add it. But check first — this may already work.

### Step 4: Commit and push

Commit the registration script and any health checker changes:
```
git add scripts/register-sats4ai.mjs [any other changed files]
git commit -m "Add Sats4AI endpoint registration script (10 L402 endpoints from .well-known discovery)"
git push origin master
```

## Do NOT do these things
- Do not modify the aggregator polling system. This is a one-time registration script.
- Do not build a generic `.well-known` discovery aggregator (that's future work).
- Do not touch the web UI or API routes.
- Do not run the script against production — Ryan will do that via `railway ssh`.

## Self-Landing

When finished, self-land per ~/agent-state/CLAUDE.md:
- Journal with descriptor (e.g., `journals/2026-03-05-sats4ai-registration.md`)
- Update continuation.md with new pending manual action (Ryan needs to run the script on Railway)
- Append to status.md Recent Log
- `git add . && git commit && git push` the agent-state repo
- Never use bare `YYYY-MM-DD.md` for journal filenames. Never modify status.md top-level fields.

## Definition of Done
- All 10 Sats4AI endpoints probed and results documented
- Registration script written and tested locally
- Health checker confirmed to send correct headers for POST L402 probes (or patched if needed)
- Old `.well-known` entry cleaned up
- Committed and pushed to master
- Agent-state landed
