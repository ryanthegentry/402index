# Health Checker Gap Analysis

Compares current `src/health/checker.js` implementation against `docs/HEALTH-CHECKER-SPEC.md`. Production data from March 4, 2026.

## Production Data Summary

| Metric | Value |
|--------|-------|
| x402 endpoints | 13,588 |
| x402 payment_valid=1 | 92 (0.7%) |
| x402 payment_valid=0 | 12,270 (90.3%) |
| x402 payment_valid=NULL | 1,226 (9.0%) |
| L402 endpoints | 120 |
| L402 healthy | 7 (5.8%) |
| L402 degraded | 110 (91.7%) |
| L402 down | 3 (2.5%) |
| Health check pass duration | ~16 min |
| Health check interval | 15 min |

L402 HTTP status distribution from health checks:
- 200: 44% | 400: 18% | 429: 13% | 405: 6% | 402: 5% | Other: 14%

---

## Gap 1: x402 payment_valid NULL for Non-402 Responses

**Severity: Critical**

**Spec says:** `x402_payment_valid` should be 0 after any check where the endpoint doesn't return valid payment requirements. NULL means "never checked."

**Current behavior:** `checker.js:386-434` — the entire x402 validation block is guarded by `if (protocol === 'x402' && httpResult.httpStatus === 402)`. If an x402 endpoint returns 200, 404, 500, or times out, `x402PaymentValid` stays `null`. The `persistHealthResult` call at line 358 writes `x402_payment_valid: x402PaymentValid ?? null`, preserving the NULL.

**Impact:** 1,226 x402 endpoints (9%) have NULL payment_valid after being checked. These are endpoints that never returned 402 — their paywall is broken or nonexistent, but the database doesn't distinguish them from never-checked endpoints.

**Fix:** After the x402 validation block (line 434), add:
```javascript
if (protocol === 'x402' && x402PaymentValid === null) {
  x402PaymentValid = 0
}
```

This ensures every checked x402 endpoint has payment_valid = 0 or 1, never NULL.

---

## Gap 2: L402 Endpoints Returning 200 (44% of Checks)

**Severity: Important**

**Spec says:** 200 from an L402 endpoint = paywall not enforced = degraded.

**Current behavior:** `classifyHealthStatus()` at line 237 correctly marks 200 as `degraded`. However, 44% of L402 health checks see status 200. This is abnormally high and warrants investigation.

**Likely causes:**
1. **http_method mismatch:** Many L402 endpoints are POST-only APIs. HEAD/GET to a POST endpoint may return 200 (with docs/welcome page) instead of 402.
2. **Aggregator data:** Neither Satring nor L402Apps sets `http_method`, so all default to GET. The health checker then sends HEAD → GET, never POST.

**Impact:** 44% of L402 endpoints show as degraded when they may actually be healthy POST endpoints with working paywalls.

**Fix (partial):** See Gap 5 (http_method auto-detection). Full fix requires aggregator enrichment or manual curation.

### Related: Non-Standard L402 Implementations (Mar 5 discovery)

Lightning Faucet (lightningfaucet.com) returns L402 challenges in JSON body with HTTP 429 — not the spec-compliant 402 + `WWW-Authenticate` header. Multiple endpoints (~20+ via Satring) are affected. The health checker correctly classifies these as `rate_limited`/`degraded`. This is correct behavior: "payment-verified" means a spec-compliant client can pay automatically, and these endpoints would break standard L402 client libraries.

**Outreach opportunity:** Contact Lightning Faucet to suggest returning 402 + `WWW-Authenticate: L402 macaroon="...", invoice="..."`. Their flow is functionally L402 (invoice + macaroon + preimage) but breaks interop. If fixed, ~20 endpoints could flip from degraded to healthy.

---

## Gap 3: L402 Endpoints Returning 400/429/405

**Severity: Important**

**Spec says:**
- 429 = rate limited by provider, skip this cycle, retain previous health_status
- 405 = Method Not Allowed, signal to retry with POST
- 400 = Bad Request, often means wrong method or missing required params

