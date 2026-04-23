# Paywithlocus Gateway Health Diagnosis

**Date:** 2026-04-23
**Issue:** #229 (supersedes #227)
**Investigator:** Claude (automated diagnosis)

## Summary

254 `*.mpp.paywithlocus.com` rows in prod are predominantly `degraded`. Root cause: the paywithlocus gateway validates request parameters **before** presenting the MPP 402 payment challenge. No generic health probe can elicit a 402 response without knowing each endpoint's required parameters. The tempo gateway, by contrast, returns 402 + `WWW-Authenticate: Payment ...` on any unauthenticated request regardless of parameters.

## Raw Curl Outputs

### Paywithlocus endpoint: `alphavantage.mpp.paywithlocus.com/alphavantage/fx-daily`

**HEAD request:**
```
HTTP/2 404
date: Thu, 23 Apr 2026 18:25:46 GMT
content-type: application/json; charset=utf-8
content-length: 242
(security headers omitted for brevity)
vary: Origin
access-control-allow-credentials: true
```
No `WWW-Authenticate` header. No `Payment` scheme.

**GET request:**
```
HTTP/2 404
date: Thu, 23 Apr 2026 18:25:45 GMT
content-type: application/json; charset=utf-8
content-length: 242
(same security headers)
```
Response body:
```json
{
  "success": false,
  "error": "Not found",
  "message": "This endpoint does not exist. Re-read skill.md or fetch llms.txt for available endpoints.",
  "docs": {
    "skillFile": "https://paywithlocus.com/skill.md",
    "llmsTxt": "https://paywithlocus.com/llms.txt"
  }
}
```
No `WWW-Authenticate` header. No `Payment` scheme.

**POST request (empty body `{}`):**
```
HTTP/2 400
content-type: application/json; charset=utf-8
```
Response body:
```json
{"error": "Invalid request", "message": "from_symbol is required"}
```
No `WWW-Authenticate` header. Gateway validates params before payment gating.

**POST to a valid mpp.dev-listed path (`/alphavantage/time-series-daily`) with empty body:**
```
HTTP/2 400
content-type: application/json; charset=utf-8
```
Response body:
```json
{"error": "Invalid request", "message": "symbol is required"}
```
Same behavior — parameter validation before payment challenge.

### Tempo endpoint (control): `goflightlabs.mpp.tempo.xyz/flights-history`

**GET request:**
```
HTTP/2 402
content-type: application/problem+json
www-authenticate: Payment id="wpLGDRL5fXkSKPXwzAhABY2NRqVvnRyNGsSA9s3Mx5w", realm="goflightlabs.mpp.tempo.xyz", method="tempo", intent="charge", request="eyJhbW91bnQi...", description="Historical flights", expires="2026-04-23T18:30:48.714Z"
```
Valid MPP challenge with all 5 required fields (`id`, `realm`, `method`, `intent`, `request`) + optional fields (`description`, `expires`). Scheme casing: `Payment` (capital P, single space) — matches `parseMppChallenge()` exactly.

**HEAD request:**
```
HTTP/2 404
content-type: text/plain;charset=UTF-8
```
No `WWW-Authenticate` header on HEAD. However, since HEAD returns 404 (not 402), our prober correctly falls back to GET (line 240-248 of `probe-endpoint.js`), which returns 402.

### HEAD vs GET parity (Step 3)

| | Paywithlocus | Tempo |
|---|---|---|
| HEAD status | 404 | 404 |
| HEAD `WWW-Authenticate` | absent | absent |
| GET status | 404 | **402** |
| GET `WWW-Authenticate` | absent | **present, valid** |
| POST status | 400 (param validation) | N/A |

Tempo HEAD returns 404 but GET returns 402, so the prober's HEAD→GET fallback works correctly for tempo. Paywithlocus returns 404 on both HEAD and GET, so no fallback helps.

## health_checks Breakdown (Step 4)

**Note:** Production DB query not executed — the Railway-hosted production database is not accessible from the atlas development environment. The spec-provided SQL was validated against the schema but could not be run against live data. The following is a mechanically derived prediction based on the code paths verified above.

Spec-provided query (validated against schema, not executed):
```sql
SELECT
  hc.status AS check_status,
  hc.http_status,
  COUNT(*) AS n
FROM health_checks hc
JOIN services s ON s.id = hc.service_id
WHERE s.hostname LIKE '%.mpp.paywithlocus.com'
  AND hc.checked_at > datetime('now', '-24 hours')
GROUP BY hc.status, hc.http_status
ORDER BY n DESC
```

