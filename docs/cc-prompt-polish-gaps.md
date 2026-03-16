# CC Prompt: Polish Pass — Close Documentation, UI, and Code Gaps

## Context

402index.io just shipped probe_body support, Sats4AI registration, and Lightning Faucet POST fixes. L402 healthy is about to jump from 5 to ~37. Before we promote the site more widely, there are several small gaps in documentation, the About/Methodology page, API docs, the /register endpoint, and health checker status classification that need closing. None of these are individually large, but together they leave the site inconsistent.

This is a polish pass. No new features. Every change should make the existing system more accurate, complete, and consistent.

## Gap 1: About/Methodology Page is Stale

**File:** `src/views/about.js`

### Problem
The About page has several inaccuracies:

1. Line 35: Says "health-checked every 15 minutes" — should be "every hour" (changed in the Mar 4 session)
2. Lines 43-44: Says "we check every endpoint ourselves, every 15 minutes" — same stale interval
3. Lines 59-62: L402 methodology says "we send an HTTP request" — doesn't mention POST-only endpoints, endpoint-specific probe bodies, or method detection
4. No mention of sources "L402 Apps", "Sponge", "Well-Known" — only lists Bazaar, Satring, and Exclusive
5. The registration example in the "For API providers" section (lines 120-127) doesn't mention `http_method` parameter

### Fix
1. Change all "15 minutes" references to "every hour"
2. Expand L402 methodology to: "For L402 endpoints: we send an HTTP request using the endpoint's configured method (GET or POST) and confirm the service returns 402 Payment Required with a valid WWW-Authenticate: L402 header containing a properly formatted macaroon/token and a BOLT11 Lightning invoice. Some endpoints require POST with specific request bodies to trigger the paywall — we support per-endpoint probe configuration to handle these cases."
3. Add missing sources to the "How it works" section:
   - **L402 Apps** — An aggregator of L402 service directories
   - **Sponge** — PaySponge catalog of x402-enabled agent wallet services
   - **Well-Known** — Endpoints discovered via `.well-known/l402-services` (an emerging L402 discovery convention)
   - **Self-registered** — Endpoints submitted via our registration API, verified automatically, and reviewed before going live
4. Update the curl registration example to include `http_method: "POST"` as an optional field

## Gap 2: API Docs Missing probe_body

**File:** `src/views/api-docs.js`

### Problem
1. The `/register` endpoint docs don't include `probe_body` as an optional parameter
2. The CSV columns list doesn't include `probe_body`
3. The JSON response sample (lines 144-175) doesn't show `probe_body` field

### Fix
1. Add `probe_body` row to the register endpoint params table:
   ```
   probe_body | string | JSON body to send when probing this endpoint. Required for services that validate request bodies before issuing L402 challenges. Default: '{}'
   ```
2. No change to CSV columns — `probe_body` is an internal health-check field, not useful in CSV export. Skip this.
3. No change to JSON response sample — `probe_body` is not in API_COLUMNS and shouldn't be exposed to consumers. The probe body is an internal implementation detail. Skip this.

## Gap 3: /register Endpoint Doesn't Accept probe_body

**File:** `src/routes/api.js`

### Problem
The register endpoint (lines 264-335) accepts `http_method` but not `probe_body`. If someone tries to register a Sats4AI-style endpoint that requires a specific POST body to trigger 402, the verification probe sends `{}` (hardcoded in `l402-verify.js` line 58), gets 406, and registration fails with a misleading "L402 verification failed" error.

### Fix
1. Add `probe_body` to MAX_LENGTHS: `probe_body: 10000` (generous but bounded — probe bodies are JSON)
2. Validate probe_body if present: must be valid JSON string. Parse it to verify, reject if invalid.
3. Pass probe_body to `verifyL402()` — see Gap 4 below
4. Include probe_body in the params object passed to registerUpsert (line 292-306)
5. Update the registerUpsert prepared statement to include probe_body in the INSERT and ON CONFLICT UPDATE

