# 402 Index — Technical Specification

**Last updated:** February 26, 2026

---

## Architecture Overview

```
[Bazaar API] --poll (hourly)--> [Normalizer] --> [SQLite DB] --> [Express API] --> [Web UI]
[Satring API] --poll (hourly)-->                                       |
[YAML listings] ----------------->                                [MCP Server]
                                                                       |
[Health checker (15min)] ---------> [DB: uptime, latency, status]  [Agents]
```

Single-process Node.js application. SQLite for persistence. No external dependencies beyond the Bazaar and Satring APIs.

---

## Data Schema

### `services` table

```sql
CREATE TABLE services (
  id TEXT PRIMARY KEY,                    -- UUID
  name TEXT NOT NULL,
  description TEXT,
  url TEXT NOT NULL,                       -- The service endpoint URL
  protocol TEXT NOT NULL CHECK(protocol IN ('L402', 'x402', 'both')),
  price_sats INTEGER,                      -- Price in satoshis (null if stablecoin-only)
  price_usd REAL,                          -- Price in USD (normalized from sats or stablecoin)
  payment_asset TEXT,                      -- 'BTC/Lightning', 'USDC', 'USDC/Base', etc.
  payment_network TEXT,                    -- 'lightning', 'eip155:8453', 'eip155:84532', etc.
  category TEXT,                           -- Hierarchical: 'real-time-data/weather'
  input_schema TEXT,                       -- JSON string of input schema
  output_schema TEXT,                      -- JSON string of output schema
  provider TEXT,                           -- Human-readable provider name
  source TEXT NOT NULL CHECK(source IN ('bazaar', 'satring', 'exclusive', 'self-registered')),
  source_id TEXT,                          -- Original ID from source (Bazaar resource ID, etc.)
  registered_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  
  -- Health check fields
  health_status TEXT DEFAULT 'unknown' CHECK(health_status IN ('healthy', 'degraded', 'down', 'unknown')),
  uptime_30d REAL,                         -- 0.0 to 1.0
  latency_p50_ms INTEGER,
  last_checked TEXT,
  last_seen_healthy TEXT,
  consecutive_failures INTEGER DEFAULT 0
);

CREATE INDEX idx_services_protocol ON services(protocol);
CREATE INDEX idx_services_category ON services(category);
CREATE INDEX idx_services_source ON services(source);
CREATE INDEX idx_services_health ON services(health_status);
```

### `health_checks` table (append-only log)

```sql
CREATE TABLE health_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id TEXT NOT NULL REFERENCES services(id),
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL CHECK(status IN ('healthy', 'degraded', 'down', 'timeout', 'error')),
  response_time_ms INTEGER,
  http_status INTEGER,
  error_message TEXT
);

CREATE INDEX idx_health_checks_service ON health_checks(service_id, checked_at);
```

---

## API Design

Base URL: `https://402index.io/api/v1`

### `GET /services`

Returns paginated list of services.

**Query parameters:**
- `protocol` — Filter by protocol: `L402`, `x402`, `both`
- `category` — Filter by category prefix: `real-time-data`, `real-time-data/weather`
- `health` — Filter by health status: `healthy`, `degraded`, `down`, `unknown`
- `source` — Filter by source: `bazaar`, `satring`, `exclusive`, `self-registered`
- `max_price_usd` — Maximum price in USD
- `payment_asset` — Filter by payment asset: `BTC/Lightning`, `USDC`
- `q` — Full-text search across name + description
- `limit` — Results per page (default 50, max 200)
- `offset` — Pagination offset

**Response:**
```json
{
  "services": [...],
  "total": 247,
  "limit": 50,
  "offset": 0
}
```

### `GET /services/:id`

Returns single service with full detail including recent health check history.

### `GET /health`

Returns index health status and stats.

```json
{
  "status": "ok",
  "total_services": 247,
  "by_protocol": { "L402": 25, "x402": 215, "both": 7 },
  "by_health": { "healthy": 198, "degraded": 12, "down": 8, "unknown": 29 },
  "by_source": { "bazaar": 180, "satring": 22, "exclusive": 35, "self-registered": 10 },
  "last_bazaar_sync": "2026-03-01T12:00:00Z",
  "last_satring_sync": "2026-03-01T12:00:00Z",
  "last_health_check_run": "2026-03-01T12:15:00Z"
}
```

### `GET /categories`