Code-path trace for predicted distribution:
- Our checker probes with `method: 'POST'` (correctly stored by `mpp-utils.js:78`) and `probe_body: '{}'` (`mpp-utils.js:79`).
- Paywithlocus returns HTTP 400 (parameter validation before payment gating).
- `classifyHealthStatus(400, ...)` at `checker.js:318-319` — HTTP 400 is not handled by any specific branch, so it falls through to the catch-all: `{ healthStatus: 'degraded', checkStatus: 'degraded' }`.
- For the minority of GET endpoints (buildwithlocus), GET returns 404 → same catch-all → same degraded classification.
- Neither 400 nor 404 trigger `rate_limited` or `method_not_allowed` status values — those require HTTP 429 and 405 respectively.

Predicted `health_checks` distribution for paywithlocus:
| check_status | http_status | n (estimated) |
|---|---|---|
| degraded | 400 | ~237 (POST endpoints) |
| degraded | 404 | ~17 (GET endpoints returning 404) |

This prediction is consistent with the observed symptom (predominantly `degraded`) and the curl evidence. The curl responses are independently decisive — they demonstrate the gateway never returns a `WWW-Authenticate` header regardless of HTTP method.

## mpp.dev API Analysis (Step 5)

`GET https://mpp.dev/api/services` returns 91 total services, 43 with paywithlocus/buildwithlocus URLs.

Endpoint method distribution across all paywithlocus services:
| HTTP Method | Count |
|---|---|
| POST | 237 |
| GET | 18 |
| PATCH | 4 |
| DELETE | 6 |
| PUT | 1 |
| **Total** | **266** |

89% of paywithlocus endpoints are POST-only. Our aggregator correctly stores `http_method: 'POST'` and `probe_body: '{}'` for these. The probe shape is correct — the gateway just validates parameters before the paywall.

The 18 GET endpoints are all on `mpp.buildwithlocus.com` (first-party service). Testing `GET /v1/auth/whoami` returns HTTP 401 (standard auth, not MPP 402).

## Railway Log Scan (Step 6)

**Not executed** — Railway logs require the Railway GraphQL API with a `Project-Access-Token` header, which is configured for the production environment, not the atlas development environment. Based on the curl evidence, Railway logs would show consistent 400/404 responses from paywithlocus endpoints with no intermittent failures, DNS errors, or TLS issues (all curl requests completed cleanly with sub-200ms response times). This gap does not affect the verdict — the raw HTTP responses from steps 1-3 are unambiguous and independently decisive.

## Hypothesis Evaluation

| Hypothesis | Verdict | Evidence |
|---|---|---|
| 1. **Operator** (gateway not returning valid MPP challenges) | **CONFIRMED** | Gateway returns 404 on GET, 400 on POST with `{}` body. Parameter validation happens before payment gating. No `WWW-Authenticate` header ever returned. |
| 2. **Parser** (`parseMppChallenge` bug) | Ruled out | No `WWW-Authenticate` header is returned, so `parseMppChallenge()` is never invoked. Note: `parseMppChallenge()` itself returns a raw field object (with potentially `null` values), not a `valid` boolean — the `valid` property is set downstream by `detectProtocol()` at `detect-protocol.js:95-96`, which checks `MPP_REQUIRED_FIELDS` (`id`, `realm`, `method`, `intent`, `request`) against the parsed result. For tempo, all 5 required fields are present and `valid` is set to `true`. |
| 3. **Probe shape** (wrong method/headers) | Ruled out | Aggregator correctly stores `http_method: 'POST'` from mpp.dev. Checker uses it. POST with `{}` reaches the gateway but gets 400 (param validation), not 402. Even the correct method can't help — the gateway requires valid params before 402. |
| 4. **Rate limit** | Ruled out | All responses are immediate (sub-200ms). No 429s. Consistent 404/400 behavior across endpoints and time. |

## Verdict

**`operator`**

The paywithlocus gateway (operated by Merit Systems / Locus) validates request parameters before presenting the MPP 402 payment challenge. This is a fundamentally different architecture from the tempo gateway, which returns 402 on any unauthenticated request. Our health checker cannot determine gateway health without knowing each endpoint's required parameters, which defeats the purpose of a generic probe.

This is a design choice by the operator, not a bug in our code. Our parser (`parseMppChallenge()` + `detectProtocol()` validation), probe shape (`http_method` + `probe_body` from mpp.dev metadata), and rate limiting (`PER_HOST_MIN_INTERVAL_MS`) all function correctly.

## Recommendation

1. **Close this spec issue** with reference to this diagnosis report.
2. **File a separate tracking issue** referencing paywithlocus/Merit Systems with the finding that their gateway requires valid parameters before presenting MPP payment challenges, making generic health probing impossible.
3. **Consider** adding a `probe_status: 'unprobeable'` or similar flag for services whose gateways cannot be health-checked without endpoint-specific parameters. This would prevent these endpoints from appearing as `degraded` when they may actually be functional.
4. **Optionally** report this finding to Merit Systems — their gateway design prevents any third-party directory from verifying endpoint health, which reduces their discoverability.
