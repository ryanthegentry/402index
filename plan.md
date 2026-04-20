# PR #145 Fix Plan — backfill-embeddings

## Finding → Fix Map

### Phase 3 — New/augmented tests (RED commit)

| # | Finding | File | Fix |
|---|---------|------|-----|
| 1 | No fatal error path test | test/backfill-embeddings.test.js | Add **test k**: run with `DB_PATH=/tmp/nonexistent-readonly.db`, assert exit 1 + stderr contains `Fatal:` |
| 2 | Test d missing fetch count assertion | test/backfill-embeddings.test.js | Augment **test d**: after row-count check, assert `fetchCallCount === 3` |
| 3 | Test e doesn't prove idempotency (no second run) | test/backfill-embeddings.test.js | Rewrite **test e**: run script twice, assert second run makes 0 fetch calls, unembedded still 0 |
| 4 | Test h missing retry count assertion | test/backfill-embeddings.test.js | Augment **test h**: count per-service fetches, assert total === 5 (3 retries for failSvc + 1 ok1 + 1 ok2) |
| 5 | No batch-size/rate-limit observability test | test/backfill-embeddings.test.js | Add **test l**: seed 5 services, `--batch-size 2 --rate-limit 150`, record timestamps, assert ≥2 inter-batch gaps >120ms and intra-batch gaps <50ms |
| 6 | No `--force` with mixed pre-embedded state test | test/backfill-embeddings.test.js | Add **test m**: seed 3, pre-embed 2 with model='old-model', run `--force`, assert `fetchCallCount === 3` and all rows model='text-embedding-3-small' |

### Phase 4 — Production + test fixes (GREEN commit)

| # | Finding | File | Fix |
|---|---------|------|-----|
| 7 | `skipped` field in summary is always 0 | scripts/backfill-embeddings.mjs:164 | Replace `skipped: services.length - embedded - failed` with `total: services.length` |
| 8 | No fetch timeout in `callOpenAIWithRetry` | scripts/backfill-embeddings.mjs:42 | Add `signal: AbortSignal.timeout(30_000)` to fetch options |
| 9 | Test j runs single file, misrepresents as "full suite" | test/backfill-embeddings.test.js:266-276 | Delete test j entirely |
| 10 | OpenAI URL hardcoded in two places | src/services/embeddings.js + scripts/backfill-embeddings.mjs | Export `OPENAI_EMBEDDINGS_URL` from embeddings.js, import in both callOpenAI and backfill script |
| 11 | No `--help` / `-h` flag | scripts/backfill-embeddings.mjs:parseArgs | Detect `--help`/`-h` in parseArgs, print usage via `printUsage()` helper, exit 0 |
| 12 | Need to verify all tests pass | — | `npm test` — must exit 0 |

### Phase 2 — Rebase (precondition)

| # | Finding | Fix |
|---|---------|-----|
| 13 | Branch behind master (missing #143 CI fix) | `git rebase origin/master`, force-push |

## Execution Order

1. Phase 2: Rebase onto master → verify CI-green inheritance
2. Phase 3: Add/augment tests k, d, e, h, l, m → commit → verify RED
3. Phase 4: Fix findings 7-11, make Phase 3 tests GREEN → commit
4. Phase 5: `npm test` green, verify commit structure, push
