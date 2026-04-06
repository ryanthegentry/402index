import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer, stopServer } from './helpers/server.js'

let BASE = process.env.API_BASE
let API
const DIGEST_KEY = process.env.DIGEST_API_KEY || 'test-digest-key'
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'test-secret'

before(async () => { BASE = BASE || await startServer(); API = `${BASE}/api/v1` })
after(async () => { await stopServer() })

function authHeaders(key) {
  return { Authorization: `Bearer ${key}` }
}

describe('GET /api/v1/digest', () => {
  it('returns 401 without auth header', async () => {
    const res = await fetch(`${API}/digest`)
    assert.equal(res.status, 401)
  })

  it('returns 401 with invalid token', async () => {
    const res = await fetch(`${API}/digest`, { headers: authHeaders('wrong-key') })
    assert.equal(res.status, 401)
  })

  it('returns 401 with ADMIN_SECRET (wrong key type)', async () => {
    // DIGEST_API_KEY and ADMIN_SECRET must be different values
    assert.notEqual(DIGEST_KEY, ADMIN_SECRET, 'test requires different keys')
    const res = await fetch(`${API}/digest`, { headers: authHeaders(ADMIN_SECRET) })
    assert.equal(res.status, 401)
  })

  it('returns 200 with valid DIGEST_API_KEY', async () => {
    const res = await fetch(`${API}/digest`, { headers: authHeaders(DIGEST_KEY) })
    assert.equal(res.status, 200)
  })

  it('response contains all required top-level keys', async () => {
    const res = await fetch(`${API}/digest`, { headers: authHeaders(DIGEST_KEY) })
    const body = await res.json()
    const required = ['generated_at', 'totals', 'registrations', 'traffic', 'search_intelligence', 'health_changes']
    for (const key of required) {
      assert.ok(key in body, `missing top-level key: ${key}`)
    }
  })

  it('totals.by_protocol sums to totals.endpoints', async () => {
    const res = await fetch(`${API}/digest`, { headers: authHeaders(DIGEST_KEY) })
    const { totals } = await res.json()
    const protocolSum = Object.values(totals.by_protocol).reduce((a, b) => a + b, 0)
    assert.equal(protocolSum, totals.endpoints, 'protocol counts should sum to total endpoints')
  })

  it('registrations.last_24h contains only self-registered services', async () => {
    const res = await fetch(`${API}/digest`, { headers: authHeaders(DIGEST_KEY) })
    const { registrations } = await res.json()
    assert.ok(Array.isArray(registrations.last_24h))
    for (const svc of registrations.last_24h) {
      assert.equal(svc.source, 'self-registered', `expected self-registered, got ${svc.source}`)
    }
  })

  it('search_intelligence.top_user_agents_7d includes type field', async () => {
    const res = await fetch(`${API}/digest`, { headers: authHeaders(DIGEST_KEY) })
    const { search_intelligence } = await res.json()
    assert.ok(Array.isArray(search_intelligence.top_user_agents_7d))
    for (const entry of search_intelligence.top_user_agents_7d) {
      assert.ok('type' in entry, 'agent entry missing type field')
      assert.ok(['api', 'browser', 'mcp'].includes(entry.type), `unexpected type: ${entry.type}`)
    }
  })

  it('rate limiting works (>10 requests returns 429)', async () => {
    // Previous tests already consumed some of the 10/hour budget.
    // Send enough additional requests to guarantee hitting the limit.
    let got429 = false
    for (let i = 0; i < 15; i++) {
      const r = await fetch(`${API}/digest`, { headers: authHeaders(DIGEST_KEY) })
      if (r.status === 429) {
        got429 = true
        break
      }
    }
    assert.ok(got429, 'should receive 429 after exceeding 10/hour rate limit')
  })

  it('DIGEST_API_KEY cannot access /admin/pending', async () => {
    const res = await fetch(`${API}/admin/pending`, { headers: authHeaders(DIGEST_KEY) })
    assert.equal(res.status, 401, 'digest key should not grant admin access')
  })
})