## Gap 4: verifyL402 Doesn't Use probe_body

**File:** `src/services/l402-verify.js`

### Problem
`verifyL402(url, httpMethod)` hardcodes `body: '{}'` on line 58. When the register endpoint passes `probe_body`, it's ignored.

### Fix
1. Add a third parameter: `verifyL402(url, httpMethod = 'GET', probeBody = '{}')`
2. Use `probeBody` instead of `'{}'` on line 58: `fetchOptions.body = probeBody`
3. Update the call in `src/routes/api.js` line 276: `verifyL402(url, httpMethod, body.probe_body || '{}')`

## Gap 5: 406 Response Not Classified in Health Checker

**File:** `src/health/checker.js`, function `classifyHealthStatus()`

### Problem
The classifier handles 402, 200, 500+, 429, 405 explicitly, but 406 falls through to the generic "Other status codes" catch-all (line 282) and gets `checkStatus: 'degraded'`. This is fine functionally but provides no diagnostic signal. If Sats4AI's probe bodies become stale (e.g., they rename models), endpoints will silently degrade to 'degraded' with no indication that the issue is a body mismatch.

### Fix
Add a 406 case after the 405 case (line 279):

```javascript
// 406 = Not Acceptable. Usually means the probe body is wrong or stale.
if (httpStatus === 406) {
  return { healthStatus: 'degraded', checkStatus: 'not_acceptable', consecutiveFailures: prevFailures || 0 }
}
```

Also update the CHECK constraint on the health_checks table status column to include 'not_acceptable'. Look at how the previous migration for 'rate_limited' and 'method_not_allowed' was done (search for `ALTER TABLE health_checks` or CHECK constraint migration in db.js) and follow the same pattern.

## Gap 6: Stale Numbers in Status References

**File:** `src/views/about.js`

### Problem
The "endpoints indexed" and "payment-verified" explanations are accurate but don't mention the well-known discovery source. Not a blocking issue but worth updating for completeness since it's mentioned in the same paragraph as sources.

### Fix
Already covered in Gap 1 fix (adding well-known to sources list). No additional changes needed.

## Testing

Write tests for:
1. **probe_body validation in register endpoint:** test that invalid JSON is rejected, valid JSON is accepted, missing probe_body defaults to `{}`
2. **verifyL402 with probe_body:** test that the probe body is sent in the POST request (mock fetch to verify)
3. **406 classification:** test that `classifyHealthStatus(406, null, 0, null, 100)` returns `{ healthStatus: 'degraded', checkStatus: 'not_acceptable', consecutiveFailures: 0 }`

Run the full test suite after all changes: `npm test`

## Commit

Single commit with all changes:
```
git add -A
git commit -m "Polish: close docs/UI/code gaps for probe_body, 406 handling, methodology, and register endpoint"
git push origin master
```

## Do NOT do these things
- Do not add probe_body to API_COLUMNS or CSV export — it's an internal health-check field
- Do not build a generic .well-known aggregator — that's future work
- Do not change health check intervals or retention
- Do not modify the Sats4AI or Lightning Faucet registration scripts
- Do not touch the stats bar, scoreboard, or homepage layout

## Self-Landing

When finished, self-land per ~/agent-state/CLAUDE.md:
- Journal with descriptor (e.g., `journals/2026-03-05-polish-gaps.md`)
- Update continuation.md
- Append to status.md Recent Log
- `git add . && git commit && git push` the agent-state repo
- Never use bare `YYYY-MM-DD.md` for journal filenames. Never modify status.md top-level fields.

## Definition of Done
- About page has correct health check interval (1 hour), expanded L402 methodology, all 7 sources listed, registration example shows http_method
- API docs show probe_body as optional register parameter
- /register endpoint accepts, validates, stores, and passes probe_body to verifyL402
- verifyL402 uses probe_body instead of hardcoded '{}'
- Health checker classifies 406 as 'not_acceptable'
- All new tests pass
- Full test suite passes (`npm test`)
- Committed and pushed to master
