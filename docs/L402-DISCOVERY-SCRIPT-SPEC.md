# L402 Endpoint Discovery Script — Specification

## Problem Statement

402index has 120 L402 endpoints. Only 6 are verified healthy. The other 112 are degraded (110) or down (3). The http_method auto-detection deployed on Mar 5 had zero impact — POST retries didn't produce 402 responses.

Root cause analysis suggests the registered URLs are often **wrong** for health checking:
- Root domain URLs that serve landing pages (200 on any method)
- API paths where the paywall gates a sub-path, not the registered path
- POST-only endpoints where `{}` body isn't sufficient to trigger the paywall

With only 120 endpoints, automated discovery + human review is more impactful than further health checker engineering. This script does the automated discovery part.

## Goal

For each degraded/down L402 endpoint in 402index, discover the actual L402-gated path and HTTP method that returns `402 + WWW-Authenticate: L402/LSAT`. Output a structured report with findings and suggested DB updates.

## Input

All L402 services from the 402index API where `health_status != 'healthy'`.

```
GET https://402index.io/api/v1/services?protocol=L402&health=degraded,down
```

Or via local SQLite:
```sql
SELECT id, name, url, health_status, last_status_code, http_method, source, provider
FROM services
WHERE protocol = 'L402' AND health_status IN ('degraded', 'down')
ORDER BY provider, url
```

## Discovery Pipeline

For each degraded L402 endpoint, run these probes in order. Stop early if a valid L402 response is found at any stage.

### Stage 1: Direct Probe (Baseline)

Re-probe the registered URL with all three methods. This establishes a baseline and catches transient failures.

```
HEAD <url>     → record status, headers
GET  <url>     → record status, headers, first 4KB of body
POST <url> {}  → record status, headers (Content-Type: application/json)
```

**L402 success criteria:** HTTP 402 + `WWW-Authenticate` header with `L402` or `LSAT` scheme + parseable macaroon + parseable invoice.

If any method succeeds → record as `direct_hit`, note the method, move to next endpoint.

### Stage 2: Well-Known Discovery

Check standardized discovery paths:

```
GET <origin>/.well-known/l402-services
GET <origin>/.well-known/l402
GET <origin>/.well-known/lsat/services
```

If any returns JSON, parse for endpoint URLs and pricing info. For each discovered URL, run Stage 1 probes. This catches services that publish a machine-readable service directory (e.g., Sats4AI pattern).

### Stage 3: Landing Page Analysis

Fetch the root URL (or registered URL if different) and analyze the response:

```
GET <origin>/
```

Parse the response (HTML or JSON) for signals:

**Link extraction (HTML):**
- All `<a href="...">` where href contains: `/api`, `/v1`, `/v2`, `/l402`, `/lsat`, `/docs`, `/swagger`, `/openapi`
- All `<a>` elements whose text contains: "API", "documentation", "endpoint", "pricing"

**JSON responses:**
- Look for `endpoints`, `services`, `routes`, `paths` keys
- Look for URL-like string values

**Text scanning (both HTML and JSON):**
- Scan for URL patterns matching: `https?://[^\s"'<>]+/api[^\s"'<>]*`
- Scan for mentions of: "L402", "LSAT", "Lightning", "macaroon", "paywall", "402"

Collect all discovered URLs. Deduplicate, filter to same origin. Run Stage 1 probes on each (limit: 10 URLs per endpoint to avoid abuse).

### Stage 4: Common Path Probing

Generate candidate paths from the registered URL and probe them:

**Path variations from registered URL:**
If registered URL is `https://example.com/api/v1/analytics`:
```
https://example.com/api/v1/analytics      (already done in Stage 1)
https://example.com/api/v1                 (parent path)
https://example.com/api                    (grandparent path)
https://example.com/                       (root)
```

**Common L402 API paths:**
```
<origin>/api/l402
<origin>/api/v1
<origin>/api
<origin>/v1
<origin>/api/v1/chat
<origin>/api/v1/completions
<origin>/api/chat
<origin>/ask
<origin>/api/generate
<origin>/api/inference
<origin>/api/search
```

**Method for each path:** Try POST first (most L402 services are POST-only APIs), then GET. HEAD only if both succeed (to check Aperture-style proxy behavior).

Limit: 15 path probes per endpoint max. Apply 500ms delay between probes to same host.

### Stage 5: Sitemap / Robots Analysis

```
GET <origin>/robots.txt
GET <origin>/sitemap.xml
```

From `robots.txt`: extract `Disallow` paths that look API-like (contain `/api`, `/v1`, etc.). These are often gated paths that the operator doesn't want crawled.

From `sitemap.xml`: extract URLs, filter for API-like paths.

Run Stage 1 probes on any discovered paths (limit: 5).

## Output Format

### Per-Endpoint Report

