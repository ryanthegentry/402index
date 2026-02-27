# 402index.io

Protocol-agnostic directory of paid APIs (L402 + x402) for AI agents. Distribution layer for the Golem project.

## Project Structure

```
402index/
├── src/
│   ├── server.js          # Express app entry point
│   ├── db.js              # SQLite setup + migrations
│   ├── routes/
│   │   ├── api.js         # /api/v1/services, /api/v1/health, /api/v1/categories
│   │   └── pages.js       # HTML routes: /, /service/:id, /about
│   ├── aggregators/
│   │   ├── bazaar.js      # x402 Bazaar polling + normalization
│   │   └── satring.js     # Satring L402 polling + normalization
│   ├── health/
│   │   └── checker.js     # Health check runner (every 15min)
│   └── views/             # HTML templates (plain JS template literals, no framework)
├── listings/              # YAML files for exclusive/manual listings
├── data/                  # SQLite DB file (gitignored)
├── CLAUDE.md
├── package.json
└── README.md
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

## Key Design Decisions

- **SQLite, not Postgres.** Solo dev, no ops burden. Single file. Good enough for thousands of rows.
- **No frontend framework.** HTML template literals in JS. Ship fast. Optimize never (or much later).
- **Health check: 402 = healthy.** For L402/x402 services, a 402 response means the paywall is working. A 200 might mean misconfiguration. Check for expected response codes per protocol.
- **Dedup on URL + protocol.** When re-polling Bazaar/Satring, match on endpoint URL + protocol. Update metadata, preserve our health data.
- **YAML listings are the source of truth for exclusive providers.** Script reads them on startup and syncs to DB.

## Important Context

- Read `docs/technical-spec.md` for full schema and API design
- Read `docs/competitive-intel.md` for ecosystem context
- Read `docs/strategy-v2.md` for product strategy and priorities
- Read `docs/provider-outreach.md` for target provider list and templates
- This is a loss leader for the Golem project. Speed > perfection. Ship ugly.
