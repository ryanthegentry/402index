# CLAUDE.md

Notes for coding agents (and humans) working in this repository.

Private per-developer overrides can live in `CLAUDE.local.md` (gitignored). This file is the committed, shared baseline.

## Project Structure

```
402index/
├── src/
│   ├── server.js          # Express app entry point
│   ├── db.js              # SQLite setup + migrations
│   ├── scheduler.js       # Background job scheduling
│   ├── listings.js        # YAML listing loader + featured flags
│   ├── routes/
│   │   ├── api.js         # /api/v1/services, /register, /webhooks, /opportunities, /admin
│   │   └── pages.js       # HTML routes: /, /service/:id, /about, /demo, /feed.xml, /opportunities
│   ├── queries/
│   │   └── services.js    # Shared query builder + column definitions
│   ├── aggregators/
│   │   ├── bazaar.js      # x402 Bazaar polling + normalization
│   │   ├── satring.js     # Satring L402 polling + normalization
│   │   └── l402apps.js    # l402apps.com polling (HTML scrape, daily)
│   ├── health/
│   │   └── checker.js     # Health check runner (configurable interval) + event emission
│   ├── middleware/         # Express middleware (L402, rate limiting, helmet)
│   ├── services/
│   │   ├── events.js      # Central event dispatcher: emit() → webhooks + Nostr + email
│   │   ├── webhooks.js    # Webhook CRUD + HMAC-SHA256 delivery
│   │   ├── nostr.js       # Nostr NIP-99 (kind 30402) event publishing
│   │   ├── opportunities.js
│   │   ├── btc-price.js
│   │   ├── l402-provider.js
│   │   ├── l402-verify.js
│   │   ├── probe-live.js
│   │   ├── url-normalize.js
│   │   └── wellknown-discovery.js
│   └── views/             # HTML template literals (home, service, about, demo, feed, etc.)
├── scripts/               # Standalone ops (poll, healthcheck, backfills)
├── listings/              # YAML files for manually curated / exclusive listings
├── test/                  # Tests (node:test)
├── data/                  # SQLite DB file (gitignored)
├── docs/                  # Feature specs + API docs
├── mcp-server/            # @402index/mcp-server (own package, published to npm)
├── CLAUDE.md              # This file (public, committed)
├── CLAUDE.local.md        # Private per-developer overrides (gitignored)
├── CONTRIBUTING.md
├── SECURITY.md
├── LICENSE
└── package.json
```

## Tech Stack

- Node.js ≥18 + Express
- SQLite via `better-sqlite3` (with optional `sqlite-vec` for semantic search)
- Static HTML (no framework — template literals in JS)
- YAML for manual listings (`js-yaml`)
- Deployed on Railway (persistent volume for SQLite)

## Commands

```bash
npm run dev                # Start dev server with nodemon
npm start                  # Start production server
npm run poll               # Run Bazaar + Satring poll manually
npm run healthcheck        # Run health checks manually
npm run backfill:embeddings # Backfill service embeddings (requires embeddings service)
npm test                   # Run tests (node:test)
npm run test:e2e           # Run Playwright e2e tests
```

## Code Style

- ES modules (`import`/`export`)
- Prefer `async`/`await` over callbacks
- Error handling: log and continue for aggregator/health failures — never crash the server
- Keep files small. One module = one responsibility.
- Single quotes, semicolons where required by tooling.

## Bug Fix Protocol

When fixing a bug:

1. FIRST write a failing test that reproduces the bug exactly
2. Verify the test fails for the right reason
3. Fix the bug with the minimum change required
4. Verify the test now passes
5. Run the full test suite to confirm no regressions

Never skip step 1. If you can't write a failing test, the bug isn't well-enough understood to fix.

## AI-Assisted Workflow

This repository uses AI coding agents as implementation and review assistants, not as commit authorities.

- Work starts from a concrete issue, spec, or failing behavior. Agents receive bounded tasks with the expected files, tests, and acceptance criteria.
- Bug fixes follow the failing-test-first protocol above. The red test must fail for the behavior under investigation before code is changed.
- Test assertion changes require an explicit commit-body marker documented in `CONTRIBUTING.md`: `BEHAVIOR-CHANGE:` for intentional contract changes or `ASSERTION-REFACTOR:` for non-behavioral assertion rewrites.
- Dispatch automation may break larger work into small tasks, but generated patches are reviewed, edited, and committed by the maintainer.
- The codex-review workflow is a second-pass review tool. Its findings are treated as review input, not automatic approval.
- Private local overrides and dispatch state stay outside the repository. Public agent instructions belong in this file and `AGENTS.md`.

## Key Design Decisions

- **SQLite, not Postgres.** Solo operations, no separate DB service. Single file. Fine at this scale.
- **DELETE journal mode, not WAL.** WAL on network-attached volumes has bitten this project before. DELETE is more stable for the Railway topology.
- **Health-check pruning.** `health_checks` is an append-only, high-frequency table. Rows older than 3 days are deleted on each run to prevent unbounded growth.
- **No frontend framework.** HTML template literals in JS. Ship quickly; optimize later if needed.
- **Health check: 402 = healthy.** For L402/x402 services, a 402 response means the paywall is working. A 200 usually indicates misconfiguration. Expected response codes are per-protocol.
- **Dedup on URL + protocol.** When re-polling Bazaar/Satring, match on endpoint URL + protocol. Update metadata, preserve our health data.
- **YAML listings are the source of truth for manually curated providers.** Loaded on startup and synced to the DB.
- **SSRF-safe health checks.** `src/health/checker.js` blocks private IPv4 ranges, localhost, cloud metadata endpoints, and non-HTTP schemes. Redirects are `manual`, not `follow`.

## Distribution Layer

- **HTTP API:** `GET /api/v1/services`, `/api/v1/health`, `/api/v1/opportunities`, `POST /api/v1/register`.
- **MCP server:** `@402index/mcp-server` on npm — see `mcp-server/`.
- **RSS feed:** `GET /feed.xml` — RSS 2.0 with `l402:service` XML namespace. Filters: `?protocol`, `?health`, `?type=new`.
- **Webhooks:** `POST/GET/DELETE /api/v1/webhooks` — HMAC-SHA256 signed delivery, auto-deactivate after 10 failures.
- **Nostr:** NIP-99 kind 30402 events. Requires `NOSTR_PRIVATE_KEY` + `NOSTR_RELAY_URLS` env vars.
- **Event dispatcher:** `emit(event, service, db)` in `src/services/events.js` — fires webhooks + Nostr + email in parallel.

## Operational Notes

- Pushes to `master` auto-deploy to Railway. Do not remind the developer to deploy after a push lands.
- Prefer small, reviewable changes over large rewrites.
