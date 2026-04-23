# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-04-23

### Added
- `USER_AGENT` constant exported from `src/index.ts` for observability (registry requests now identify themselves as `402index-mcp/0.3.0`)
- Runtime version-drift test via `InMemoryTransport` — asserts the server version reported at runtime matches `package.json#version`
- CLI symlink spawn tests (`test/cli-invocation.test.js`) — covers `npx`, global install, and `node_modules/.bin` invocation paths

### Fixed
- `isCLI` detection now uses `realpathSync` on both sides of the entrypoint comparison so that npm bin symlinks (`node_modules/.bin/mcp-server`, global installs via `npm install -g`) correctly invoke `main()` instead of silently no-op'ing (PR #178)
- `server.json#repository.url` corrected from `ryanthegentry/402index-mcp-server` (stale standalone repo) to `ryanthegentry/402index` (monorepo) with `subfolder: "mcp-server"` hint for downstream tooling

### Infrastructure
- Ported to monorepo at `mcp-server/` (source of truth: `ryanthegentry/402index`)
- Tag-triggered CI publish pipeline (`publish-mcp.yml`) — keyless OIDC auth to both npm and MCP Registry; no long-lived secrets

---

## [0.2.5] - 2024-03-24

### Fixed
- `fileURLToPath` entrypoint guard removed — previously prevented `main()` from running under `npx` (silent exit with no error)
- Documented npm scoped bin resolution bug: `npx @402index/mcp-server` fails due to known npm bug; workaround is `npm install -g`

### Added
- `zod` added as explicit dependency (fixes silent crash on pnpm/yarn PnP installs where peer deps are not hoisted)

### Documentation
- README overhauled with updated install instructions
- `llms-install.md` added for AI-assistant-friendly installation guidance
- Logo committed to repo

> **Note:** 0.2.5 was published from the now-frozen standalone repo `ryanthegentry/402index-mcp-server`.
> All subsequent releases are published from this monorepo.
