/**
 * Tests for probe_status column (#236): unprobeable gateway services.
 *
 * TDD step 1: these tests MUST fail against the current codebase.
 *
 * Run: ADMIN_SECRET=test-secret node --test test/probe-status.test.js
 */

import { describe, it, before, after, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import dns from 'dns'
import db from '../src/db.js'
import { checkService } from '../src/health/checker.js'
import { buildServiceQuery } from '../src/queries/services.js'
import { startServer, stopServer } from './helpers/server.js'

// ─── Helpers ────────────────────────────────────────────────────────────────

const TEST_PREFIX = 'test-ps-' + Date.now()
let testCounter = 0

function testId() {
  return `${TEST_PREFIX}-${++testCounter}`
}

function mockResponse(status, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) { return headers[name.toLowerCase()] || null },
      entries() { return Object.entries(headers) },
    },
    text: async () => '',
  }
}

// Spec-compliant V2 TLV macaroon fixture
function buildSpecCompliantMacaroon() {
  const id = Buffer.alloc(66)
  id.writeUInt16BE(0, 0)
  id.fill(0xAB, 2, 34)
  id.fill(0xCD, 34, 66)
  const sig = Buffer.alloc(32, 0xEE)
  const parts = [
    Buffer.from([0x02]),
    Buffer.from([0x02]),
    Buffer.from([66]),
    id,
    Buffer.from([0x00]),
    Buffer.from([0x06]),
    Buffer.from([32]),
    sig,
    Buffer.from([0x00]),
  ]
  return Buffer.concat(parts).toString('base64')
}
const specCompliantMacaroon = buildSpecCompliantMacaroon()
const longInvoice = 'lnbc1000n1p' + 'a'.repeat(200)

function insertTestService(overrides = {}) {
  const id = overrides.id || testId()
  const params = {
    id,
    name: 'Test Service',
    url: `https://${id}.example.com/api`,
    protocol: 'L402',
    source: 'test',
    status: 'active',
    health_status: 'unknown',
    consecutive_failures: 0,
    ...overrides,
  }
  db.prepare(`
    INSERT INTO services (id, name, url, protocol, source, status, health_status, consecutive_failures)
    VALUES (@id, @name, @url, @protocol, @source, @status, @health_status, @consecutive_failures)
  `).run(params)
  return params
}

function getService(id) {
  return db.prepare('SELECT * FROM services WHERE id = ?').get(id)
}

function getHealthChecks(serviceId) {
  return db.prepare('SELECT * FROM health_checks WHERE service_id = ?').all(serviceId)
}

// ─── Unit Tests (direct DB + checker) ────────────────────────────────────────

const originalFetch = globalThis.fetch
let dnsLookupMock

describe('probe_status: health checker skips unprobeable services', () => {
  beforeEach(() => {
    dnsLookupMock = mock.method(dns.promises, 'lookup', async () => ({ address: '93.184.216.34' }))
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    dnsLookupMock.mock.restore()
    db.prepare(`DELETE FROM health_checks WHERE service_id LIKE '${TEST_PREFIX}%'`).run()
    db.prepare(`DELETE FROM services WHERE id LIKE '${TEST_PREFIX}%'`).run()
  })

  it('runHealthChecks skips services with probe_status=unprobeable', async () => {
    // Seed a service with probe_status = 'unprobeable'
    const svc = insertTestService()
    db.prepare("UPDATE services SET probe_status = 'unprobeable' WHERE id = ?").run(svc.id)

    // Mock fetch to return 402 (healthy) — but it should never be called
    let fetchCalled = false
    globalThis.fetch = async () => {
      fetchCalled = true
      return mockResponse(402, {
        'www-authenticate': `L402 macaroon="${specCompliantMacaroon}", invoice="${longInvoice}"`,
      })
    }

    await checkService({
      ...svc,
      probe_status: 'unprobeable',
      latency_p50_ms: null,
      consecutive_failures: 0,
      consecutive_latency_spikes: 0,
      x402_payment_valid: null,
    })

    // No health_checks rows should be created for an unprobeable service
    const checks = getHealthChecks(svc.id)
    assert.equal(checks.length, 0, 'unprobeable service should have no health_checks rows')

    // Health status should remain unchanged (unknown)
    const updated = getService(svc.id)
    assert.equal(updated.health_status, 'unknown', 'health_status should remain unknown')
  })

  it('sibling propagation skips unprobeable siblings', async () => {
    const sharedUrl = `https://${TEST_PREFIX}-sib.example.com/api`

    // Probeable sibling (L402)
    const probeable = insertTestService({ protocol: 'L402', url: sharedUrl })

    // Unprobeable sibling (x402) at same URL
    const unprobeable = insertTestService({
      protocol: 'x402',
      url: sharedUrl,
      health_status: 'unknown',
    })
    db.prepare("UPDATE services SET probe_status = 'unprobeable' WHERE id = ?").run(unprobeable.id)

    // Mock: return 402 with L402 headers only
    globalThis.fetch = async () => {
      return mockResponse(402, {
        'www-authenticate': `L402 macaroon="${specCompliantMacaroon}", invoice="${longInvoice}"`,
      })
    }

    await checkService({
      ...probeable,
      latency_p50_ms: null,
      consecutive_failures: 0,
      consecutive_latency_spikes: 0,
      x402_payment_valid: null,
    })

    // The unprobeable sibling's health_status should NOT have been updated
    const unprobeableUpdated = getService(unprobeable.id)
    assert.equal(
      unprobeableUpdated.health_status, 'unknown',
      'unprobeable sibling health_status should not be overwritten by sibling propagation'
    )
  })
})

