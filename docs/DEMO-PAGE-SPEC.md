# Demo Page Specification

**Purpose:** Interactive demo page for Lightning Labs AI + BTC community call (Mar 18, 2026). Shows the 402index ecosystem health, enables live service discovery, and visualizes the L402/x402 payment flow — all from within 402index.io.

**Route:** `GET /demo`
**Nav:** "Demo" link added to site header between "About" and "API"

---

## Panel 1: Ecosystem Dashboard

Displays live stats from the database, giving a real-time view of the paid API ecosystem.

### Data Source
- Reuses logic from `GET /api/v1/health` endpoint
- Stats computed server-side and injected into HTML

### Content
- **Headline stats:** Total endpoints indexed, payment-verified count, distinct providers
- **Protocol comparison:** L402 vs x402 side-by-side cards showing:
  - Endpoint count (verified / total)
  - Healthy count
  - Distinct providers
  - Key characteristic (L402: "Decentralized, Lightning-native" / x402: "Coinbase CDP facilitator")
- **Health breakdown:** Visual bars showing healthy/degraded/down/unknown counts with color coding
- **Last checked:** Timestamp of most recent health check run

### Markup
- Section with class `demo-panel demo-ecosystem`
- Uses existing CSS variables for colors (--green, --yellow, --red, --gray)
- Protocol cards use existing badge colors (#F7931A for L402, #0052FF for x402)

---

## Panel 2: Interactive MCP Search

Live search interface that mirrors what an AI agent sees through the MCP server.

### Data Source
- Client-side JavaScript fetches from `GET /api/v1/services` on user input
- Debounced input (300ms) to avoid excessive requests

### Content
- **Search bar:** Text input for keyword search (maps to `q` parameter)
- **Protocol toggle:** Radio buttons for L402 / x402 / Both
- **Filter chips:** Category dropdown, health status dropdown, max price input
- **Sort:** Dropdown (reliability, latency, price, name)
- **Results list:** Each result shows:
  - Service name + URL
  - Protocol badge
  - Price
  - Health dot + status
  - Reliability score (0-100)
  - Latency (ms)
  - Last checked timestamp
- **Result click:** Expands inline to show full detail (description, provider, payment asset/network, schemas)
- **"Copy MCP Query" button:** Shows the equivalent MCP tool call JSON for the current search, with copy-to-clipboard

### MCP Query Format
```json
{
  "tool": "search_services",
  "arguments": {
    "protocol": "L402",
    "category": "data/weather",
    "health": "healthy",
    "max_price_usd": 0.10,
    "sort": "reliability"
  }
}
```

### Markup
- Section with class `demo-panel demo-search`
- Search form does NOT submit (client-side JS handles fetch)
- Results container with class `demo-search-results`
- Each result is a clickable card with class `demo-result-card`
- Expanded detail has class `demo-result-detail`

---

## Panel 3: Payment Flow Visualization

Step-by-step visualization of the L402/x402 payment flow using real probe data.

### Data Source
- Server-side: renders a default L402 flow using data from `GET /api/v1/demo/probe-sample`
- Client-side: protocol toggle fetches new probe sample for the selected protocol

### Content
Five sequential steps, each displayed as a card:

1. **Agent Sends Request**
   - Shows: `GET https://api.example.com/weather`
   - Label: "Agent discovers endpoint via 402index and sends request"

2. **Server Returns 402**
   - L402: Shows `WWW-Authenticate: L402 macaroon="...", invoice="lnbc..."`
   - x402: Shows `PAYMENT-REQUIRED` header with JSON payload
   - Label: "Server requires payment — returns 402 with payment instructions"

3. **Agent Pays Invoice** (L402) / **Agent Signs Payment** (x402)
   - L402: Shows decoded invoice details (amount, description, expiry)
   - x402: Shows payment requirement details (asset, amount, facilitator)
   - Label: "Agent pays Lightning invoice" / "Agent signs USDC transfer"

4. **Agent Retries with Token**
   - L402: Shows `Authorization: L402 <macaroon>:<preimage>`
   - x402: Shows `X-PAYMENT` header with signed payload
   - Label: "Agent retries request with proof of payment"

5. **Server Returns 200**
   - Shows: sample JSON response body
   - Label: "Server validates payment and returns the requested data"

### Protocol Toggle
- Toggle between L402 and x402 views
- Updates steps 2-4 to show protocol-specific headers/payloads
- Default: L402 (Lightning Labs audience)

### Markup
- Section with class `demo-panel demo-flow`
- Each step is a card with class `demo-flow-step`
- Step number indicator (1-5) with connecting line
- Active step highlighted (optional: animate on scroll)
- Code blocks in steps use class `demo-code-block` (monospace, dark bg)

---

## "Check Endpoint" Button (L402-Gated Health Check — Phase 2)

### Current Phase (stub)
- Button visible in Panel 2 search results (per-result) and/or as a standalone section
- Button text: "Check Endpoint Health"
- Button is **disabled** with `title="Coming soon — L402-gated"`
- Visual: grayed out, cursor not-allowed

### Future Phase (wired up)
- Calls `GET /api/v1/healthcheck?url=<endpoint>`
- Returns live probe result (status, latency, protocol headers, verification)
- Gated behind L402 payment (402 challenge on first call)

---

## New API Endpoint: `GET /api/v1/demo/probe-sample`

Returns a curated recent health check with service metadata, suitable for the flow visualization panel.

### Parameters
| Param | Type | Description |
|-------|------|-------------|
| `protocol` | string | Filter by protocol: `L402` or `x402`. Default: `L402` |

### Response
```json
{
  "service": {
    "name": "Example Weather API",
    "url": "https://api.example.com/weather",
    "protocol": "L402",
    "price_sats": 10,
    "category": "data/weather",
    "provider": "WeatherCorp"
  },
  "healthCheck": {
    "checked_at": "2026-03-14T12:00:00Z",
    "status": "healthy",
    "response_time_ms": 145,
    "http_status": 402
  },
  "flow": {
    "request": "GET https://api.example.com/weather",
    "responseStatus": 402,
    "protocolHeaders": {
      "L402": "WWW-Authenticate: L402 macaroon=\"AGIAJEem...\", invoice=\"lnbc100n1...\"",
      "parsed": {
        "scheme": "L402",
        "macaroon_preview": "AGIAJEem...",
        "invoice_preview": "lnbc100n1...",
        "amount_sats": 10,
        "description": "Weather API access"
      }
    },
    "retryHeader": "Authorization: L402 <macaroon>:<preimage>",
    "successStatus": 200
  }
}
```

### Logic
1. Query services table for a healthy endpoint matching the protocol filter
2. Prefer services with recent health checks and good reliability
3. Join with latest health_check row for the selected service
4. Construct the flow object with protocol-appropriate headers
5. For L402: show WWW-Authenticate header format
6. For x402: show PAYMENT-REQUIRED header format with facilitator details
7. If no healthy service found, return a static example

---

## New API Endpoint: `GET /api/v1/healthcheck` (Stub)

### Current Phase
- Returns `501 Not Implemented` with JSON body:
```json
{
  "error": "Not Implemented",
  "message": "L402-gated health check endpoint coming soon. This endpoint will allow you to run a live probe against any URL and get real-time verification results.",
  "status": 501
}
```

### Future Phase
- Accepts `?url=<endpoint>` parameter
- Runs a live health check probe
- Returns probe results (status, latency, protocol headers, verification flags)
- Gated behind L402 payment

---

## Navigation Update

Add "Demo" link to the site header nav in `layout.js`:
```
Directory | About | Demo | API
```

Position: between "About" and "API" for natural flow (learn about → see demo → use API).

---

## CSS Requirements

All new styles added to `styles.js`, using existing CSS variables.

### Demo Page Layout
- `.demo-page` — max-width container, padding
- `.demo-panel` — surface background, border, rounded corners, margin between panels
- `.demo-panel h2` — panel title (uppercase, muted, like detail-section h2)

### Ecosystem Dashboard
- `.demo-stat-cards` — grid of stat cards
- `.demo-stat-card` — individual stat with large number + label
- `.demo-protocol-compare` — side-by-side protocol cards
- `.demo-health-bars` — horizontal bar chart for health breakdown

### Interactive Search
- `.demo-search-form` — search form layout
- `.demo-search-input` — styled search input
- `.demo-filter-chips` — horizontal filter row
- `.demo-search-results` — results container
- `.demo-result-card` — individual result card (clickable, expandable)
- `.demo-result-detail` — expanded detail section
- `.demo-mcp-query` — MCP query display block

### Flow Visualization
- `.demo-flow-steps` — vertical step container with connecting line
- `.demo-flow-step` — individual step card
- `.demo-flow-step-number` — circular step number indicator
- `.demo-code-block` — code display within steps (like example-block)
- `.demo-flow-toggle` — protocol toggle buttons

### Healthcheck Button
- `.demo-healthcheck-btn` — styled button (accent bg when active, gray when disabled)
- `.demo-healthcheck-btn[disabled]` — grayed out, cursor not-allowed

### Responsive
- At 768px: stack protocol comparison cards vertically
- At 768px: full-width search form
- At 768px: flow steps remain vertical (already good)
