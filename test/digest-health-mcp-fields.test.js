/**
 * Digest health + MCP counter fields (#313 Part A.1, B.3, C.3).
 *
 * The digest is the 5:30am consumer's only view of health-check integrity: a schema flag when the
 * status enum is broken, the DB-backed write-failure count, and a per-protocol reconciliation with
 * unaccounted = 0. MCP window fields are named for what they are; the lifetime counter is separate.
 *
 * Separate file from digest-endpoint.test.js so it gets its own 10/hour rate-limit budget.
 *
 * Run: node --test test/digest-health-mcp-fields.test.js
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer, stopServer } from './helpers/server.js'

let BASE = process.env.API_BASE
let API
const DIGEST_KEY = process.env.DIGEST_API_KEY || 'test-digest-key'

let body

before(async () => {
  BASE = BASE || await startServer()
  API = `${BASE}/api/v1`
  const res = await fetch(`${API}/digest`, { headers: { Authorization: `Bearer ${DIGEST_KEY}` } })
  assert.equal(res.status, 200)
  body = await res.json()
})
after(async () => { await stopServer() })

describe('digest traffic: MCP counters', () => {
  it('reports the lifetime counter, not a rolling window, as the total', () => {
    assert.ok('mcp_queries_lifetime' in body.traffic, 'missing mcp_queries_lifetime')
    assert.equal(typeof body.traffic.mcp_queries_lifetime, 'number')
    assert.equal(
      body.traffic.mcp_queries_total, body.traffic.mcp_queries_lifetime,
      'mcp_queries_total is redefined as the lifetime counter'
    )
  })

  it('labels the window fields as 90-day windows', () => {
    assert.ok('mcp_queries_90d' in body.traffic, 'missing mcp_queries_90d')
    assert.ok('mcp_active_days_90d' in body.traffic, 'missing mcp_active_days_90d')
    assert.equal(typeof body.traffic.mcp_queries_90d, 'number')
    assert.equal(typeof body.traffic.mcp_active_days_90d, 'number')
  })

  it('keeps mcp_active_days for one release with a deprecation flag', () => {
    assert.equal(body.traffic.mcp_active_days, body.traffic.mcp_active_days_90d)
    assert.equal(body.traffic.mcp_active_days_deprecated, true)
  })

  it('exposes when the lifetime counter was seeded', () => {
    assert.ok(body.traffic.mcp_counter_seeded_at, 'missing mcp_counter_seeded_at')
  })

  it('labels the MCP counters as user-agent attested', () => {
    // The only gate on the increment is a client-controlled User-Agent substring, and the counter
    // is now permanent rather than self-healing as poisoned rows age out. It is a ceiling, not a
    // measurement — the payload has to say so.
    assert.equal(body.traffic.mcp_counters_ua_attested, true)
  })

  it('never reports a window larger than the lifetime counter', () => {
    assert.ok(
      body.traffic.mcp_queries_90d <= body.traffic.mcp_queries_lifetime,
      'the window is a subset of the lifetime total — divergent predicates would break this'
    )
  })
})

describe('digest health section', () => {
  it('reports the DB-backed write-failure count', () => {
    assert.ok(body.health, 'missing health section')
    assert.equal(typeof body.health.write_failures_lifetime, 'number')
  })

  it('omits health_schema_invalid when the schema is current', () => {
    assert.ok(
      !('health_schema_invalid' in body.health),
      'health_schema_invalid must be absent unless the schema is broken'
    )
  })

  it('omits health_schema_probe_error when the probe ran cleanly', () => {
    assert.ok(
      !('health_schema_probe_error' in body.health),
      'an indeterminate probe is a distinct, separately-surfaced condition'
    )
  })

  it('carries the last cycle reconciliation with per-protocol unaccounted', () => {
    assert.ok('last_cycle' in body.health, 'missing health.last_cycle')
    const cycle = body.health.last_cycle
    if (cycle === null) return // no cycle has run in this process yet
    for (const [proto, r] of Object.entries(cycle.by_protocol || {})) {
      assert.equal(r.unaccounted, 0, `${proto} must have nothing unaccounted for`)
      const sum = r.probed_total + r.sibling_updated + r.skipped_unprobeable + r.excluded_inactive + r.persist_failed
      assert.equal(sum + r.unaccounted, r.denominator, `${proto} buckets must sum to the denominator`)
    }
  })
})
