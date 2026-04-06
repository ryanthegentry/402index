/**
 * Tests for single-probe dual-update dedup in health checker.
 * Issue #79: Same URL with two service rows (L402 + x402) should produce
 * one HTTP probe, not two. Siblings get updated from the single probe result.
 *
 * Run: node --test test/health-checker-dedup.test.js
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import dns from 'dns'
import db from '../src/db.js'
import { checkService, runHealthChecks } from '../src/health/checker.js'

// ─── Helpers ────────────────────────────────────────────────────────────────

const TEST_PREFIX = 'test-dedup-' + Date.now()
let testCounter = 0

function testId() {
  return `${TEST_PREFIX}-${++testCounter}`
}

function makePaymentHeader() {
  const payload = {
    accepts: [{
      payTo: '0x1234567890abcdef1234567890abcdef12345678',
      asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      network: 'eip155:8453',
      maxAmountRequired: '1000000',
    }],
  }
  return Buffer.from(JSON.stringify(payload)).toString('base64')
}

const longInvoice = 'lnbc1000n1p' + 'a'.repeat(200)

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

function insertTestService(overrides = {}) {
  const id = overrides.id || testId()
  const params = {
    id,
    name: 'Test Service',
    url: `https://${TEST_PREFIX}.example.com/api`,
    protocol: 'x402',
    source: 'test',
    status: 'active',
    http_method: null,
    ...overrides,
  }
  db.prepare(`
    INSERT INTO services (id, name, url, protocol, source, status, consecutive_failures, http_method)
    VALUES (@id, @name, @url, @protocol, @source, @status, 0, @http_method)
  `).run(params)
  return params
}

function getService(id) {
  return db.prepare('SELECT * FROM services WHERE id = ?').get(id)
}

function getHealthChecks(serviceId) {
  return db.prepare('SELECT * FROM health_checks WHERE service_id = ? ORDER BY checked_at DESC').all(serviceId)
}

// ─── Setup / Teardown ───────────────────────────────────────────────────────

const originalFetch = globalThis.fetch
let dnsLookupMock

beforeEach(() => {
  dnsLookupMock = mock.method(dns.promises, 'lookup', async () => ({ address: '93.184.216.34' }))
})

afterEach(() => {
  globalThis.fetch = originalFetch
  dnsLookupMock.mock.restore()
  db.prepare(`DELETE FROM health_checks WHERE service_id LIKE '${TEST_PREFIX}%'`).run()
  db.prepare(`DELETE FROM services WHERE id LIKE '${TEST_PREFIX}%'`).run()
})

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Health checker dedup: single-probe dual-update', () => {

  it('dual-protocol URL produces one HTTP probe, not two', async () => {
    const sharedUrl = `https://${TEST_PREFIX}-dual.example.com/api`
    const l402Svc = insertTestService({ protocol: 'L402', url: sharedUrl })
    const x402Svc = insertTestService({ protocol: 'x402', url: sharedUrl })

    let probeCount = 0
    const validPayment = makePaymentHeader()

    globalThis.fetch = async (url, opts) => {
      probeCount++
      // Return dual-signal: both L402 and x402 headers
      return mockResponse(402, {
        'www-authenticate': `L402 macaroon="${specCompliantMacaroon}", invoice="${longInvoice}"`,
        'payment-required': validPayment,
      })
    }

    // Check the L402 service — should also update x402 sibling
    await checkService({
      ...l402Svc,
      latency_p50_ms: null,
      consecutive_failures: 0,
      consecutive_latency_spikes: 0,
      x402_payment_valid: null,
    })

    // Verify the mock server received probes — with HEAD→GET fallback, expect ≤2 requests (HEAD + GET or just HEAD)
    // but NOT 4 (which would indicate two independent probes)
    assert.ok(probeCount <= 2, `expected at most 2 HTTP requests (one probe), got ${probeCount}`)

    // Both rows should have updated health_status
    const l402Updated = getService(l402Svc.id)
    const x402Updated = getService(x402Svc.id)
    assert.ok(l402Updated.health_status, 'L402 row should have health_status set')
    assert.ok(x402Updated.health_status, 'x402 sibling should have health_status set')

    // Both should have health_checks entries
    const l402Checks = getHealthChecks(l402Svc.id)
    const x402Checks = getHealthChecks(x402Svc.id)
    assert.ok(l402Checks.length > 0, 'L402 row should have health_checks entry')
    assert.ok(x402Checks.length > 0, 'x402 sibling should have health_checks entry')
  })

  it('sibling in same batch is skipped via checkedThisCycle', async () => {
    const sharedUrl = `https://${TEST_PREFIX}-batch.example.com/api`
    // Insert only these two services — runHealthChecks will pick them both up
    const svc1 = insertTestService({ protocol: 'L402', url: sharedUrl })
    const svc2 = insertTestService({ protocol: 'x402', url: sharedUrl })

    let probeCount = 0
    const validPayment = makePaymentHeader()

    globalThis.fetch = async (url, opts) => {
      // Only count probes to our test URL
      if (url.includes(TEST_PREFIX)) probeCount++
      return mockResponse(402, {
        'www-authenticate': `L402 macaroon="${specCompliantMacaroon}", invoice="${longInvoice}"`,
        'payment-required': validPayment,
      })
    }

    // We need to isolate — delete all other active services for this test
    // Instead, just call checkService for svc1, then checkService for svc2
    // and verify svc2 returns 'skipped'
    await checkService({
      ...svc1,
      latency_p50_ms: null,
      consecutive_failures: 0,
      consecutive_latency_spikes: 0,
      x402_payment_valid: null,
    })

    // Now check svc2 — it should be skipped because svc1 already updated it
    const result2 = await checkService({
      ...svc2,
      latency_p50_ms: null,
      consecutive_failures: 0,
      consecutive_latency_spikes: 0,
      x402_payment_valid: null,
    })

    assert.equal(result2.healthStatus, 'skipped', 'sibling should be skipped since already updated by first checkService call')
  })

  it('sibling degraded when its protocol is not detected in probe response', async () => {
    const sharedUrl = `https://${TEST_PREFIX}-degrade.example.com/api`
    const l402Svc = insertTestService({ protocol: 'L402', url: sharedUrl })
    const x402Svc = insertTestService({ protocol: 'x402', url: sharedUrl })

    // Return only L402 headers — no x402 payment-required header
    globalThis.fetch = async () => {
      return mockResponse(402, {
        'www-authenticate': `L402 macaroon="${specCompliantMacaroon}", invoice="${longInvoice}"`,
      })
    }

    await checkService({
      ...l402Svc,
      latency_p50_ms: null,
      consecutive_failures: 0,
      consecutive_latency_spikes: 0,
      x402_payment_valid: null,
    })

    const x402Updated = getService(x402Svc.id)
    assert.equal(x402Updated.health_status, 'degraded', 'x402 sibling should be degraded when x402 protocol not detected')
  })

  it('sibling gets correct protocol-specific fields', async () => {
    const sharedUrl = `https://${TEST_PREFIX}-fields.example.com/api`
    const l402Svc = insertTestService({ protocol: 'L402', url: sharedUrl })
    const x402Svc = insertTestService({ protocol: 'x402', url: sharedUrl })

    const validPayment = makePaymentHeader()

    // Return dual-signal headers
    globalThis.fetch = async () => {
      return mockResponse(402, {
        'www-authenticate': `L402 macaroon="${specCompliantMacaroon}", invoice="${longInvoice}"`,
        'payment-required': validPayment,
      })
    }

    await checkService({
      ...l402Svc,
      latency_p50_ms: null,
      consecutive_failures: 0,
      consecutive_latency_spikes: 0,
      x402_payment_valid: null,
    })

    // x402 sibling should have x402-specific fields populated
    const x402Updated = getService(x402Svc.id)
    assert.ok(x402Updated.x402_payment_valid !== null, 'x402 sibling should have x402_payment_valid populated')
    assert.equal(x402Updated.x402_payment_valid, 1, 'x402 sibling should have valid payment')

    // L402 primary should have l402_format populated
    const l402Updated = getService(l402Svc.id)
    assert.ok(l402Updated.l402_format !== null, 'L402 row should have l402_format populated')
  })

  it('sibling health_check entries exist for uptime calculations', async () => {
    const sharedUrl = `https://${TEST_PREFIX}-uptime.example.com/api`
    const l402Svc = insertTestService({ protocol: 'L402', url: sharedUrl })
    const x402Svc = insertTestService({ protocol: 'x402', url: sharedUrl })

    const validPayment = makePaymentHeader()

    globalThis.fetch = async () => {
      return mockResponse(402, {
        'www-authenticate': `L402 macaroon="${specCompliantMacaroon}", invoice="${longInvoice}"`,
        'payment-required': validPayment,
      })
    }

    await checkService({
      ...l402Svc,
      latency_p50_ms: null,
      consecutive_failures: 0,
      consecutive_latency_spikes: 0,
      x402_payment_valid: null,
    })

    // Both service IDs should have health_checks table entries
    const l402Checks = getHealthChecks(l402Svc.id)
    const x402Checks = getHealthChecks(x402Svc.id)

    assert.ok(l402Checks.length > 0, 'L402 should have health_checks entries')
    assert.ok(x402Checks.length > 0, 'x402 sibling should have health_checks entries via persistHealthResult')
  })

  it('non-402 error updates all siblings uniformly', async () => {
    const sharedUrl = `https://${TEST_PREFIX}-error.example.com/api`
    const l402Svc = insertTestService({ protocol: 'L402', url: sharedUrl })
    const x402Svc = insertTestService({ protocol: 'x402', url: sharedUrl })

    // Set both rows to 3 consecutive failures in DB (sibling reads from DB)
    db.prepare('UPDATE services SET consecutive_failures = 3 WHERE id IN (?, ?)').run(l402Svc.id, x402Svc.id)

    // Return 500 error
    globalThis.fetch = async () => mockResponse(500, {})

    await checkService({
      ...l402Svc,
      latency_p50_ms: null,
      consecutive_failures: 3,
      consecutive_latency_spikes: 0,
      x402_payment_valid: null,
    })

    const l402Updated = getService(l402Svc.id)
    const x402Updated = getService(x402Svc.id)

    // With 3 prev failures + this one = 4, should be 'down'
    assert.equal(l402Updated.health_status, 'down', 'L402 should be down after 4th consecutive failure')
    assert.equal(x402Updated.health_status, 'down', 'x402 sibling should also be down')
  })

  it('POST fallback does not promote sibling http_method', async () => {
    const sharedUrl = `https://${TEST_PREFIX}-post.example.com/api`
    // Primary is L402 with GET — will trigger POST fallback on 405
    const l402Svc = insertTestService({ protocol: 'L402', url: sharedUrl, http_method: null })
    // Sibling is x402 with GET
    const x402Svc = insertTestService({ protocol: 'x402', url: sharedUrl, http_method: null })

    const validPayment = makePaymentHeader()

    globalThis.fetch = async (url, opts) => {
      const method = opts?.method || 'GET'
      if (method === 'POST') {
        // POST returns 402 with dual-signal headers
        return mockResponse(402, {
          'www-authenticate': `L402 macaroon="${specCompliantMacaroon}", invoice="${longInvoice}"`,
          'payment-required': validPayment,
        })
      }
      // HEAD and GET return 405
      return mockResponse(405, {})
    }

    await checkService({
      ...l402Svc,
      latency_p50_ms: null,
      consecutive_failures: 0,
      consecutive_latency_spikes: 0,
      x402_payment_valid: null,
    })

    // Primary L402 should have http_method promoted to POST
    const l402Updated = getService(l402Svc.id)
    assert.equal(l402Updated.http_method, 'POST', 'primary L402 should have http_method promoted to POST')

    // Sibling x402 should NOT have http_method changed
    const x402Updated = getService(x402Svc.id)
    assert.notEqual(x402Updated.http_method, 'POST', 'sibling x402 should NOT have http_method promoted to POST')
  })
})
