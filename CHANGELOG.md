# Changelog

## [Unreleased]

### Fixed
- `publish-mcp.yml`: Added `npm_check` guard to skip npm publish when the tagged version already exists on the registry, preventing E403 failures on re-triggered workflows (#248)
- `mcp-server/src/index.ts`: `fetchJson` now retries on 5xx responses (2 attempts by default, 500ms backoff, configurable via `FETCH_RETRIES` env var) — transparent to callers, no breaking changes

### Changed
- MCP server contract tests (`tools.test.js`, `mcp-0.2.5-parity.test.js`, `mcp-verified.test.js`) refactored to use hand-rolled `globalThis.fetch` stubs backed by captured JSON fixtures, eliminating live HTTP calls during `npm --prefix mcp-server test`
- `mcp-drift-check.yml`: Added `schedule` trigger (daily 08:00 UTC) with a `live-smoke` job that runs contract tests against production (`continue-on-error: true`)