```json
{
  "service_id": "uuid",
  "registered_url": "https://example.com/api/v1/analytics",
  "registered_name": "Example Analytics",
  "source": "satring",
  "provider": "Example Corp",
  "current_health": "degraded",
  "last_status_code": 200,
  "discovery_result": {
    "status": "found|not_found|partial",
    "found_url": "https://example.com/api/v1/analytics",
    "found_method": "POST",
    "found_stage": "stage_4_common_paths",
    "l402_details": {
      "scheme": "L402",
      "has_macaroon": true,
      "has_invoice": true,
      "invoice_prefix": "lnbc"
    }
  },
  "probes": [
    {
      "stage": "stage_1_direct",
      "url": "https://example.com/api/v1/analytics",
      "method": "GET",
      "status": 200,
      "has_www_authenticate": false,
      "body_preview": "<!DOCTYPE html><html>...",
      "notes": "Landing page HTML"
    },
    {
      "stage": "stage_1_direct",
      "url": "https://example.com/api/v1/analytics",
      "method": "POST",
      "status": 402,
      "has_www_authenticate": true,
      "www_authenticate_scheme": "L402",
      "notes": "Valid L402 response on POST"
    }
  ],
  "landing_page_signals": [
    "Found link: /api/v1/docs",
    "Text match: 'L402-protected API'",
    "robots.txt disallows: /api/v1/premium"
  ],
  "suggested_update": {
    "action": "update_method",
    "http_method": "POST",
    "confidence": "high"
  }
}
```

### Summary Report

```
L402 Endpoint Discovery Report — 2026-03-XX
============================================

Total endpoints scanned:     112
L402 found (new path):        X  ← discovered on a different URL than registered
L402 found (method fix):      X  ← same URL, just needs POST instead of GET
L402 found (well-known):      X  ← discovered via .well-known
Partial signals (manual):     X  ← found L402 mentions but no valid 402 response
No signals found:             X  ← endpoint appears dead or non-L402
Already healthy (skip):       X  ← was healthy at scan time

Suggested DB updates:         X  (auto-applicable with --apply flag)
Manual review needed:         X

--- HIGH CONFIDENCE UPDATES ---
(These can be applied automatically)

  service_id | current_url → found_url | method | stage
  ...

--- MANUAL REVIEW ---
(Partial signals — human should check)

  service_id | current_url | signals_found
  ...

--- NO SIGNALS ---
(Likely dead or non-L402)

  service_id | current_url | last_status | notes
  ...
```

## Implementation Notes

### Architecture

Standalone Node.js script: `scripts/l402-discovery.js`

Uses the existing 402index codebase utilities:
- `src/services/l402-utils.js` — `parseWwwAuthenticate`, `isValidMacaroon`, `isValidInvoice`
- `src/health/checker.js` — `isBlockedScheme`, `resolveAndCheck` (SSRF protection)

Does NOT modify the database directly. Outputs a JSON report + human-readable summary. An optional `--apply` flag generates SQL UPDATE statements that can be reviewed and executed.

### Rate Limiting

- Max 3 concurrent endpoint discoveries (outer concurrency)
- 500ms delay between probes to the same host
- 5-second timeout per HTTP request
- Max 30 total HTTP requests per endpoint across all stages
- Skip endpoints on `.onion` domains (can't resolve)

### SSRF Protection

Reuse `resolveAndCheck()` from checker.js for ALL discovered URLs. Never probe private IPs. Never follow redirects (use `redirect: 'manual'`).

### Error Handling

- Network errors → log and continue to next probe
- Timeouts → log and continue
- Malformed responses → log body preview and continue
- All probes wrapped in try/catch — script must never crash

### Body Reading

- Limit response body reads to 64KB (landing page analysis)
- Only read body when needed (Stage 3 analysis, Stage 1 baseline)
- Use `response.text()` with size guard

## Usage

```bash
# Full discovery run, output to stdout
node scripts/l402-discovery.js

# Output JSON report to file
node scripts/l402-discovery.js --json > reports/l402-discovery-$(date +%F).json

# Generate SQL update statements for high-confidence finds
node scripts/l402-discovery.js --apply > reports/l402-updates.sql

# Limit to specific providers (for testing)
node scripts/l402-discovery.js --provider satring
node scripts/l402-discovery.js --provider l402apps

# Single endpoint test
node scripts/l402-discovery.js --url "https://satring.com/api/v1/analytics"

# Verbose mode (log every probe)
node scripts/l402-discovery.js --verbose
```

## CC Prompt Integration

This script is designed to be written and executed by Claude Code in a single session:

1. CC writes `scripts/l402-discovery.js` (~300-400 lines)
2. CC runs it against the live 402index API
3. CC analyzes the output
4. CC applies high-confidence updates directly to the DB via `railway run`
5. CC files the report and updates agent-state

The script outputs are human-readable for review before applying low-confidence changes.

## Success Criteria

- Discovers the correct L402-gated path for 10+ currently-degraded endpoints
- Produces actionable DB update SQL for found endpoints
- Completes full scan of 112 endpoints in under 10 minutes
- Zero false positives (every "found" entry should return valid 402 + WWW-Authenticate)

## Risk Assessment

**Low risk:**
- Read-only against external endpoints (no writes, no payments)
- SSRF-protected via existing checker infrastructure
- Rate-limited to avoid provider abuse
- Does not modify 402index DB unless `--apply` is used

**Downside cap:** Script produces no results (all endpoints genuinely broken). We lose ~1 hour of CC time. No damage to production.

**Upside:** Could flip 10-20 L402 endpoints from degraded to healthy, which changes the L402 story from "6 healthy" to "20+ healthy" — meaningful for the Stacker News launch narrative.
