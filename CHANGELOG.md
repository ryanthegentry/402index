# Changelog

## [Unreleased]

### Added
- `counters` table (`src/db.js`): durable, never-pruned key/value aggregates — `mcp_queries_lifetime`, `health_write_failures_lifetime`, `last_health_cycle`, `health_schema_invalid`. Transactional with the writes they count and visible across both the server process and `scripts/healthcheck.js` (#313)
- Per-protocol cycle reconciliation (`src/health/checker.js`): `probed` (by result status, including `unknown`/`error`), `sibling_updated`, `skipped_unprobeable`, `excluded_inactive`, `persist_failed`, and an `unaccounted` residual that must be 0. Buckets partition the cycle-start snapshot of every row carrying the protocol — the real denominator behind the digest's "1,218" (#313)
- Reconciliation reports `added_mid_cycle` and `vanished_mid_cycle` per protocol and per cycle. The pollers share the health cycle's hourly interval and insert with `status` defaulting to `active`, so a multi-minute cycle routinely races inserts, deactivations and purges; those rows are reported separately instead of being folded into a denominator they never had a full cycle's chance to land in (#313)
- `GET /api/v1/digest`: new `health` section with `write_failures_lifetime`, `last_cycle` reconciliation, `health_schema_invalid` (present only when the status enum is broken), and `health_schema_probe_error` (present only when the boot probe could not reach a verdict) (#313)
- `SKILL.md`: added `### Known-good endpoints (fallback)` sub-section under Quick Start with four verified endpoints — one per protocol (L402, x402, MPP) plus a dual-rail example (llm402 Kimi-K2.6, L402 + x402) — for use when `search_services` returns errors (#250)
- `SKILL.md`: added `version: 0.1.0` to YAML frontmatter to match plugin manifest semver

### Changed
- **BEHAVIOR-CHANGE** — `uptime_30d` now excludes `rate_limited` checks from both numerator and denominator. A 429 means the provider throttled our prober and carries no availability information; counting it as downtime scored the most popular endpoints in the index as unreliable (#313)
- `GET /api/v1/digest`: `mcp_queries_total` is now a true lifetime counter (was a 90-day `COUNT` over `query_log`, which is why it dropped between digests). Window aggregates are renamed `mcp_queries_90d` / `mcp_active_days_90d`, `mcp_counter_seeded_at` marks the discontinuity, and `mcp_active_days` emits the 90d value for one release alongside `mcp_active_days_deprecated: true` (#313)
- MCP traffic is classified by one predicate shared between the JS increment and every SQL window query (`MCP_USER_AGENT_SQL`, both halves lowercased). The JS half was case-sensitive while SQL `LIKE` is case-insensitive for ASCII, so a client sending `402Index-MCP` was counted in `mcp_queries_90d` but never in `mcp_queries_lifetime` (#313)
- `GET /api/v1/digest`: `mcp_counters_ua_attested: true` marks the MCP counters for what they are. The only gate on the increment is a client-controlled `User-Agent` substring and the lifetime total is never pruned, so it is a ceiling attested by clients, not a measurement — previously the number self-healed as poisoned rows aged out of the 90-day window (#313)
- `runHealthChecks()` return contract: adds `persistFailed`, `byProtocol`, `reconciliation`, `persistFailures`, `cycle`, and accepts `{ concurrency }`. Both callers (`src/scheduler.js`, `scripts/healthcheck.js`) report the same `formatCycleSummary()` line (#313)
- `SKILL.md`: generalized line 305 phrasing from "Claude Code" to "an agent" — ahead of plugin submissions to Codex/Cursor/Cline/Windsurf/Gemini CLI
- MCP server contract tests (`tools.test.js`, `mcp-0.2.5-parity.test.js`, `mcp-verified.test.js`) refactored to use hand-rolled `globalThis.fetch` stubs backed by captured JSON fixtures, eliminating live HTTP calls during `npm --prefix mcp-server test`
- `mcp-drift-check.yml`: Added `schedule` trigger (daily 08:00 UTC) with a `live-smoke` job that runs contract tests against production (`continue-on-error: true`)

### Fixed
- `health_checks` status CHECK constraint now includes `not_acceptable`, which `classifyHealthStatus` has emitted for HTTP 406 all along — roughly 10 endpoints per cycle were silently failing their status write. The enum is now defined once (`HEALTH_CHECK_STATUSES`) and the inline DDL, the migration, and `test/helpers/test-db.js` all derive from it (#313)
- `health_schema_invalid` is raised only when the boot probe returns a non-empty rejected list. A probe that could not run — most often `SQLITE_BUSY` from `scripts/healthcheck.js` booting against a mid-write server — is retried, then recorded under `health_schema_probe_error` instead. A latched false alarm on a healthy schema is how a loud failure signal gets ignored (#313)
- `migrateHealthChecksStatusConstraint()`: detects by insertability probe instead of DDL substring, prunes to retention and checks free space before starting, copies with explicit column lists (a positional `SELECT *` shuffled values when column order differed), verifies foreign keys before commit, and is loud on failure — the `console.warn` swallow is gone (#313)
- Health-check persists are isolated per row: one rejected write no longer aborts the remaining rows for that URL or the cycle. Failures are counted in `counters`, logged in their own category with service id and attempted status, and retried next cycle (#313)
- HTTP 406 rows now carry `error_message = 'HTTP 406: provider rejected request format before paywall'` (#313)
- `publish-mcp.yml`: Added `npm_check` guard to skip npm publish when the tagged version already exists on the registry, preventing E403 failures on re-triggered workflows (#248)
- `mcp-server/src/index.ts`: `fetchJson` now retries on 5xx responses (2 attempts by default, 500ms backoff, configurable via `FETCH_RETRIES` env var) — transparent to callers, no breaking changes
- `mcp-server/src/index.ts`: `FETCH_RETRIES` env var now handles non-finite / negative inputs safely, falling back to default 2 attempts instead of throwing
- `mcp-server/test/helpers/mock-fetch.js`: services route throws on unmatched queries instead of silently returning the limit=5 fixture — prevents tests from passing against stale data
