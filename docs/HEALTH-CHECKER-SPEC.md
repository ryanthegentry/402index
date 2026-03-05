# Health Checker Specification — L402 & x402 Protocols

This document specifies how 402index health checks should behave for each supported protocol. It serves as the reference implementation target for `src/health/checker.js`.

## Section 1: Protocol Behavior Reference

### L402 (Lightning)

A correctly implemented L402 endpoint returns:
- **HTTP 402 Payment Required**
- **`WWW-Authenticate` header** with scheme `L402` (or legacy `LSAT`)
- Header contains: `macaroon="<base64>"`, `invoice="<lnbc...>"`

The macaroon is a bearer credential. The invoice is a Lightning Network payment request. After payment, the client returns the macaroon + preimage in the `Authorization` header.

A 200 response from an L402 endpoint means the paywall is misconfigured or the request was already authenticated — this is NOT the healthy state for an unauthenticated probe.

**HEAD behavior:** Aperture (the reference L402 reverse proxy) intercepts ALL HTTP methods at the proxy level, including HEAD. A HEAD request to a protected path WILL return 402 + `WWW-Authenticate`. This makes HEAD reliable for L402 health checks, unlike x402.

### x402 (Base / Solana)

A correctly implemented x402 endpoint returns:
- **HTTP 402 Payment Required**
- **`PAYMENT-REQUIRED` header** containing a base64-encoded JSON payload (V2) or payment requirements in the response body (V1)

**V2 (current spec)** — all protocol data in headers:
```json
{
  "x402Version": 2,
  "resource": { "url": "...", "description": "...", "mimeType": "..." },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:8453",
      "amount": "10000",
      "payTo": "0x...",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "maxTimeoutSeconds": 60,
      "extra": { "name": "USDC", "version": "2" }
    }
  ]
}
```

**V1 (legacy, still common in Bazaar)** — payment requirements in response body:
```json
{
  "x402Version": 1,
  "accepts": [
    {
      "scheme": "exact",
      "network": "base-sepolia",
      "maxAmountRequired": "1000",
      "resource": "https://example.com/api/endpoint",
      "description": "API access",
      "mimeType": "application/json",
      "payTo": "0x...",
      "maxTimeoutSeconds": 300,
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
    }
  ]
}
```

