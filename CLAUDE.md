# 402index.io

Protocol-agnostic directory of paid APIs (L402 + x402) for AI agents.

## Project Structure

```
402index/
├── src/
│   ├── server.js          # Express app entry point
│   ├── db.js              # SQLite setup + migrations (incl. webhooks table)
│   ├── scheduler.js       # Background job scheduling
│   ├── listings.js        # YAML listing loader + featured flags
│   ├── routes/
│   │   ├── api.js         # /api/v1/services, /register, /webhooks, /opportunities, /admin
│   │   └── pages.js       # HTML routes: /, /service/:id, /about, /demo, /feed.xml, /opportunities
│   ├── queries/
│   │   └── services.js    # Shared query builder + column definitions
│   ├── aggregators/
│   │   ├── bazaar.js      # x402 Bazaar polling + normalization
│   │   ├── bazaar-utils.js
│   │   ├── satring.js     # Satring L402 polling + normalization
│   │   ├── satring-utils.js
│   │   ├── l402apps.js    # l402apps.com polling (HTML scrape, daily)
│   │   └── l402apps-utils.js
│   ├── health/
│   │   └── checker.js     # Health check runner (every 15min) + event emission
│   ├── middleware/         # Express middleware (L402, rate limiting)
│   ├── services/
│   │   ├── events.js      # Central event dispatcher: emit() → webhooks + Nostr + email
│   │   ├── webhooks.js    # Webhook CRUD + HMAC-SHA256 delivery
│   │   ├── nostr.js       # Nostr NIP-99 (kind 30402) event publishing
│   │   ├── opportunities.js # Ecosystem gap analysis queries
│   │   ├── btc-price.js   # BTC/USD price cache
│   │   ├── l402-provider.js # L402 challenge creation
│   │   ├── l402-verify.js # L402 endpoint verification
│   │   ├── notify.js      # Email notifications (SendGrid)
│   │   ├── probe-live.js  # Live SSE endpoint probing
│   │   ├── url-normalize.js # URL normalization
│   │   └── wellknown-discovery.js # .well-known probe config discovery
│   └── views/
│       ├── layout.js      # HTML layout wrapper + nav
│       ├── styles.js      # CSS styles
│       ├── helpers.js     # escapeHtml(), escapeXml()
│       ├── home.js        # Directory listing page
│       ├── service.js     # Service detail page
│       ├── about.js       # About page
│       ├── demo.js        # Interactive demo (3 panels)
│       ├── api-docs.js    # API documentation page
│       ├── feed.js        # RSS 2.0 feed with l402: XML namespace
│       └── opportunities.js # Ecosystem opportunities page
├── scripts/
│   ├── poll.js            # Standalone: npm run poll
│   └── healthcheck.js     # Standalone: npm run healthcheck
├── listings/              # YAML files for exclusive/manual listings
├── test/                  # Tests (node:test, 686 passing)
├── data/                  # SQLite DB file (gitignored)
├── docs/                  # Feature specs + research docs
├── mcp-server/            # MCP server for AI agent integration
├── CLAUDE.md
├── CONTRIBUTING.md
└── package.json
```

## Tech Stack

- Node.js + Express
- SQLite via better-sqlite3
- Static HTML (no framework — template literals in JS)
- YAML for manual listings (js-yaml)
- Deployed on Railway or Fly.io

## Commands

```bash
npm run dev          # Start dev server with nodemon
npm start            # Start production server
npm run poll         # Run Bazaar + Satring poll manually
npm run healthcheck  # Run health checks manually
npm test             # Run tests
```

## Code Style

- ES modules (import/export)
- Single quotes, no semicolons (except where required)
- Prefer async/await over callbacks
- Error handling: log and continue for aggregator/health failures — never crash the server
- Keep files small. One module = one responsibility.

## Bug Fix Protocol

When fixing a bug:
1. FIRST write a failing test that reproduces the bug exactly
2. Verify the test fails for the right reason
3. Fix the bug with the minimum change required
4. Verify the test now passes
5. Run the full test suite to confirm no regressions

Never skip step 1. If you can't write a failing test, the bug isn't well-enough understood to fix.

## Key Design Decisions

- **SQLite, not Postgres.** Solo dev, no ops burden. Single file. Good enough for thousands of rows.
- **No frontend framework.** HTML template literals in JS. Ship fast. Optimize never (or much later).
- **Health check: 402 = healthy.** For L402/x402 services, a 402 response means the paywall is working. A 200 might mean misconfiguration. Check for expected response codes per protocol.
- **Dedup on URL + protocol.** When re-polling Bazaar/Satring, match on endpoint URL + protocol. Update metadata, preserve our health data.
- **YAML listings are the source of truth for exclusive providers.** Script reads them on startup and syncs to DB.

## Distribution Layer

- **RSS feed:** `GET /feed.xml` — RSS 2.0 with `l402:service` XML namespace. Filters: `?protocol`, `?health`, `?type=new`
- **Webhooks:** `POST/GET/DELETE /api/v1/webhooks` — HMAC-SHA256 signed delivery, auto-deactivate after 10 failures
- **Nostr:** NIP-99 kind 30402 events. Requires `NOSTR_PRIVATE_KEY` + `NOSTR_RELAY_URLS` env vars.
- **Event dispatcher:** `emit(event, service, db)` in `src/services/events.js` — fires webhooks + Nostr + email in parallel
- **Opportunities:** `GET /api/v1/opportunities` (JSON) + `GET /opportunities` (HTML) — ecosystem gap analysis

## TODOs

- [x] Filter dropdowns auto-submit on change (onchange="this.form.submit()")
- [ ] 30 Satring services have null price_sats — data cleanup needed
- [ ] 60 services have null/zero price_usd — data cleanup or better conversion logic
- [ ] Bazaar polling caps at ~3000-4500 per run due to Coinbase rate limits (429s). Subsequent hourly polls pick up more, but a full sync of all ~13K services takes multiple runs.

## Important Context

- Every time we push to Github, Railway auto-deploys. Do not remind Ryan to deploy to Railway in the same message as telling him that a push to Github occurred, as that push caused a Railway auto-deploy.
- Read `docs/competitive-intel.md` for competitive landscape (Merit Systems, x402 ecosystem, our verified supply)
- Read `docs/strategy-v2.md` for founding strategic reasoning (historical — see `~/agent-state/projects/402index/status.md` and `roadmap.md` for current state)
- For current project state, outreach status, and next priorities: `~/agent-state/projects/402index/status.md`
- For phased roadmap: `~/agent-state/projects/402index/roadmap.md`
- Speed > perfection. Ship ugly.