**Current behavior:** All three are classified as `degraded` by the catch-all at line 252 (`other status codes → degraded`). No distinction between rate limiting, method errors, and genuine failures.

**Production impact:**
- 429 (13%): Provider is rate-limiting our probe. We punish them for our aggressive checking.
- 405 (6%): Endpoint doesn't accept HEAD/GET. Should retry with POST.
- 400 (18%): May indicate POST-only endpoint or missing required parameters.

**Fix:** Update `classifyHealthStatus()`:
```javascript
if (httpStatus === 429) {
  return { healthStatus: prevHealthStatus || 'unknown', checkStatus: 'rate_limited', consecutiveFailures: prevFailures || 0 }
}
if (httpStatus === 405) {
  return { healthStatus: 'degraded', checkStatus: 'method_not_allowed', consecutiveFailures: prevFailures || 0 }
}
```

429 should preserve previous health_status (not punish) and log the rate limit. 405 should trigger http_method auto-detection (Gap 5).

---

## Gap 4: Back-to-Back Health Checks (15-min Interval, 16-min Pass)

**Severity: Important**

**Spec says:** Health check interval should provide an idle gap between passes. Recommended: 60 minutes.

**Current behavior:** `scheduler.js:71` sets interval to `HEALTH_CHECK_INTERVAL_MS || 900000` (15 min). Each pass takes ~16 minutes (13,700 endpoints / 10 concurrent / 5s timeout). The next pass starts as soon as the interval fires, which means checks run nearly continuously.

**Impact:**
- Excessive requests to providers → 429 rate limiting (13% of L402 checks)
- Unnecessary disk I/O and volume growth
- No idle time for the process

**Fix:** Change default interval to 3600000 (1 hour). This gives ~44 minutes of idle between passes. Volume growth drops 4x.

---

## Gap 5: http_method Not Set by Aggregators

**Severity: Important**

**Spec says:** Health checker should use the endpoint's expected HTTP method. POST endpoints probed with HEAD/GET return wrong status codes.

**Current behavior:** `performHttpCheck()` at line 148 uses `http_method || 'GET'`. But:
- Bazaar aggregator (`bazaar.js`): does NOT set http_method
- Satring aggregator (`satring.js`): does NOT set http_method
- L402Apps aggregator (`l402apps.js`): does NOT set http_method
- Sponge aggregator (`sponge.js`): does NOT set http_method

All aggregated endpoints default to GET. Many L402 inference/payment APIs are POST-only.

**Impact:** POST-only endpoints get HEAD/GET probes → 200/400/405 → classified as degraded. This explains the high degraded rate for L402 (110 of 120 endpoints).

**Fix:** Auto-detect http_method when 405 is received:
1. On 405 response, retry with POST
2. If POST returns 402, persist `http_method = 'POST'` for future checks
3. Never override manually-set http_method from registration

---

## Gap 6: Retention Mismatch (3 Days vs 1 Day)

**Severity: Moderate**

**Spec says:** Retention should be consistent. `uptime_30d` queries should match actual data availability.

**Current behavior:**
- `checker.js:11` defines `HEALTH_CHECK_RETENTION_DAYS = 3`
- `checker.js:457-466` prunes at 3-day retention (runs before each health check pass)
- `db.js:287` prunes at 1-day retention (runs hourly via `setInterval`)
- The db.js prune wins because it runs more frequently

**Impact:**
- `getUptime()` at `checker.js:117-124` queries `'-30 days'` but only ~1 day of data exists
- `uptime_30d` metric is really "uptime_1d" — reliability_score uptime component is misleading
- `calculateP50()` at line 126-131 queries last 20 latencies, which with 1-day retention and 15-min intervals = ~96 checks/day = sufficient, but barely

**Fix:** Align both to 3 days. Change db.js prune query to match checker.js constant. Change `getUptime()` query from `-30 days` to `-3 days`.

---

## Gap 7: HEAD → GET Retry Duplicates Request for x402

**Severity: Moderate**

**Spec says:** Use HEAD-vs-GET cache to avoid redundant retries.

