# Security Policy

## Reporting a vulnerability

Please do **not** open a public GitHub issue for suspected vulnerabilities.

Email: **hello@402index.io**.

Please include:

- A description of the issue and, if possible, a minimal proof-of-concept.
- The affected component (live site, HTTP API, MCP server, aggregator, etc.).
- Your assessment of impact and any suggested mitigations.

We will acknowledge receipt within 72 hours and aim to triage within a week. If the issue is confirmed and fix-worthy, we'll coordinate a disclosure timeline with you — typically 30–90 days depending on severity and user-facing impact. Credit is offered in release notes unless you prefer anonymity.

## Scope

In scope:

- The live site at `402index.io`
- The HTTP API (`/api/v1/*`)
- The probe / verifier that validates L402 and x402 challenges during registration and health checks
- The `@402index/mcp-server` npm package
- This source repository (`ryanthegentry/402index`)

Out of scope:

- Third-party services we aggregate from (Bazaar, Satring, l402apps, provider endpoints). Please report those to their operators.
- Social-engineering or physical attacks.
- Denial-of-service against the public API via rate-limit exhaustion, unless it demonstrates an amplification or asymmetric-cost vector beyond ordinary scraping.

## Threat model summary

402 Index aggregates untrusted external data (provider metadata, endpoint URLs, price claims) and exposes it to AI agents. The primary threats are:

- **SSRF via health checks.** The probe fetches arbitrary URLs submitted by third parties. We block private IPv4 ranges, localhost, cloud metadata endpoints (169.254.169.254), and non-HTTP schemes, and we set `redirect: 'manual'` to prevent redirect-based bypasses. See `src/health/checker.js`.
- **Malicious or low-quality listings.** Aggregators can import untrusted metadata at volume. HTML output is escaped via `escapeHtml()` on every user-visible field. Manual curation happens via `listings/featured.yaml`.
- **Resource exhaustion.** The API is rate-limited via `express-rate-limit`. All list endpoints enforce `LIMIT` (max 200) and `OFFSET` ceilings. `health_checks` rows older than 3 days are pruned.
- **Credential leakage.** No user credentials are accepted by the public API. Webhook secrets are HMAC-SHA256, stored hashed. Environment variables (API keys, Nostr private key) are never logged.
- **Registration abuse.** `POST /api/v1/register` is rate-limited and requires the probe to validate the endpoint before listing. Domain verification is a separate step for the `verified` filter.

## Hardening posture

- Parameterized SQL everywhere via `better-sqlite3` (`@param` or positional). No string concatenation in queries.
- `helmet` middleware for standard HTTP security headers (CSP, X-Frame-Options, X-Content-Type-Options, HSTS).
- `app.disable('x-powered-by')` to avoid leaking framework fingerprint.
- Global Express error handler redacts stack traces in production.
- Dependencies are monitored via GitHub Dependabot and weekly security audits (`.github/workflows/weekly-security.yml`).

## Supported versions

Security fixes are applied to `master` and published as new releases of `@402index/mcp-server`. There is currently no LTS branch policy. Run `master` (or the latest published npm version of the MCP server) to stay current.