Returns category tree with counts.

---

## Aggregation: x402 Bazaar

**Endpoint:** `https://x402.org/facilitator/discovery/resources` (or `https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources`)

**Polling frequency:** Every hour

**Normalization:**
- Bazaar `maxAmountRequired` → convert to `price_usd` based on asset (USDC = 6 decimals)
- Bazaar `network` → map to `payment_network`
- Bazaar `description` → `description`
- Bazaar resource URL → `url`
- Always set `source = 'bazaar'`, `protocol = 'x402'`
- Store original Bazaar fields in `source_id` for dedup on re-poll

**Dedup strategy:** Match on `url` + `protocol`. On conflict, update metadata but preserve our health check data.

---

## Aggregation: Satring

**Endpoint:** Satring's L402-paywalled API (requires Lightning payment to query)

**Polling frequency:** Every hour (or less if payment cost is a concern)

**Normalization:**
- Map Satring fields to our schema
- Always set `source = 'satring'`, `protocol = 'L402'`

**Note:** Satring is a one-person project and may be unreliable. Build resilience — if Satring is down, skip the sync and preserve existing data.

---

## Exclusive/Manual Listings

Stored in `listings/` directory as YAML files. A script reads these on startup and on file change.

```yaml
# listings/pirate-weather.yaml
name: "Pirate Weather"
url: "https://api.pirateweather.net/forecast"
protocol: L402
price_sats: 5
price_usd: 0.002
payment_asset: "BTC/Lightning"
category: "real-time-data/weather"
description: "Open-source Dark Sky replacement, NOAA-sourced forecasts"
provider: "Pirate Weather"
input:
  query_params:
    location:
      type: string
      description: "lat,lng coordinate pair"
output:
  format: json
  example:
    temperature: 72
    conditions: "partly cloudy"
    humidity: 0.45
```

---

## Health Checker

Runs every 15 minutes via `setInterval` (or cron if separated).

**Check logic per service:**
1. Send HEAD request (or GET with timeout) to service URL
2. If L402: expect 402 response (service is behind paywall — 402 = healthy)
3. If x402: expect 402 response with PAYMENT-REQUIRED header
4. Record: HTTP status, response time, any error
5. Update `services` table: `health_status`, `latency_p50_ms`, `last_checked`, `last_seen_healthy`, `consecutive_failures`
6. Insert row into `health_checks` table

**Health status logic:**
- `healthy`: Last check succeeded (got expected response)
- `degraded`: Last check succeeded but latency > 2x historical p50
- `down`: 3+ consecutive failures
- `unknown`: Never checked or no data in last 24 hours

**Important:** For L402/x402 services, a 402 response IS the healthy response. It means the paywall is active and the service is running. A 200 might mean the paywall is misconfigured.

**Uptime calculation:** Rolling 30-day window from `health_checks` table.

---

## Web UI

Static HTML served by Express. No framework. Minimal JS for filtering.

**Pages:**
- `/` — Service listing table with filters (protocol, category, health, search)
- `/service/:id` — Detail page for a single service (description, pricing, schema, health history chart)
- `/about` — What 402 Index is, how to register, link to Golem

**Design principles:**
- Fast. No JS frameworks. HTML tables. CSS grid for layout.
- Developer-friendly aesthetic. Monospace for code/URLs. Muted colors. Dense information display.
- Every service row shows: name, protocol badge, price, category, health indicator, latency
- Health indicator: green dot (healthy), yellow dot (degraded), red dot (down), gray dot (unknown)

---

## Deployment

- **Platform:** Railway or Fly.io
- **Domain:** 402index.io (registered)
- **SSL:** Auto via platform
- **Single process:** Express server handles API, web UI, polling, and health checks
- **SQLite file:** Persisted on platform volume
- **Environment variables:**
  - `PORT` — Server port
  - `BAZAAR_POLL_INTERVAL_MS` — Default 3600000 (1 hour)
  - `HEALTH_CHECK_INTERVAL_MS` — Default 900000 (15 minutes)
  - `SATRING_ENABLED` — Boolean, disable if Satring integration not ready

---

## Future (Not Now)

These are explicitly deferred. Do not build:
- MCP server (Phase 2, weeks 3-5)
- Registration UI (YAML PRs are fine for now)
- Reviews/ratings
- Payment processing
- User accounts or authentication
- Analytics dashboard
- Email notifications
