# 402 Index — Red Team Report

**Date:** 2026-02-27
**Auditor:** Claude (automated)
**Codebase:** `ryanthegentry/402index` @ commit `cdf3907` (pre-fixes)

---

## 1. Site Health Check Results

| Check | Result | Notes |
|-------|--------|-------|
| HTTPS (`curl -sI https://402index.io`) | **PASS** | HTTP/2 200, SSL working, served via Railway edge + Fastly CDN |
| Featured services API | **PASS** | 15 featured services returned. Ganamos present. |
| Health endpoint (`/api/v1/health`) | **PASS** | 3,712 services (up from 3,098). 3,136 healthy, 445 degraded, 126 down, 5 unknown. |
| About page (no personal refs) | **PASS** | No BIXI/Golem/Ryan/walc references found. |
| Railway logs | **N/A** | Railway CLI couldn't connect to service (needs `railway service` link). No indication of crashes from health data — syncs are running on schedule. |

**Summary:** Production is healthy. HTTPS works. All systems operational. Service count grew from 3,098 to 3,712 since last session (Bazaar continuing to backfill).

---

## 2. Red Team Findings

### 2a. Security

| # | Issue | Severity | Effort | Recommendation | Status |
|---|-------|----------|--------|----------------|--------|
| S1 | **SSRF via health checker** — Health checker followed redirects (`redirect: 'follow'`). A malicious service registered on Bazaar could redirect to internal IPs (169.254.169.254 cloud metadata, localhost, private ranges). | **High** | Quick | Fix now | **FIXED** |
| S2 | **No SSRF URL validation** — No blocklist for private IPs, localhost, or cloud metadata endpoints in health checker. | **High** | Quick | Fix now | **FIXED** |
| S3 | **`x-powered-by: Express` header** — Leaks technology stack to attackers. Trivial to fingerprint. | **Low** | Quick | Fix now | **FIXED** |
| S4 | **No rate limiting on API** — All endpoints (`/api/v1/services`, `/`, `/service/:id`) accept unlimited requests. An attacker could scrape the full database, or cause CPU/memory pressure via rapid requests with expensive LIKE queries. | **High** | Medium | Defer — add `express-rate-limit` (100 req/min for API, 200 req/min for pages). |
| S5 | **No security headers** — Missing Content-Security-Policy, X-Content-Type-Options, X-Frame-Options, Strict-Transport-Security. Site could be clickjacked or content-sniffed. | **Medium** | Medium | Defer — add `helmet` middleware. |
| S6 | **No global Express error handler** — Unhandled errors in route handlers return Express default 500 page. In development mode this leaks stack traces. On Railway `NODE_ENV` should be `production`, but worth confirming. | **Medium** | Quick | Defer — add `app.use((err, req, res, next) => ...)` error handler. |
| S7 | **LIKE wildcard injection** — The `q` search parameter is wrapped in `%...%` for LIKE queries. A user sending `q=_%` or `q=%%` could craft unusual pattern matches. Not exploitable for data exfiltration (all data is public), but could be used for slow queries. | **Low** | Quick | Defer — low impact since data is public. |
| S8 | **SQL queries use parameterized statements** — All user input goes through better-sqlite3 named params (`@param`) or positional params (`?`). **No SQL injection found.** | Info | — | No action needed. |
| S9 | **HTML output uses escapeHtml()** — Service names, URLs, descriptions, and search terms are all escaped via `escapeHtml()` before rendering. **No XSS found.** | Info | — | No action needed. |

### 2b. Scalability & Reliability

| # | Issue | Severity | Effort | Recommendation | Status |
|---|-------|----------|--------|----------------|--------|
| R1 | **health_checks table unbounded growth** — 3,712 services × 96 checks/day = ~356K rows/day. At 13K services (full Bazaar sync): ~1.25M rows/day, ~37.5M rows/month. No pruning existed. | **High** | Quick | Fix now | **FIXED** |
| R2 | **Bazaar rate limiting caps sync at ~3-4.5K per run** — Coinbase API returns 429s after ~3K requests. Full catalog is ~12.9K. Takes multiple hourly polls to fully sync. | **Medium** | Medium | Defer — implement offset persistence. Save last successful offset, resume from there on next poll instead of starting from 0 each time. |
| R3 | **better-sqlite3 uses synchronous I/O** — All DB operations block the event loop. During health check runs, ~7,400 sync DB ops (insert + update per service). Each op takes microseconds, so total blocking time is ~10-50ms — acceptable. At 13K services this doubles but remains manageable. | **Low** | Large | Defer — not a problem at current scale. Monitor if latency spikes during health check runs. |
| R4 | **No graceful shutdown handler** — If Railway restarts the container, in-progress health checks and polls are interrupted mid-execution. WAL mode protects against DB corruption, but partial poll results could leave stale data. | **Medium** | Quick | Defer — add `process.on('SIGTERM', ...)` to finish current batch before exit. |
| R5 | **Health check concurrency during polls** — Health checks and API requests run in the same event loop. The 10-at-a-time concurrency limiter keeps outbound connections manageable. API responsiveness is preserved because `await` yields between batches. No blocking issue found. | Info | — | No action needed. |
| R6 | **Container recovery on restart** — On restart: server starts, loads YAML listings, polls Bazaar + Satring, then starts health checks after 30s. DB persists on Railway volume. Recovery is clean. | Info | — | No action needed. |
| R7 | **Bazaar API format changes** — If Bazaar changes response format, `normalizeItem()` returns `null` for unrecognized items and they're counted as `errorCount`. Logged for first 5 errors. Fails safely but **silently** if ALL items fail (just logs "0 new, 0 updated"). | **Medium** | Quick | Defer — add an alert/log if errorCount exceeds 50% of total items (indicates API contract changed). |