// ─── Query builder tests ─────────────────────────────────────────────────────

describe('probe_status: query builder filter', () => {
  it('buildServiceQuery with probe_status=unprobeable filter', () => {
    const result = buildServiceQuery({ probe_status: 'unprobeable' })
    assert.ok(
      result.where.includes('probe_status'),
      'WHERE clause should include probe_status filter'
    )
    assert.equal(result.params.probe_status, 'unprobeable')
  })

  it('buildServiceQuery with probe_status=probeable filter', () => {
    const result = buildServiceQuery({ probe_status: 'probeable' })
    assert.ok(
      result.where.includes('probe_status'),
      'WHERE clause should include probe_status filter'
    )
    assert.equal(result.params.probe_status, 'probeable')
  })

  it('buildServiceQuery ignores invalid probe_status values', () => {
    const result = buildServiceQuery({ probe_status: 'bogus' })
    assert.ok(
      !result.where.includes('probe_status'),
      'WHERE clause should NOT include probe_status for invalid values'
    )
  })
})

// ─── API integration tests (require running server) ──────────────────────────

let BASE
let API
const SECRET = process.env.ADMIN_SECRET || 'test-secret'

async function adminPost(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

describe('probe_status: admin endpoint', () => {
  before(async () => {
    BASE = process.env.API_BASE || await startServer()
    API = `${BASE}/api/v1`
  })
  after(async () => { await stopServer() })

  afterEach(() => {
    db.prepare(`DELETE FROM health_checks WHERE service_id LIKE '${TEST_PREFIX}%'`).run()
    db.prepare(`DELETE FROM services WHERE id LIKE '${TEST_PREFIX}%'`).run()
  })

  it('POST /admin/services/:id/probe-status sets probe_status and resets health metrics', async () => {
    // Create a service with degraded health and stale metrics
    const svc = insertTestService({
      health_status: 'degraded',
    })
    db.prepare(`
      UPDATE services SET
        consecutive_failures = 5,
        uptime_30d = 0.75,
        latency_p50_ms = 500
      WHERE id = ?
    `).run(svc.id)

    // POST to set probe_status = 'unprobeable'
    const r = await adminPost(`/admin/services/${svc.id}/probe-status`, {
      probe_status: 'unprobeable',
    })

    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`)

    // Verify the service was updated
    const updated = getService(svc.id)
    assert.equal(updated.probe_status, 'unprobeable', 'probe_status should be unprobeable')
    assert.equal(updated.health_status, 'unknown', 'health_status should be reset to unknown')
    assert.equal(updated.consecutive_failures, 0, 'consecutive_failures should be reset to 0')
    assert.equal(updated.uptime_30d, null, 'uptime_30d should be reset to NULL')
    assert.equal(updated.latency_p50_ms, null, 'latency_p50_ms should be reset to NULL')
  })

  it('POST /admin/services/:id/probe-status rejects invalid probe_status value', async () => {
    const svc = insertTestService()
    const r = await adminPost(`/admin/services/${svc.id}/probe-status`, {
      probe_status: 'invalid',
    })
    assert.equal(r.status, 400)
  })

  it('POST /admin/services/:id/probe-status returns 404 for missing service', async () => {
    const r = await adminPost('/admin/services/nonexistent-id/probe-status', {
      probe_status: 'unprobeable',
    })
    assert.equal(r.status, 404)
  })

  it('POST /admin/services/:id/probe-status requires auth', async () => {
    const res = await fetch(`${API}/admin/services/any-id/probe-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ probe_status: 'unprobeable' }),
    })
    assert.equal(res.status, 401)
  })
})

describe('probe_status: API filter', () => {
  before(async () => {
    BASE = process.env.API_BASE || await startServer()
    API = `${BASE}/api/v1`
  })
  after(async () => { await stopServer() })

  afterEach(() => {
    db.prepare(`DELETE FROM health_checks WHERE service_id LIKE '${TEST_PREFIX}%'`).run()
    db.prepare(`DELETE FROM services WHERE id LIKE '${TEST_PREFIX}%'`).run()
  })

  it('GET /api/v1/services?probe_status=unprobeable filters correctly', async () => {
    // Seed services with mixed probe_status
    const probeableSvc = insertTestService({ name: 'Probeable Svc' })
    const unprobeableSvc = insertTestService({ name: 'Unprobeable Svc' })
    db.prepare("UPDATE services SET probe_status = 'unprobeable' WHERE id = ?").run(unprobeableSvc.id)
    db.prepare("UPDATE services SET probe_status = 'probeable' WHERE id = ?").run(probeableSvc.id)

    const res = await fetch(`${API}/services?probe_status=unprobeable`)
    assert.equal(res.status, 200)
    const data = await res.json()

    // All returned services should be unprobeable
    const ids = data.services.map(s => s.id)
    assert.ok(ids.includes(unprobeableSvc.id), 'unprobeable service should be in results')
    assert.ok(!ids.includes(probeableSvc.id), 'probeable service should NOT be in results')
  })
})
