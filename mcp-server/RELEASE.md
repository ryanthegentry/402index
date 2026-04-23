# MCP Server Release Runbook

## One-time setup

These steps are performed once and do not repeat per release.

**npm trusted publisher (OIDC) — already configured:**
- Package: `@402index/mcp-server`
- Trusted publisher: `ryanthegentry/402index`, workflow `publish-mcp.yml`, environment `mcp-publish`
- URL: https://www.npmjs.com/settings/402index/packages (org settings → granular access tokens → trusted publishers)
- No `NPM_TOKEN` needed. GitHub OIDC authenticates automatically.

**GitHub Actions environment `mcp-publish`:**
- Create at: https://github.com/ryanthegentry/402index/settings/environments
- Name: `mcp-publish` (no description field exists in GHA environments)
- Required reviewers: not available on Free plan for private repos. Activates automatically when repo flips public (per PRD #164 D11). Until then, the pre-tag local smoke test is the human gate.

**MCP Registry namespace:**
- Confirm `mcp-server/package.json#mcpName` === `mcp-server/server.json#name` === `io.github.ryanthegentry/402index`
- The `io.github.ryanthegentry/*` namespace is authorized via GitHub OIDC login
- No `MCP_REGISTRY_TOKEN` needed. `mcp-publisher login github-oidc` handles auth.

---

## Per-release ceremony

Follow these steps in order before pushing the tag.

1. **Bump versions** — update all three in lockstep:
   - `mcp-server/package.json#version` → `X.Y.Z`
   - `mcp-server/server.json#version` → `X.Y.Z`
   - `mcp-server/server.json#packages[0].version` → `X.Y.Z`

2. **Update CHANGELOG** — add entry under `mcp-server/CHANGELOG.md` in Keep-a-Changelog format.

3. **Commit:**
   ```bash
   git commit -am "chore(mcp-server): release vX.Y.Z"
   ```

4. **Local smoke test** (pre-tag human gate — see 7-tool smoke-test checklist below):
   ```bash
   cd mcp-server && npm pack
   npm install -g ./402index-mcp-server-X.Y.Z.tgz
   claude mcp add 402index-verify mcp-server
   # Exercise all 7 tool calls from the checklist
   npm uninstall -g @402index/mcp-server
   ```

5. **Tag and push:**
   ```bash
   git tag mcp-vX.Y.Z
   git push origin mcp-vX.Y.Z
   ```

6. **Watch CI** at https://github.com/ryanthegentry/402index/actions
   - CI artifact upload: verify tarball contents match allowlist
   - Once repo is public: approve the `mcp-publish` environment gate after reviewing CI artifact and local smoke results

---

## Failure recovery

**Tarball allowlist diff failed:**
- Investigate which new file appeared in the tarball
- If legitimate: add it to `mcp-server/.tarball-allowlist.txt`, commit, push fix, then re-tag
- If accidental: remove the file from `mcp-server/` (check `.npmignore` or `package.json#files`)

**`npm publish` failed after tagging:**
- npm refuses to re-publish a version number even if it failed mid-flight
- Must bump to the next patch version: delete the failed tag, bump version, commit, re-cut tag
  ```bash
  git tag -d mcp-vX.Y.Z
  git push origin :refs/tags/mcp-vX.Y.Z
  # bump version, commit, re-tag at next patch
  ```

**MCP Registry update failed:**
- npm publish succeeded; registry metadata is patchable manually
- Run locally:
  ```bash
  ./mcp-publisher login github   # interactive, opens browser
  ./mcp-publisher publish mcp-server/server.json
  ```
- Registry is in preview — transient failures are expected

**Rollback after publish:**
- Prefer `npm deprecate` over unpublish (unpublish makes the version number permanently unusable):
  ```bash
  npm deprecate @402index/mcp-server@X.Y.Z "use X.Y.(Z+1) instead"
  ```
- For registry rollback:
  ```bash
  ./mcp-publisher status --status deprecated --message "use X.Y.(Z+1)" io.github.ryanthegentry/402index X.Y.Z
  ```

---

## 7-tool smoke-test checklist

Run these 7 checks locally after `npm install -g` during the pre-tag ceremony. All should return valid JSON with no `error: true` field.

| # | Tool | Params | Expected behavior |
|---|------|--------|-------------------|
| 1 | `get_directory_stats` | _(none)_ | Returns `{ services: { total: N, ... } }` with N > 10000 |
| 2 | `search_services` | `{ limit: 1 }` | Returns `{ services: [{ name, url, protocol, price_sats, health_status }] }` |
| 3 | `search_services` | `{ protocol: "L402", health: "healthy", limit: 3 }` | Returns up to 3 healthy L402 services; all have `protocol: "L402"` |
| 4 | `search_services` | `{ protocol: "x402", limit: 3 }` | Returns up to 3 x402 services |
| 5 | `search_services` | `{ q: "bitcoin", limit: 3 }` | Returns services matching "bitcoin" in name/description/URL |
| 6 | `list_categories` | _(none)_ | Returns `{ categories: [{ name, count }, ...] }` with multiple entries |
| 7 | `get_service_detail` | `{ id: "<id from step 2>" }` | Returns full service object including `health_history`, `related_services` |

**Pass criteria:** All 7 return non-error responses. `health_status` values are one of `healthy`, `degraded`, `down`, `unknown`. No tool returns `{ error: true }`.
