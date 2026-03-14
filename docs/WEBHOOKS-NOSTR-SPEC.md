# Webhooks + Nostr Publishing Spec

## Overview
Event-driven distribution of 402index service events via webhooks (HTTP POST) and Nostr relay publishing.

## Events
| Event | Trigger | Description |
|-------|---------|-------------|
| `service.new` | Service registered/approved | New service added to the index |
| `service.health_changed` | Health check detects status change | Service health transitions (e.g., healthy -> down) |
| `service.down` | Health check detects service down | Subset of health_changed — only when new status is "down" |

---

## Webhooks

### Database Schema
```sql
CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT 'service.new',
  protocol_filter TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_triggered_at TEXT,
  failure_count INTEGER DEFAULT 0
)
```

### API Endpoints

#### POST /api/v1/webhooks — Register
- **Rate limit:** 5/hour per IP
- **Body:** `{ url, secret, events?, protocol_filter? }`
  - `url` (required): HTTPS URL to receive POST notifications. Must not resolve to private IP.
  - `secret` (required): Shared secret for HMAC signing + auth on GET/DELETE.
  - `events` (optional): Comma-separated event names. Default: `service.new`.
  - `protocol_filter` (optional): `L402` or `x402`. Only deliver events for matching protocol.
- **Response:** `201 { id, url, events, created_at }`

#### GET /api/v1/webhooks/:id — Status
- **Auth:** `X-Webhook-Secret` header must match webhook's secret.
- **Response:** `200 { id, url, events, protocol_filter, is_active, created_at, last_triggered_at, failure_count }`

#### DELETE /api/v1/webhooks/:id — Remove
- **Auth:** `X-Webhook-Secret` header must match webhook's secret.
- **Response:** `200 { deleted: true }`

### Delivery
- **Method:** POST to registered URL
- **Timeout:** 5 seconds
- **Headers:**
  - `Content-Type: application/json`
  - `X-402Index-Signature: sha256=<HMAC-SHA256 hex digest>`
  - `X-402Index-Event: <event name>`
- **Payload:**
```json
{
  "event": "service.new",
  "service": { "id": "...", "name": "...", "url": "...", "protocol": "L402", ... },
  "timestamp": "2026-03-14T12:00:00.000Z"
}
```
- **Failure handling:** Increment `failure_count`. After 10 consecutive failures, set `is_active = 0`. On success, reset `failure_count = 0`.
- **Fire-and-forget:** Delivery runs async, never blocks the caller.

### Security
- HMAC-SHA256 signing with webhook's secret
- Constant-time comparison for secret verification (crypto.timingSafeEqual)
- SSRF protection on registration (resolveAndCheck)
- HTTPS-only webhook URLs

---

## Nostr Publishing

### Configuration
- `NOSTR_PRIVATE_KEY` — hex-encoded Nostr private key. Publishing disabled if unset.
- `NOSTR_RELAY_URLS` — comma-separated relay URLs. Publishing disabled if unset.

### Event Format
- **Kind:** 30402 (NIP-99 Classifieds)
- **Content:** JSON with service data + event_type
- **Tags:**
  - `["d", service.url]` — dedup identifier
  - `["t", service.category]` — topic/category
  - `["L", "protocol"]` — label namespace
  - `["l", service.protocol, "protocol"]` — protocol label
  - `["r", service.url]` — reference URL
  - `["price", String(price_sats), "sats"]` — price tag

### Behavior
- Fire-and-forget with 5s timeout
- Silently disabled when env vars unset (same pattern as email notifications)
- Logs errors, never throws
- Dependency: `nostr-tools` npm package
