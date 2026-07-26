/**
 * Per-row persist isolation and the HTTP 406 diagnostic (#313 Part A.5 + A.6).
 *
 * One row failing its write must not abort the other rows at the same URL, must be counted in a
 * DB-backed counter that survives the scripts/healthcheck.js process boundary, and must be
 * categorized as a persist failure — not silently folded into the probe-error count.
 *
 * Run: node --test test/health-persist-isolation.test.js
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import dns from 'dns'
import * as dbModule from '../src/db.js'
import * as checker from '../src/health/checker.js'

const db = dbModule.default
const { checkService, runHealthChecks } = checker

const TEST_PREFIX = 'test-persist-' + Date.now()
let counter = 0

const OLD_STATUS_CHECK = "'healthy', 'degraded', 'down', 'timeout', 'error', 'rate_limited', 'method_not_allowed'"

function buildSpecCompliantMacaroon() {
  const id = Buffer.alloc(66)
  id.writeUInt16BE(0, 0)
  id.fill(0xAB, 2, 34)
  id.fill(0xCD, 34, 66)
  const sig = Buffer.alloc(32, 0xEE)
  return Buffer.concat([
    Buffer.from([0x02]), Buffer.from([0x02]), Buffer.from([66]), id,
    Buffer.from([0x00]), Buffer.from([0x06]), Buffer.from([32]), sig, Buffer.from([0x00]),
  ]).toString('base64')
}
const specCompliantMacaroon = buildSpecCompliantMacaroon()
const longInvoice = 'lnbc1000n1p' + 'a'.repeat(200)

function makePaymentHeader() {
  return Buffer.from(JSON.stringify({
    accepts: [{
      payTo: '0x1234567890abcdef1234567890abcdef12345678',
      asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      network: 'eip155:8453',
      maxAmountRequired: '1000000',
    }],
  })).toString('base64')
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

function insertTestService(overrides = {}) {
  const params = {
    id: overrides.id || `${TEST_PREFIX}-${++counter}`,
    name: 'Persist Test',
    url: `https://${TEST_PREFIX}.example.com/api`,
    protocol: 'x402',
    source: 'test',
    status: 'active',
    ...overrides,
  }
  db.prepare(`
    INSERT INTO services (id, name, url, protocol, source, status, consecutive_failures, consecutive_latency_spikes)
    VALUES (@id, @name, @url, @protocol, @source, @status, 0, 0)
  `).run(params)
  return {
    ...params,
    latency_p50_ms: null,
    consecutive_failures: 0,
    consecutive_latency_spikes: 0,
    x402_payment_valid: null,
    http_method: null,
    probe_body: null,
    registered_at: null,
    probe_status: 'probeable',
  }
}

const getService = id => db.prepare('SELECT * FROM services WHERE id = ?').get(id)
const getChecks = id => db.prepare('SELECT * FROM health_checks WHERE service_id = ?').all(id)

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

describe('HTTP 406 diagnostic', () => {
  it('stores a not_acceptable row carrying the pre-paywall-rejection reason', async () => {
    const svc = insertTestService({ protocol: 'L402', url: `https://${TEST_PREFIX}-406.example.com/api` })
    globalThis.fetch = async () => mockResponse(406)

    await checkService(svc)

    const checks = getChecks(svc.id)
    assert.equal(checks.length, 1, 'the 406 row must actually be written')
    assert.equal(checks[0].status, 'not_acceptable')
    assert.equal(checks[0].error_message, 'HTTP 406: provider rejected request format before paywall')
    assert.equal(getService(svc.id).health_status, 'degraded')
  })
})

describe('per-row persist isolation', () => {
  it('a primary persist failure still lets the sibling row update', async () => {
    const url = `https://${TEST_PREFIX}-iso.example.com/api`
    const primary = insertTestService({ protocol: 'L402', url })
    const sibling = insertTestService({ protocol: 'x402', url })

    globalThis.fetch = async () => mockResponse(402, {
      'www-authenticate': `L402 macaroon="${specCompliantMacaroon}", invoice="${longInvoice}"`,
      'payment-required': makePaymentHeader(),
    })

    const before = dbModule.getCounterInt('health_write_failures_lifetime')
    const result = await checkService(primary, {
      persist: (serviceId, payload) => {
        if (serviceId === primary.id) throw new Error('CHECK constraint failed: health_checks')
        return checker.persistHealthResult(serviceId, payload)
      },
    })

    assert.equal(result.persisted, false, 'primary persist failed')
    assert.equal(getChecks(primary.id).length, 0, 'no primary row written')

    assert.ok(getChecks(sibling.id).length > 0, 'sibling row must still be written')
    assert.ok(getService(sibling.id).health_status, 'sibling health_status must still be updated')

    assert.equal(
      dbModule.getCounterInt('health_write_failures_lifetime'), before + 1,
      'the write-failure counter lives in the DB and increments once'
    )

    assert.equal(result.persistFailures.length, 1)
    assert.equal(result.persistFailures[0].serviceId, primary.id)
    assert.equal(result.persistFailures[0].status, 'healthy', 'records the attempted status')
    assert.equal(result.persistFailures[0].category, 'persist', 'distinct from a probe error')
    assert.equal(result.persistFailures[0].role, 'primary')
  })

  it('a sibling persist failure does not abort the remaining siblings', async () => {
    const url = `https://${TEST_PREFIX}-sibs.example.com/api`
    const primary = insertTestService({ protocol: 'L402', url })
    const sibA = insertTestService({ protocol: 'x402', url })
    const sibB = insertTestService({ protocol: 'MPP', url })

    globalThis.fetch = async () => mockResponse(402, {
      'www-authenticate': `L402 macaroon="${specCompliantMacaroon}", invoice="${longInvoice}"`,
      'payment-required': makePaymentHeader(),
    })

    const result = await checkService(primary, {
      persist: (serviceId, payload) => {
        if (serviceId === sibA.id) throw new Error('CHECK constraint failed: health_checks')
        return checker.persistHealthResult(serviceId, payload)
      },
    })

    assert.equal(result.persisted, true, 'primary is unaffected')
    assert.ok(getChecks(primary.id).length > 0)
    assert.equal(getChecks(sibA.id).length, 0, 'failing sibling wrote nothing')
    assert.ok(getChecks(sibB.id).length > 0, 'the sibling after the failure still wrote')
    assert.equal(result.persistFailures.length, 1)
    assert.equal(result.persistFailures[0].role, 'sibling')
  })
})

describe('an unwritable status is a persist failure, not a probe error', () => {
  const canonicalDdl = dbModule.healthChecksTableDDL()

  function useOldConstraint() {
    db.exec('DROP TABLE IF EXISTS health_checks')
    db.exec(`
      CREATE TABLE health_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service_id TEXT NOT NULL REFERENCES services(id),
        checked_at TEXT NOT NULL DEFAULT (datetime('now')),
        status TEXT NOT NULL CHECK(status IN (${OLD_STATUS_CHECK})),
        response_time_ms INTEGER,
        http_status INTEGER,
        error_message TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_health_checks_service ON health_checks(service_id, checked_at);
    `)
  }

  function restoreSchema() {
    db.exec('DROP TABLE IF EXISTS health_checks')
    db.exec(`
      ${canonicalDdl};
      CREATE INDEX IF NOT EXISTS idx_health_checks_service ON health_checks(service_id, checked_at);
    `)
  }

  afterEach(() => { restoreSchema() })

  it('counts the rejected write, keeps the cycle running, and reports its own category', async () => {
    insertTestService({ protocol: 'L402', url: `https://${TEST_PREFIX}-406a.example.com/api` })
    insertTestService({ protocol: 'L402', url: `https://${TEST_PREFIX}-406b.example.com/api` })
    globalThis.fetch = async () => mockResponse(406)
    useOldConstraint()

    const before = dbModule.getCounterInt('health_write_failures_lifetime')
    const result = await runHealthChecks({ concurrency: 1 })

    assert.equal(result.persistFailed, 2, 'both rejected writes counted')
    assert.equal(result.error, 0, 'a rejected write is not a probe error')
    assert.equal(dbModule.getCounterInt('health_write_failures_lifetime'), before + 2)
    assert.equal(result.reconciliation.L402.persist_failed, 2)
    assert.equal(result.reconciliation.L402.probed_total, 0)
    assert.equal(result.reconciliation.L402.unaccounted, 0)
  })
})