### 2c. Data Integrity

| # | Issue | Severity | Effort | Recommendation | Status |
|---|-------|----------|--------|----------------|--------|
| D1 | **Dedup fragility on URL matching** — Dedup key is `(url, protocol)`. If Bazaar normalizes a URL differently between polls (trailing slash, scheme change, subdomain variation), duplicates will be created. | **Medium** | Medium | Defer — implement URL normalization before dedup (lowercase host, strip trailing slash, normalize scheme). |
| D2 | **Featured matching on exact URL** — `featured.yaml` matches on exact URL string. If Bazaar changes a URL slightly, the featured flag won't match and the service loses featured status silently. | **Medium** | Quick | Defer — add logging when a featured URL doesn't match any service. |
| D3 | **Satring poll overwrites metadata but preserves health** — The upsert `ON CONFLICT` updates name, description, price, category, provider but does NOT touch health_status, uptime, latency. Health data is preserved across polls. | Info | — | Working as designed. |
| D4 | **BTC/USD conversion is hardcoded** — `satring.js` uses `BTC_USD = 90_000` for sats→USD conversion. BTC price changes aren't reflected. | **Low** | Medium | Defer — fetch real exchange rate from a free API (CoinGecko, etc.) on each poll. |

### 2d. Operational

| # | Issue | Severity | Effort | Recommendation | Status |
|---|-------|----------|--------|----------------|--------|
| O1 | **No monitoring or alerting** — If the server crashes at 3am, nobody knows. No uptime monitor, no error reporting (Sentry), no webhook notifications. | **High** | Medium | Defer — set up a free uptime monitor (UptimeRobot, Better Stack) on `https://402index.io/api/v1/health`. Add a simple health check that alerts if the endpoint is down for >5 minutes. |
| O2 | **No log persistence** — Railway logs are ephemeral. If a crash or error pattern occurs, historical logs may be lost. | **Medium** | Medium | Defer — consider a free logging service (Logtail, Axiom) or at minimum pipe critical errors to a webhook. |
| O3 | **Railway costs** — Free $5 credit for first month. Expected cost after: ~$5-7/month (1 service, small persistent volume, low CPU/RAM). Well within budget for a loss-leader project. | **Low** | — | Monitor usage in Railway dashboard. |
| O4 | **Backup strategy** — If Railway volume is lost, health history is unrecoverable. Service data rebuilds from Bazaar/Satring/YAML on restart. Featured config is in git. Only health_checks history is truly at risk. | **Medium** | Medium | Defer — add a daily SQLite backup (copy `.db` file to a second volume or S3-compatible store). |
| O5 | **No `NODE_ENV=production`** — Not explicitly set in Procfile. Railway may set it automatically, but should be confirmed. Affects Express error page verbosity. | **Low** | Quick | Defer — add `NODE_ENV=production` to Railway env vars. |

---

## 3. Fixes Applied This Session

| Fix | Commit | Description |
|-----|--------|-------------|
| S1+S2: SSRF protection | `6072123` | Added `isBlockedUrl()` function that blocks private IPv4 ranges (10.x, 172.16-31.x, 192.168.x, 127.x, 0.x), localhost, cloud metadata (169.254.169.254), and non-HTTP schemes. Changed `redirect: 'follow'` to `redirect: 'manual'` to prevent redirect-based SSRF. |
| S3: Remove x-powered-by | `6072123` | Added `app.disable('x-powered-by')` to prevent Express header disclosure. |
| R1: Health check pruning | `6072123` | Added `pruneOldHealthChecks()` that deletes records older than 30 days before each health check run. Prevents unbounded table growth. |

---

## 4. Recommended Priority Order for Remaining Fixes

### Priority 1 — Before the Satring dev call (Feb 28)
1. **O1: Uptime monitoring** — Set up UptimeRobot or similar on `https://402index.io/api/v1/health`. Free, 5 minutes to configure. Critical for credibility.
2. **O5: Confirm NODE_ENV=production** — Check Railway env vars. 1 minute.

### Priority 2 — This week
3. **S4: Rate limiting** — `npm install express-rate-limit`, add middleware. 30 min.
4. **S5: Security headers** — `npm install helmet`, add middleware. 15 min.
5. **R4: Graceful shutdown** — Add SIGTERM handler. 15 min.
6. **D2: Featured URL match logging** — Log when featured URLs don't match. 10 min.

### Priority 3 — Next sprint
7. **R2: Bazaar offset persistence** — Save/resume polling offset to handle rate limits. 1-2 hrs.
8. **D1: URL normalization** — Normalize URLs before dedup matching. 1-2 hrs.
9. **R7: Bazaar API change detection** — Alert on high error rate during polls. 30 min.
10. **S6: Global error handler** — Add Express error middleware. 15 min.

### Priority 4 — When needed
11. **O2: Log persistence** — Logtail/Axiom integration. 1 hr.
12. **O4: SQLite backups** — Daily backup to S3. 2 hrs.
13. **D4: Real BTC/USD rate** — Fetch from CoinGecko on poll. 30 min.

---

## Appendix: What's Working Well

- **Parameterized SQL everywhere** — No SQL injection vectors found.
- **HTML escaping** — `escapeHtml()` used consistently on all user-visible data.
- **WAL mode** — SQLite journal mode protects against corruption on crashes.
- **Bounded query results** — API enforces `LIMIT` (max 200) and `OFFSET` on all list queries.
- **Error isolation** — Aggregator and health check failures are caught and logged, never crash the server.
- **Dedup strategy** — `ON CONFLICT(url, protocol) DO UPDATE` prevents duplicates on re-polls.
- **Health check concurrency** — 10-at-a-time batching prevents socket exhaustion.