**Current behavior:** `performHttpCheck()` at line 194 retries with GET when HEAD doesn't return 402. Then `checkService()` at line 397-412 does ANOTHER GET retry specifically for x402 PAYMENT-REQUIRED header validation if HEAD returned 402 but without the header. This is correct but means some x402 endpoints get 3 HTTP requests per check (HEAD + GET + GET).

Additionally, there's no per-endpoint caching of "this endpoint requires GET." The `x402_head_no_payment` column mentioned in the spec doesn't exist in the schema. Every check cycle re-discovers the HEAD limitation.

**Impact:** 3 requests per x402 endpoint per check × 13,588 endpoints = ~40,764 requests. With caching, could be ~13,588 (just GET for known HEAD-incompatible endpoints).

**Fix:** Add `x402_head_no_payment INTEGER DEFAULT 0` column. Set to 1 when HEAD returns 402 without PAYMENT-REQUIRED but GET has it. Skip HEAD for these endpoints on subsequent checks.

---

## Gap 8: No Per-Protocol Logging

**Severity: Moderate**

**Spec says:** Log per-protocol breakdown: `[health] L402: X healthy, Y degraded, Z down | x402: ...`

**Current behavior:** `runHealthChecks()` at line 540 logs only aggregate counts: `healthy=X degraded=Y down=Z unknown=W`. No per-protocol breakdown. The `checkService()` return value at line 448 includes `healthStatus` and `httpStatus` but not `protocol`.

**Impact:** Can't diagnose protocol-specific issues from logs. When L402 degraded rate is 92%, you'd want to see that in the log — not buried in overall stats that are dominated by 13,588 x402 endpoints.

**Fix:** Return `protocol` from `checkService()`. Accumulate per-protocol stats in `runHealthChecks()`. Log both aggregate and per-protocol breakdown.

---

## Gap 9: No Error Detail Logging

**Severity: Low**

**Spec says:** Log error details for first N errors per cycle.

**Current behavior:** Errors are counted via `results.error++` at line 531 (rejected promises from `checkService`). The error itself is not logged. For fulfilled-but-degraded results, no details are logged either.

**Impact:** When investigating degraded services, must query the database. Can't diagnose issues from server logs alone.

**Fix:** Log first 10 errors per cycle with URL, protocol, and error message. Optionally log per-host rate-limited counts.

---

## Gap 10: No Per-Host Rate Limiting Awareness

**Severity: Low (deferred)**

**Spec says:** Group endpoints by hostname with per-host delays and concurrency limits.

**Current behavior:** `CONCURRENCY=10` batches process endpoints in insertion order (from `getServices()` query). No grouping by host. If 500 endpoints share the same hostname, they get checked sequentially across 50 batches with no inter-request delay to that host.

**Impact:** Providers with many endpoints (e.g., Bazaar-sourced services sharing api.example.com) get hammered. Causes 429s. However, with the recommended 1-hour interval (Gap 4), this becomes less severe.

**Fix (deferred):** Sort services by hostname, distribute across batches so no two consecutive entries share a host. Add 1-second minimum delay between requests to the same host. This is a significant refactor — defer to Phase 4.

---

## Summary

| # | Gap | Severity | Fix Complexity | Phase |
|---|-----|----------|---------------|-------|
| 1 | x402 NULL → 0 for non-402 | Critical | One line | 3 |
| 2 | L402 200 responses (44%) | Important | Needs investigation + http_method | 3-4 |
| 3 | 429/405/400 handling | Important | ~15 lines in classifyHealthStatus | 3 |
| 4 | Back-to-back checks | Important | One line (interval change) | 3 |
| 5 | http_method auto-detection | Important | ~30 lines + migration | 4 |
| 6 | Retention mismatch | Moderate | Two line changes | 3 |
| 7 | HEAD→GET caching | Moderate | Migration + ~20 lines | 4 |
| 8 | Per-protocol logging | Moderate | ~10 lines | 3 |
| 9 | Error detail logging | Low | ~10 lines | 3 |
| 10 | Per-host rate limiting | Low | Significant refactor | 4+ |

**Phase 3 (this session):** Gaps 1, 3, 4, 6, 8, 9
**Phase 4 (future):** Gaps 2, 5, 7, 10
