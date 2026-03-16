# CC Prompt: Per-Host Rate Limiting + FK Resilience + Faucet Probe Bodies + Satring .well-known Filter

## Context

402index.io has a health checker that probes ~13,900 endpoints every hour in batches of 10 concurrent requests. Four issues need fixing in this session:

1. **Per-host rate limiting:** The batching is host-blind. 25 endpoints from `lightningfaucet.com` fire nearly simultaneously, triggering their rate limiter. 13 of 25 get 429 → degraded.
2. **FK constraint resilience:** Deleting a service mid-health-check causes an unhandled FOREIGN KEY error.
3. **Lightning Faucet probe bodies:** 8 Faucet endpoints return 400 because they require specific request bodies (like Sats4AI). We have the full API catalog from `https://lightningfaucet.com/build/api-catalog` documenting required parameters for each endpoint.
4. **Satring re-imports deleted .well-known entries:** We deleted the `sats4ai.com/.well-known/l402-services` entry (it's a discovery document, not an L402 endpoint), but the Satring aggregator re-imported it on the next sync cycle. Need to filter `.well-known` URLs in the aggregator.

Production evidence (2026-03-05):
```
healthy POST 402 healthy Lightning Faucet BTC Price Oracle
degraded POST 429 rate_limited Lightning Faucet Bid Board
degraded POST 429 rate_limited Lightning Faucet Dad Jokes
degraded POST 429 rate_limited Lightning Faucet Entropy
degraded POST 400 degraded Lightning Faucet Invoice Decoder
degraded POST 400 degraded Lightning Faucet Keyword Extraction
degraded POST 400 degraded Lightning Faucet LLM Prompt
degraded POST 400 degraded Lightning Faucet LNURL Metadata
degraded POST 400 degraded Lightning Faucet Memory Bank
degraded POST 400 degraded Lightning Faucet Profanity Filter
degraded POST 400 degraded Lightning Faucet Sentiment Analysis
degraded POST 400 degraded Lightning Faucet Text Summarizer
```

## Goal

After this session + one health check cycle, ALL 25 Lightning Faucet endpoints should show healthy (currently only 1 does). Combined with the 9 Sats4AI endpoints, this should bring L402 healthy to ~35+.

## Gap 7: Per-Host Rate Limiting

**File:** `src/health/checker.js`, function `runHealthChecks()` (lines 601-673)

### Current Behavior

```javascript
// Lines 624-628 — the problem
for (let i = 0; i < services.length; i += CONCURRENCY) {
  const batch = services.slice(i, i + CONCURRENCY)
  const batchResults = await Promise.allSettled(
    batch.map(s => checkService(s))
  )
  ...
}
```

Services are checked in database order. All endpoints from the same provider tend to be adjacent (they were inserted together by an aggregator). A batch of 10 can contain 10 endpoints from the same host → instant rate limit.

### Required Behavior

No single host should be probed more than once per second. The simplest approach:

**Shuffle + per-host delay:**

1. Before the batch loop, shuffle the services array randomly. This distributes same-host endpoints across the full check cycle rather than clustering them.
2. Track the last probe timestamp per hostname. Before probing, check if this host was probed in the last N milliseconds. If so, delay.

Implementation:

```javascript
const PER_HOST_MIN_INTERVAL_MS = 1000 // minimum 1 second between probes to the same host

// Shuffle services to distribute same-host endpoints
function shuffleArray(arr) {
  const shuffled = [...arr]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}

// Track last probe time per host
const hostLastProbe = new Map()

function getHostname(url) {
  try { return new URL(url).hostname } catch { return url }
}

async function waitForHost(hostname) {
  const lastProbe = hostLastProbe.get(hostname)
  if (lastProbe) {
    const elapsed = Date.now() - lastProbe
    if (elapsed < PER_HOST_MIN_INTERVAL_MS) {
      await new Promise(r => setTimeout(r, PER_HOST_MIN_INTERVAL_MS - elapsed))
    }
  }
  hostLastProbe.set(hostname, Date.now())
}
```

Then modify `checkService` (or the call site) to call `waitForHost` before `performHttpCheck`:

```javascript
async function checkService(service) {
  const hostname = getHostname(service.url)
  await waitForHost(hostname)
  // ... rest of existing checkService logic
}
```

Clear the `hostLastProbe` map at the start of each `runHealthChecks()` cycle.

### Performance Impact

With 13,900 endpoints and ~550 distinct hosts, most hosts have 1-2 endpoints (especially x402 Bazaar). The shuffle means same-host endpoints are spread across the full check cycle. The 1-second delay only fires when two same-host endpoints happen to land in the same or adjacent batches — which after shuffling is rare for most hosts.

For Lightning Faucet (25 endpoints spread across ~1,400 batches after shuffle), the delay adds at most ~25 seconds total. For the full check cycle (~12 minutes currently), this is negligible.

### Testing

Write tests for:
1. `shuffleArray` produces a different order (statistical — run twice, compare, at least one element differs for arrays of length >= 10)
2. `getHostname` extracts hostname from various URL formats
3. `waitForHost` enforces minimum interval (mock Date.now, verify delay is applied)
4. Integration test: create 10 mock services from the same host, run them through the batch loop, verify they aren't all probed within the same second

## Gap 8: FK Constraint Resilience

**File:** `src/health/checker.js`, function `persistHealthResult()` (lines 362-392)

### Current Behavior

If the `services` row is deleted between when the health check reads the service list and when it tries to INSERT the health_check record, the FK constraint fails and the error bubbles up as an unhandled rejection.

Production evidence:
```
[health]   L402 https://sats4ai.com/.well-known/l402-services: FOREIGN KEY constraint failed
```

### Fix

Wrap the entire `persistHealthResult` function body in a try/catch. On FK constraint failure, log a warning and return gracefully:

```javascript
function persistHealthResult(serviceId, params) {
  try {
    // ... existing INSERT + UPDATE logic
  } catch (err) {
    if (err.message && err.message.includes('FOREIGN KEY constraint failed')) {
      console.warn(`[health] Service ${serviceId} was deleted during check — skipping persist`)
      return
    }
    throw err // Re-throw non-FK errors
  }
}
```

### Testing

1. Insert a service, delete it, then call `persistHealthResult` — should log a warning, not throw
2. Non-FK errors still propagate

## Gap 9: Lightning Faucet Probe Bodies

**File:** New script `scripts/update-faucet-probe-bodies.mjs`

### Background

8 Lightning Faucet endpoints return 400 because they require specific request body fields to trigger the L402 challenge (same pattern as Sats4AI). The full API catalog at `https://lightningfaucet.com/build/api-catalog` documents required parameters.

All Faucet endpoints use: `POST`, `Content-Type: application/json`, base URL `https://lightningfaucet.com/api/l402/`

### Research Phase (Do This First)

Before writing the update script, probe each of the 8 failing endpoints with the expected body from the catalog to confirm they return 402 + valid L402 challenge:

**Endpoints returning 400 that need probe bodies:**

1. `l402/invoice_decode` — Required: `{"invoice": "<bolt11>"}`. Use a dummy bolt11: `{"invoice": "lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq8rkx3yf5tcsyz3d73gafnh3cax9rn449d9p5uxz9ezhhypd0elx87sjle52x86fux2ypatgddc6k63n7erqz25le42c4u4ecky03ylcqca784w"}`
2. `l402/keywords` — Required: `{"text": "...", "count": N}`. Use: `{"text": "Bitcoin Lightning Network L402 protocol test", "count": 3}`
3. `l402/llm_prompt` — Required: `{"prompt": "..."}`. Use: `{"prompt": "test"}`
4. `l402/lnurl_metadata` — Required: `{"lnurl": "..."}`. Use: `{"lnurl": "lnurl1dp68gurn8ghj7em9w3skccne9e3k7mf09emk2mrv944kummhdchkcmn4wfk8qtmsdqhf6mm4d9hxwt"}`
5. `l402/memory` — Required: `{"agent_id": "...", "mode": "list"}`. Use: `{"agent_id": "402index-probe", "mode": "list"}`
6. `l402/profanity_filter` — Required: `{"text": "...", "mode": "check"}`. Use: `{"text": "hello world test", "mode": "check"}`
7. `l402/sentiment` — Required: `{"text": "..."}`. Use: `{"text": "Bitcoin is great"}`
8. `l402/summarize_title` — Required: `{"text": "...", "max_words": N}`. Use: `{"text": "Bitcoin is a decentralized digital currency", "max_words": 5}`

For each, run:
```bash
curl -s -D - -X POST -H "Content-Type: application/json" -d '<body>' https://lightningfaucet.com/api/l402/<endpoint> 2>&1 | head -20
```

Confirm each returns 402 + `WWW-Authenticate: L402` header with valid macaroon and invoice.

If any endpoint STILL returns 400 with the expected body, try variations (the catalog may be slightly out of date). Document what you find.

### Implementation

Create `scripts/update-faucet-probe-bodies.mjs` following the same pattern as `scripts/register-sats4ai.mjs` and `scripts/apply-faucet-post.mjs`:

```javascript
import Database from 'better-sqlite3'

const dbPath = process.env.DB_PATH || '/data/402index.db'
const db = new Database(dbPath)

// Map of URL suffix → probe_body (only for endpoints that need one)
const probeBodyMap = {
  'invoice_decode': '{"invoice":"lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq8rkx3yf5tcsyz3d73gafnh3cax9rn449d9p5uxz9ezhhypd0elx87sjle52x86fux2ypatgddc6k63n7erqz25le42c4u4ecky03ylcqca784w"}',
  'keywords': '{"text":"Bitcoin Lightning Network L402 protocol test","count":3}',
  'llm_prompt': '{"prompt":"test"}',
  'lnurl_metadata': '{"lnurl":"lnurl1dp68gurn8ghj7em9w3skccne9e3k7mf09emk2mrv944kummhdchkcmn4wfk8qtmsdqhf6mm4d9hxwt"}',
  'memory': '{"agent_id":"402index-probe","mode":"list"}',
  'profanity_filter': '{"text":"hello world test","mode":"check"}',
  'sentiment': '{"text":"Bitcoin is great"}',
  'summarize_title': '{"text":"Bitcoin is a decentralized digital currency","max_words":5}',
}
```

For each entry in `probeBodyMap`:
1. Find the service by URL pattern: `WHERE url LIKE '%lightningfaucet.com/api/l402/<suffix>' AND protocol = 'L402'`
2. UPDATE the `probe_body` column
3. Print before/after for verification

Also handle the duplicate `keyword` vs `keywords` entry — the health check output shows both `Lightning Faucet: Keyword Extraction` (url ending `keyword`) returning 404 and `Lightning Faucet Keyword Extraction` (url ending `keywords`). The 404 one may be a bad URL in the database. Check both and only set probe_body on the one that actually resolves.

Print a summary at the end: how many updated, final L402 health stats.

### Important: Adjust probe bodies based on research

The probe body values above are my best guesses from the API catalog. **CC must verify each one with curl before hardcoding.** If a probe body doesn't trigger 402, iterate:
- Try with fewer fields (maybe only the required ones)
- Try with different dummy values
- Check if the endpoint name in the URL differs from the catalog (e.g., `keywords` vs `keyword`)

The goal is: every Faucet endpoint that's currently returning 400 should return 402 with the correct probe body. Document any endpoints that can't be fixed (they may be genuinely broken).

### Testing

After writing the script, test it locally against the dev database (it should run without errors even if the endpoints don't exist locally — just print 0 updated). The real test is running it on Railway and waiting for the next health check.

## Gap 10: Satring Re-Imports .well-known Discovery URLs

**File:** `src/aggregators/satring.js` and/or `src/aggregators/satring-utils.js`

### Problem

We deleted the `sats4ai.com/.well-known/l402-services` entry because it's a discovery document, not an L402 endpoint. But the Satring aggregator re-imported it on the very next sync cycle — the deploy log shows `[satring] Synced 111 services from Satring (1 new, 110 updated)` and the re-inserted entry shows as degraded on the site.

This will happen every hour forever unless we filter it.

### Fix

Add a URL skip list in the Satring polling loop (`src/aggregators/satring.js`). Before upserting a service, check if the URL contains `/.well-known/` and skip it:

```javascript
// In the for loop that processes services (around line 71-80 of satring.js)
const normalized = normalizeRawService(svc, getCachedBtcUsdRate())

// Skip discovery/well-known URLs — these are metadata documents, not L402 endpoints
if (normalized.url.includes('/.well-known/')) {
  continue
}
```

This is a general filter, not Sats4AI-specific. Any `.well-known` URL from any source is a discovery document, not a paywall endpoint.

Also apply the same filter in `src/aggregators/l402apps.js` if it has a similar polling loop — check if l402apps could also import .well-known URLs.

### After applying

The existing stale entry needs to be cleaned up. Add this to the `scripts/update-faucet-probe-bodies.mjs` script (or create a separate one-liner): delete any services where `url LIKE '%/.well-known/%'` and `source` is an aggregator (not 'well-known' source — those are the proper entries we registered ourselves).

### Testing

Add a test to satring-utils or satring aggregator tests: verify that a service with URL containing `/.well-known/` is skipped during sync.

## Commit

Single commit with all four fixes:
```
git add -A
git commit -m "Per-host rate limiting, FK resilience, Faucet probe bodies, filter .well-known from aggregators"
git push origin master
```

## Do NOT do these things
- Do not change the CONCURRENCY constant (keep at 10)
- Do not change the health check interval (keep at 1 hour)
- Do not change the batch processing from Promise.allSettled to anything else — keep the same pattern, just add the shuffle and per-host delay
- Do not modify the Sats4AI registration script or probe bodies
- Do not register new endpoints — only update probe_body on existing Faucet endpoints
- Do not delete the 10 Sats4AI endpoints registered via 'well-known' source — only filter aggregator-imported .well-known URLs

## Self-Landing

When finished, self-land per ~/agent-state/CLAUDE.md:
- Journal with descriptor (e.g., `journals/2026-03-05-host-rate-limiting.md`)
- Update continuation.md
- Append to status.md Recent Log
- `git add . && git commit && git push` the agent-state repo
- Never use bare `YYYY-MM-DD.md` for journal filenames. Never modify status.md top-level fields.

## Definition of Done
- Services are shuffled before health check cycle begins
- Per-host delay of ≥1 second enforced between requests to the same hostname
- `persistHealthResult` handles FK constraint failures gracefully (log + skip)
- Lightning Faucet probe bodies researched (curl each), verified to trigger 402, and update script written
- `.well-known` URLs filtered from Satring (and l402apps if applicable) aggregator imports
- Stale `.well-known` aggregator entry cleaned up in the update script
- All new tests pass
- Full test suite passes (`npm test`)
- Committed and pushed to master
- **Ryan's manual step after deploy:** `railway ssh -- node scripts/update-faucet-probe-bodies.mjs`
- **Expected post-health-check result:** L402 healthy ~30+ (up from current 20). Breakdown: ~17 Faucet no-body endpoints (currently 429, should become 402 after shuffle), ~8 Faucet with-body endpoints (currently 400, should become 402 with probe bodies), 9 Sats4AI, ~3 existing (L402 Apps, Mutinynet, Qwen). SMS stays degraded (Sats4AI server bug). Stale .well-known entry removed.
