// Regression guard for the #276 route-split: the /api/v1/digest handler calls
// classifyAgent(r.agent) at src/routes/api/digest.js, but the helper was dropped
// when the monolithic src/routes/api.js was split into per-resource modules.
//
// The bug only fires when query_log is NON-EMPTY: an empty result makes
// `.map(r => ({ ...r, type: classifyAgent(r.agent) }))` skip its callback, so the
// undefined identifier is never resolved (this is why the pre-existing
// digest-endpoint.test.js — which runs against an empty query_log — stays green
// while production 500s). We seed query_log first, then assert the endpoint works
// AND classifies every user-agent branch correctly.
//
// Distinct from test/classify.test.js, which tests classifyServices() from
// src/services/classify.js — different function, different domain.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import db from '../src/db.js'
import { startServer, stopServer } from './helpers/server.js'

const DIGEST_KEY = process.env.DIGEST_API_KEY || 'test-digest-key'
let API

// One row per branch of classifyAgent(ua):
//   mcp     → ua.includes('402index-mcp')
//   browser → Mozilla / Chrome / Safari
//   api     → final fallback (curl) AND the `!ua || ua === ''` guard (empty string)
const SEED = [
  { ua: '402index-mcp/0.3.0', type: 'mcp' },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', type: 'browser' },
  { ua: 'curl/8.4.0', type: 'api' },
  { ua: '', type: 'api' },
]

before(async () => {
  const insert = db.prepare(
    "INSERT INTO query_log (user_agent, query_text, result_count, timestamp) VALUES (?, ?, ?, datetime('now'))"
  )
  for (const { ua } of SEED) {
    // 2 rows each so GROUP BY produces a stable, non-empty top-agents result.
    insert.run(ua, 'test-query', 1)
    insert.run(ua, 'test-query', 1)
  }
  API = `${await startServer()}/api/v1`
})

after(async () => { await stopServer() })

function authHeaders(key) {
  return { Authorization: `Bearer ${key}` }
}

describe('GET /api/v1/digest — user-agent classification (#276 regression)', () => {
  it('returns 200 (not 500) when query_log has rows', async () => {
    // The load-bearing regression catch: pre-fix this is a 500 because
    // classifyAgent is not defined in digest.js's module scope.
    const res = await fetch(`${API}/digest`, { headers: authHeaders(DIGEST_KEY) })
    assert.equal(res.status, 200, 'digest must not 500 when query_log is non-empty')
  })

  it('classifies each seeded user agent in top_user_agents_7d', async () => {
    // Post-fix correctness guard: every branch of classifyAgent is exercised
    // through the real .map() code path, not in isolation.
    const res = await fetch(`${API}/digest`, { headers: authHeaders(DIGEST_KEY) })
    assert.equal(res.status, 200)
    const { search_intelligence } = await res.json()
    const agents = search_intelligence.top_user_agents_7d
    assert.ok(Array.isArray(agents), 'top_user_agents_7d must be an array')
    assert.ok(agents.length >= SEED.length, `expected >= ${SEED.length} agents, got ${agents.length}`)

    const typeByAgent = Object.fromEntries(agents.map(a => [a.agent, a.type]))
    for (const { ua, type } of SEED) {
      assert.equal(typeByAgent[ua], type, `agent ${JSON.stringify(ua)} should classify as ${type}`)
    }
  })
})
