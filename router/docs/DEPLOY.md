# Deploying the router to Railway

The router runs as its **own Railway service** in the existing `402index`
project, beside (never touching) the main site service. `railway.json` in this
directory supplies build/start/healthcheck when the service's root directory is
set to `router/`.

## Service settings

- **Source:** this repo, root directory `router/`
- **Branch:** whatever Ryan points it at (`master` after merge)
- **Healthcheck:** none in `railway.json`. The SDK's app-wide host validation
  answers only for Hosts on `ROUTER_ALLOWED_HOSTS`, and Railway's internal
  prober does not present the public hostname — a platform healthcheck would
  fail while the app serves fine. Verify `/health` through the public domain
  after deploying instead.
- **Volume:** mount a volume at `/data` — the SQLite state (tokens, mandates,
  ledger, credentials) must survive deploys

## Environment variables

Names only; values live in Railway. Nothing here may appear in a transcript.

| Variable | Value shape | Why |
|---|---|---|
| `ROUTER_STATE_KEY` | 64 hex chars, freshly generated for prod | requestState AES key — do NOT reuse the dev key |
| `STRIPE_SECRET_KEY` | `rk_test_…` restricted TEST key | D10: test mode only; the fintech-legal gate governs live keys. Required scopes: Checkout Sessions W, SetupIntents W, PaymentIntents W, **Customers W** (setup binds every card to a Customer) |
| `ROUTER_DATA_DIR` | `/data` | on the volume |
| `ROUTER_BIND_HOST` | `::` | Railway healthchecks/edge reach containers over IPv6 — `0.0.0.0` never becomes healthy; config refuses any non-loopback bind unless auth is required |
| `ROUTER_AUTH_MODE` | `required` | reject unauthenticated /mcp (PRD constraint) |
| `ROUTER_LEGACY_MODE` | `stateless` | serve today's 2025-era clients (D1) |
| `SETTLEMENT_ADAPTER` | `golem-http` | settle over Golem's Railway server (D6/D7) |
| `GOLEM_HTTP_URL` | `https://golem-production.up.railway.app` | payer route host |
| `GOLEM_HTTP_API_KEY` | reference `${{golem.GOLEM_API_KEY}}` if same project, else set by hand | bearer for /api/pay-invoice |
| `ROUTER_MAX_SATS_PER_JOB` | `1500` | global per-job cap |
| `ROUTER_MAX_TOTAL_SATS` | `10000` | global outflow cap — deliberately far below the 34,882-sat wallet |
| `ROUTER_PRINCIPAL_MAX_SATS_PER_JOB` | `1500` | per-principal per-job cap |
| `ROUTER_PRINCIPAL_MAX_TOTAL_SATS` | `6000` | one token cannot spend the whole global cap |
| `ROUTER_RETRY_INTERVAL_MINUTES` | `30` | scheduled credential recovery (Group E) |
| `ROUTER_PUBLIC_URL` | the service's public URL | setup redirects + mcp add snippet |
| `ROUTER_ALLOWED_HOSTS` | the service's public hostname | /mcp answers only for this Host header (421 otherwise); empty disables the check |

`PORT` is injected by Railway; the router honors it when `ROUTER_PORT` is
unset.

## Order of operations

1. The golem `pay-invoice-route` PR must be **merged and deployed** before the
   router can settle. Until then every settlement attempt fails cleanly
   (`PAY_FAILED`, hold voided, agent charged $0) — annoying, not dangerous.
2. On the golem service, also set `GOLEM_PAY_MAX_SATS_PER_CALL` /
   `GOLEM_PAY_MAX_SATS_PER_DAY` (route-side caps independent of the router's).
3. Deploy the router service, confirm `/health`, visit `/setup`, register a
   test card (4242…), copy the token, and run the `claude mcp add` line from a
   machine that is not Atlas.
4. The first real settlement over this path is a deliberate, human-approved
   step — see the PRD's success criterion 9.

## What this deploy must never do

- Serve without auth on a public bind (config refuses to start).
- Carry a live Stripe key (D10).
- Depend on Atlas for anything (D8).
