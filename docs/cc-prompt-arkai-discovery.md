# CC Prompt: The Ark AI — L402 Endpoint Discovery & Registration

## Context

402index.io is a registry of L402/x402 paid API endpoints. The Ark AI (thearkai.com) is an L402 provider currently listed via Satring with a single endpoint that shows as degraded. From their website, they appear to have 25+ L402-gated developer tools — Code Review, Bug Finder, SQL Optimizer, Unit Test Gen, Dockerfile, etc. — priced in sats (5-2000 sats per call).

Their About page shows an L402 flow diagram with:
- Step 1: `POST /l402/task` with `Content-Type: application/json` and body `{"task": "summarize", "input": "Your text here"}`
- Response: `402 Payment Required` with `WWW-Authenticate: L402 invoice="lnbc...", macaroon="..."`
- Step 2: Pay invoice, retry with `Authorization: L402 {macaroon}:{preimage}`

The developer page lists these tools (with sats pricing from the developer page view):

**Code & Development:**
- Code Review (50 sats)
- Bug Finder (50 sats)
- Code Explainer (5 sats)
- Regex Generator (10 sats)
- SQL Optimizer (30 sats)
- SQL from English (20 sats — on services page as 200 sats, discrepancy)
- Doc Generator (100 sats)
- Commit Message (5 sats)
- Unit Test Generator (50 sats)
- Code Generation (50 sats — on services page as 500 sats)
- HTML/CSS Generator (100 sats — on services page as 1000 sats)
- Tutorial Generator (200 sats — on services page as 2000 sats)

**DevOps & Infrastructure:**
- Dockerfile (30 sats)
- CI/CD Pipeline (50 sats)
- Nginx Config (20 sats)
- Docker Compose (50 sats)

**Data & Utilities:**
- JSON↔CSV (10 sats)
- Data Cleaner (30 sats)
- API Parser (20 sats)
- Cron Expression (5 sats)
- README (50 sats)
- API Docs (100 sats)
- Tech Blog Post (200 sats)
- Changelog (30 sats)

**Unknown:** Whether these are all separate L402 endpoints or a single `/l402/task` endpoint with a `task` field selector.

## Goal

Discover all valid L402 endpoints from The Ark AI, probe each one, and register the working ones in the database. Expected outcome: 10-25 new L402 healthy endpoints.

## Research Phase (Do This First)

### Step 1: Check for .well-known discovery

```bash
curl -s https://thearkai.com/.well-known/l402-services | head -100
```

If this returns a JSON document listing endpoints, use it as the source of truth for URLs, methods, and schemas. If 404 or empty, proceed to manual discovery.

### Step 2: Probe the generic L402 endpoint

Based on the About page flow diagram, the base endpoint appears to be `POST /l402/task`:

```bash
# Test the generic endpoint with a simple task
curl -s -D - -X POST -H "Content-Type: application/json" \
  -d '{"task": "summarize", "input": "test"}' \
  https://thearkai.com/l402/task 2>&1 | head -30
```

Check if this returns 402 with L402 challenge. If so, the service might be a single-endpoint model where `task` selects the tool.

### Step 3: Discover individual tool endpoints

The developer tools might have individual URLs. Try common patterns:

```bash
# Pattern A: /l402/{tool-name}
curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" \
  -d '{"input": "test"}' https://thearkai.com/l402/code-review

# Pattern B: /api/l402/{tool-name}
curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" \
  -d '{"input": "test"}' https://thearkai.com/api/l402/code-review

# Pattern C: /api/{tool-name}
curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" \
  -d '{"input": "test"}' https://thearkai.com/api/code-review
```

Try with multiple tool names (code-review, bug-finder, sql-optimizer, commit-message, dockerfile). Use both kebab-case and snake_case. Also try the Satring-registered URL if one exists:

```bash
# Check what Satring has for this provider
node -e "
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || '/data/402index.db');
db.prepare(\"SELECT id, url, name, health_status, http_method, probe_body FROM services WHERE provider LIKE '%ark%' OR url LIKE '%thearkai%'\").all().forEach(r => console.log(JSON.stringify(r)));
db.close();
"
```

### Step 4: Probe all discovered endpoints

For each URL pattern that returns 402, probe it fully:

```bash
curl -s -D - -X POST -H "Content-Type: application/json" \
  -d '{"task": "code-review", "input": "function add(a,b) { return a + b }"}' \
  https://thearkai.com/l402/task 2>&1 | head -30
```

Verify:
- HTTP 402 response
- `WWW-Authenticate` header present
- Scheme is `L402` or `LSAT`
- `macaroon=` field present
- `invoice=` field present with `lnbc` prefix

### Step 5: Document findings

For each endpoint discovered, record:
- Full URL
- HTTP method (expect POST for all)
- Required body fields (task name, input format)
- probe_body needed (the minimal JSON that triggers 402)
- Price in sats (from the developer page)
- Response status code
- Whether L402 challenge is valid

**Critical question:** Is this one endpoint with a `task` selector, or many endpoints? If it's one endpoint (`POST /l402/task` with different `task` values), we should register it as **one service** — not 25 separate entries for the same URL. Multiple task values on the same URL would all share one health check.

If each tool has its own URL path, register them individually (like we did with Sats4AI).

## Implementation

### Create `scripts/register-arkai.mjs`

Follow the same pattern as `scripts/register-sats4ai.mjs`:

1. Connect to SQLite (`process.env.DB_PATH || '/data/402index.db'`)
2. For each discovered L402 endpoint:
   - Upsert into services table with:
     - `id`: UUID (or preserve existing ID on conflict)
     - `name`: "The Ark AI: {Tool Name}"
     - `description`: from developer page descriptions
     - `url`: discovered endpoint URL
     - `protocol`: 'L402'
     - `price_sats`: from developer page (use the lower/developer-page pricing, not the services-page pricing)
     - `price_usd`: convert using BTC/USD rate from `btc-price` module or hardcode ~$71,000
     - `payment_asset`: 'BTC'
     - `payment_network`: 'Lightning'
     - `category`: 'ai' for code/dev tools, 'devops' for infrastructure tools, 'utility' for data tools
     - `provider`: 'The Ark AI'
     - `source`: 'discovery' (manual discovery by probing)
     - `http_method`: 'POST'
     - `probe_body`: the minimal JSON body that triggers 402 (from research)
     - `health_status`: 'unknown'
   - Use `ON CONFLICT(url, protocol) DO UPDATE`
3. Clean up any existing entries that are wrong (e.g., the Satring entry if it points to a wrong URL)
4. Print summary: inserted, updated, skipped, errors

### Handle the single-endpoint case

If The Ark AI uses a single `/l402/task` endpoint with a `task` field selector:
- Register it as ONE service entry
- `name`: "The Ark AI: Multi-Tool L402 Gateway"
- `description`: "25+ developer tools (code review, bug finder, SQL optimizer, etc.) accessible via task selector. POST with {\"task\": \"tool-name\", \"input\": \"...\"}"
- `probe_body`: `{"task": "commit-message", "input": "test"}` (cheapest task at 5 sats)
- `price_sats`: null (varies by task, 5-2000 sats)

### Test locally

```bash
node scripts/register-arkai.mjs
```

Verify the output shows correct upserts.

## Commit

```bash
git add scripts/register-arkai.mjs
git commit -m "Add The Ark AI endpoint discovery and registration (L402 developer tools)"
git push origin master
```

## Do NOT do these things

- Do not modify the health checker, aggregators, or web UI
- Do not run the script against production — Ryan will do that via `railway ssh`
- Do not guess endpoints — probe them first and only register confirmed 402s
- Do not register endpoints that don't return valid L402 challenges
- Do not register the same URL multiple times with different task parameters

## Self-Landing

When finished, self-land per ~/agent-state/CLAUDE.md:
- Journal with descriptor (e.g., `journals/2026-03-06-arkai-discovery.md`)
- Update continuation.md with pending manual action
- Append to status.md Recent Log
- `git add . && git commit && git push` the agent-state repo
- Never use bare `YYYY-MM-DD.md` for journal filenames. Never modify status.md top-level fields.

## Definition of Done

- All potential endpoint patterns probed and documented
- Registration script written with correct probe bodies
- Tested locally
- Clear documentation of whether this is single-endpoint or multi-endpoint
- Committed and pushed to master
- Agent-state landed