**V1 vs V2 differences relevant to health checking:**
- V1: payment requirements in response **body** (HEAD never carries them). Client sends `X-PAYMENT` header.
- V2: payment requirements in `PAYMENT-REQUIRED` **header** (HEAD *should* carry them but often doesn't). Client sends `PAYMENT-SIGNATURE` header.
- V1 uses `maxAmountRequired`; V2 uses `amount`
- V1 uses friendly network names (`base-sepolia`); V2 uses CAIP-2 (`eip155:84532`)
- Bazaar discovery API returns V1-style field names even for items labeled V2
```

Key fields for validation:
- `payTo`: Non-empty Ethereum address (0x-prefixed, 42 chars)
- `asset`: ERC-20 contract address — must match a known USDC contract
- `maxAmountRequired`: Payment amount in token micro-units (USDC = 6 decimals)
- `network`: Chain identifier (e.g., `base`, `base-sepolia`, `ethereum`, `solana`)

After payment, the client includes a `X-PAYMENT` header with the signed receipt. A facilitator (e.g., Coinbase CDP) verifies the payment on-chain.

### Facilitator

x402 payments go through a facilitator service that:
1. Verifies the payment transaction on-chain
2. Returns a signed receipt to the client
3. The client forwards the receipt to the API

The facilitator URL is typically `https://x402.org/facilitator` (production) or derivable from the network. Facilitator reachability is part of x402 health — if the facilitator is down, the endpoint can't accept payments even if it returns correct headers.

## Section 2: What a Correct L402 Probe Looks Like

### Request

```
HEAD <endpoint_url>
  (or GET if HEAD returns non-402)
  (or POST with {} body if http_method = 'POST')
Timeout: 5 seconds
Redirect: manual (do not follow)
```

### Classification Logic

| HTTP Status | WWW-Authenticate | Macaroon Valid | Invoice Valid | Result |
|-------------|------------------|---------------|---------------|--------|
| 402 | Present, L402/LSAT scheme | Yes (10+ chars, base64) | Yes (lnbc/lntb prefix, 100+ chars) | **healthy** |
| 402 | Present, L402/LSAT scheme | Yes | No (short/missing) | **degraded** — invoice validation failed |
| 402 | Present, L402/LSAT scheme | No | — | **degraded** — macaroon validation failed |
| 402 | Missing or wrong scheme | — | — | **degraded** — missing WWW-Authenticate |
| 200 | — | — | — | **degraded** — paywall not enforced |
| 3xx | — | — | — | **degraded** — redirect (we use redirect:manual) |
| 401/403 | — | — | — | **degraded** — auth error, not L402 |
| 404 | — | — | — | **down** — endpoint not found |
| 429 | — | — | — | **degraded** — rate limited by provider |
| 5xx | — | — | — | **down** — server error |
| Timeout/Network error | — | — | — | **down** — unreachable |

### Data Columns Updated

- `health_status`: healthy/degraded/down per table above
- `last_checked`: current timestamp
- `response_time_ms`: measured latency
- `last_status_code`: HTTP status received
- No x402-specific columns touched (payment_valid, facilitator_reachable, asset_known stay NULL)

### Notes

- `redirect: 'manual'` is intentional — we don't follow redirects because they may lead to non-L402 pages
- HEAD is preferred for performance; GET fallback if HEAD returns unexpected status
- POST with `Content-Type: application/json` and body `{}` when `http_method = 'POST'`
- Invoice and macaroon validation is structural only (format checks, not cryptographic verification)

## Section 3: What a Correct x402 Probe Looks Like

### Request

```
HEAD <endpoint_url>
  (or GET if HEAD returns 402 without PAYMENT-REQUIRED header)
Timeout: 5 seconds
Redirect: manual
```

### Classification Logic

| HTTP Status | PAYMENT-REQUIRED Header | Payload Valid | Asset Known | Facilitator Reachable | Result |
|-------------|------------------------|--------------|-------------|----------------------|--------|
| 402 | Present | Valid JSON, has accepts[] | Yes (known USDC) | Yes | **healthy**, payment_valid=1 |
| 402 | Present | Valid JSON, has accepts[] | Yes | No (facilitator down) | **degraded**, payment_valid=0, facilitator_reachable=0 |
| 402 | Present | Valid JSON, has accepts[] | No (unknown asset) | — | **degraded**, payment_valid=0, asset_known=0 |
| 402 | Present | Invalid JSON / no accepts | — | — | **degraded**, payment_valid=0 |
| 402 | Missing | — | — | — | Retry with GET. If still missing: **degraded**, payment_valid=0 |
| 200 | — | — | — | — | **degraded**, payment_valid=0 — paywall not enforced |
| 404 | — | — | — | — | **down**, payment_valid=0 |
| 5xx | — | — | — | — | **down**, payment_valid=0 |
| Timeout/Network error | — | — | — | — | **down**, payment_valid=0 |

### HEAD → GET Fallback

Many x402 servers (especially Bazaar-sourced) only include the `PAYMENT-REQUIRED` header on GET requests, not HEAD. The probe should:

1. Send HEAD first (fast, low overhead)
2. If HEAD returns 402 but NO `PAYMENT-REQUIRED` header → retry with GET
3. Cache the HEAD-vs-GET preference per endpoint to avoid redundant retries on subsequent checks
4. The `x402_head_no_payment` column tracks this: if set, skip straight to GET on next check

### Data Columns Updated

- `health_status`: healthy/degraded/down per table above
- `x402_payment_valid`: 1 (valid payment requirements) or 0 (invalid/missing) — **never NULL after first check**
- `x402_facilitator_reachable`: 1/0 (facilitator HTTP check, cached 15 min)
- `x402_asset_known`: 1/0 (matches known USDC contract list)
- `last_checked`, `response_time_ms`, `last_status_code`: same as L402

### Known USDC Contract Addresses

From `src/services/x402-utils.js`:
- Base: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- Ethereum: `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`
- Arbitrum: `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`
- Optimism: `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85`
- Polygon: `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359`
- Base Sepolia: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`

### Facilitator Reachability

- Default facilitator: `https://x402.org/facilitator`
- Check: HTTP HEAD to facilitator URL, expect 2xx or 405 (Method Not Allowed is fine — means the server is up)
- Cache result for 15 minutes (`facilitatorCache` Map with TTL)
- If facilitator is unreachable, x402 endpoint is degraded even if payment headers are valid

## Section 4: Rate Limiting and Provider-Aware Probing

### Current Behavior

No provider-aware rate limiting exists. All endpoints are checked in batches of `CONCURRENCY=10` with `Promise.allSettled`. This means:

- A provider with 500 endpoints gets 500 health check requests within minutes
- No delay between requests to the same host
- Providers return 429 (13% of L402 checks per production data)

### Recommended Behavior

1. **Per-host queuing**: Group endpoints by hostname. Within each host group, add a minimum delay between requests (e.g., 1 second).
2. **429 backoff**: When a provider returns 429, mark remaining endpoints for that host as "skipped — rate limited" and retry next cycle.
3. **Concurrency limit per host**: Max 1-2 concurrent requests per unique hostname, regardless of global concurrency.
4. **Global concurrency**: Keep `CONCURRENCY=10` across all hosts, but distribute across different hosts.

### Provider 429 Handling

Current: 429 → `degraded` (punishes the provider for our aggressive probing).
Correct: 429 → skip this cycle, retain previous health_status, log as "rate limited."

The 13% 429 rate in production data (L402 checks) directly results from back-to-back probing without host awareness.

## Section 5: http_method Column Usage

### Column Definition

```sql
http_method TEXT DEFAULT 'GET'
```

Added in migration (db.js line 222-227). Stores the HTTP method the endpoint expects for its primary function. Values: `'GET'`, `'POST'`, or NULL (treated as GET).

### Source Population

| Source | Sets http_method? | Notes |
|--------|-------------------|-------|
| Bazaar aggregator | No | All default to GET |
| Satring aggregator | No | All default to GET |
| L402Apps aggregator | No | All default to GET |
| Sponge aggregator | No | All default to GET |
| Self-registration | Yes | `POST /api/v1/register` accepts `http_method` field |
| Manual YAML | Possible | Via `http_method` field in YAML listing |

### Health Check Usage

In `checker.js` `performHttpCheck()`:
- If `http_method === 'POST'`: sends POST with `Content-Type: application/json` and body `{}`
- Otherwise: sends HEAD (with GET fallback)

### Gap

Most aggregators don't provide http_method data. Many L402 endpoints are POST-only (e.g., inference APIs, payment processors). These get HEAD/GET probes → 405 Method Not Allowed (6% of L402 checks in production) → classified as `degraded`.

The health checker should:
1. Recognize 405 as a signal to retry with POST
2. Auto-detect and persist http_method when 405 → POST succeeds with 402
3. Never override a manually-set http_method

## Section 6: Interval and Volume Management

### Current Configuration

| Setting | Value | Source |
|---------|-------|--------|
| Health check interval | 15 minutes | `HEALTH_CHECK_INTERVAL_MS` env var, default 900000 |
| Health check pass duration | ~16 minutes | Production measurement (13,700+ endpoints / 10 concurrent / 5s timeout) |
| Retention (checker.js) | 3 days | `HEALTH_CHECK_RETENTION_DAYS` constant |
| Retention (db.js pruning) | 1 day | Hardcoded in startup prune query |
| Prune interval | 1 hour | `setInterval` in db.js |
| DB size | ~324 MB / 1 GB | Railway volume |

### Issues

1. **Back-to-back checks**: 16-min pass + 15-min interval = checks run continuously with no idle gap. One pass finishes and the next starts almost immediately.

2. **Retention mismatch**: `checker.js` says 3 days, `db.js` prunes at 1 day. The db.js prune wins because it runs hourly. This means:
   - `uptime_30d` metric queries 30 days of data but only has ~1 day of history
   - Reliability score's uptime component is unreliable

3. **Volume growth**: With 13,700 endpoints checked every ~16 minutes, that's ~1,234 health_check rows per minute, ~1.78M per day. At 1-day retention this is manageable but needs monitoring.

### Recommended Configuration

| Setting | Current | Recommended | Rationale |
|---------|---------|-------------|-----------|
| Interval | 15 min | 60 min | Reduces volume growth 4x, eliminates back-to-back, matches industry standard for non-critical monitoring |
| Retention (unified) | 1 day (effective) | 3 days | Align checker.js and db.js. Provides enough history for reliability_score |
| Prune interval | 1 hour | 1 hour | Keep as-is |
| uptime_30d window | 30 days | Match retention | Don't query data that doesn't exist |

With 1-hour intervals: ~13,700 checks/hour × 24 × 3 days retention = ~986K rows max. Roughly 100 MB at current row size — sustainable within 1 GB volume.

## Section 7: Failure Modes

### Network Failures

| Failure | Current Behavior | Correct Behavior |
|---------|-----------------|------------------|
| DNS resolution failure | Error caught, `down` | Correct |
| Connection timeout (5s) | Error caught, `down` | Correct |
| Connection refused | Error caught, `down` | Correct |
| TLS certificate error | Error caught, `down` | Correct — don't skip TLS validation |
| SSRF attempt (private IP) | Blocked by DNS check | Correct — `resolveAndCheck()` prevents probing internal networks |

### Protocol Failures

| Failure | Current Behavior | Correct Behavior |
|---------|-----------------|------------------|
| 402 but no WWW-Authenticate (L402) | `degraded` | Correct |
| 402 but no PAYMENT-REQUIRED (x402 HEAD) | Retry with GET | Correct |
| 402 but no PAYMENT-REQUIRED (x402 GET) | `degraded`, payment_valid stays NULL | Should set payment_valid=0 |
| Non-402 response (x402) | health_status set, payment_valid stays NULL | Should set payment_valid=0 |
| Invalid base64 in PAYMENT-REQUIRED | `degraded`, payment_valid=0 | Correct |
| Valid headers but unknown asset | `degraded`, payment_valid=0, asset_known=0 | Correct |
| Valid headers but facilitator unreachable | Depends on cache | `degraded`, payment_valid=0, facilitator_reachable=0 |

### Data Integrity

| Issue | Current Behavior | Correct Behavior |
|-------|-----------------|------------------|
| x402 payment_valid NULL after check | Happens when response is non-402 | Should be 0 — NULL means "never checked" |
| health_status NULL | Set by aggregator, never overwritten until first check | Acceptable — means pending first check |
| Stale health_status (endpoint removed) | Never cleared | Consider marking `down` after N consecutive failures |
| Concurrent check of same endpoint | Possible with overlapping passes | Prevent with lock or skip-if-recent logic |

### Logging

Current logging is minimal:
- Counts only: `[health] Checked N services: X healthy, Y degraded, Z down`
- Errors counted but not detailed
- No per-protocol breakdown
- No per-host rate limit tracking

Recommended:
- Log per-protocol breakdown: `[health] L402: X healthy, Y degraded, Z down | x402: ...`
- Log rate-limited hosts: `[health] Rate limited by: host1 (N endpoints skipped), host2 (...)`
- Log error details for first N errors per cycle (not all — could be thousands)
- Log pass duration and idle gap
