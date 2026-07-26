/**
 * Cycle reconciliation (#313 Part B).
 *
 * The digest's "882 of 1,218 L402 checked" came from a log line that only printed
 * healthy/degraded/down. It omitted unknown, error, sibling-deduped rows (whose health_status IS
 * updated), and every row getServices deliberately excludes.
 *
 * This is a reporting defect: probing behavior must not change. The reconciliation buckets must
 * partition every services row carrying the protocol, with unaccounted = 0.
 *
 * Run: node --test test/health-cycle-reconciliation.test.js
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import dns from 'dns'
import { readFileSync } from 'fs'
import * as dbModule from '../src/db.js'
import * as checker from '../src/health/checker.js'

const db = dbModule.default
const { runHealthChecks } = checker

const TEST_PREFIX = 'test-recon-' + Date.now()
let counter = 0

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
    name: 'Recon Test',
    url: overrides.url || `https://${TEST_PREFIX}-${counter}.example.com/api`,
    protocol: 'L402',
    source: 'test',
    status: 'active',
    provider_deleted: 0,
    probe_status: 'probeable',
    deleted_at: null,
    ...overrides,
  }
  db.prepare(`
    INSERT INTO services (id, name, url, protocol, source, status, provider_deleted, probe_status, deleted_at,
                          consecutive_failures, consecutive_latency_spikes)
    VALUES (@id, @name, @url, @protocol, @source, @status, @provider_deleted, @probe_status, @deleted_at, 0, 0)
  `).run(params)
  return params
}

const originalFetch = globalThis.fetch
let dnsLookupMock

beforeEach(() => {
  dnsLookupMock = mock.method(dns.promises, 'lookup', async () => ({ address: '93.184.216.34' }))
  globalThis.fetch = async () => mockResponse(402, {
    'www-authenticate': `L402 macaroon="${specCompliantMacaroon}", invoice="${longInvoice}"`,
    'payment-required': makePaymentHeader(),
  })
})

afterEach(() => {
  globalThis.fetch = originalFetch
  dnsLookupMock.mock.restore()
  db.prepare(`DELETE FROM health_checks WHERE service_id LIKE '${TEST_PREFIX}%'`).run()
  db.prepare(`DELETE FROM services WHERE id LIKE '${TEST_PREFIX}%'`).run()
})

/**
 * probed + sibling-deduped + unprobeable + pending + soft-deleted.
 * L402 denominator = 5 rows, x402 denominator = 1 row.
 */
function seedFixture() {
  const pairUrl = `https://${TEST_PREFIX}-pair.example.com/api`
  return {
    pairL402: insertTestService({ protocol: 'L402', url: pairUrl }),
    pairX402: insertTestService({ protocol: 'x402', url: pairUrl }),
    solo: insertTestService({ protocol: 'L402', url: `https://${TEST_PREFIX}-solo.example.com/api` }),
    unprobeable: insertTestService({ protocol: 'L402', probe_status: 'unprobeable' }),
    pending: insertTestService({ protocol: 'L402', status: 'pending' }),
    softDeleted: insertTestService({ protocol: 'L402', provider_deleted: 1, deleted_at: '2026-01-01 00:00:00' }),
  }
}

describe('reconciliation identity', () => {
  it('buckets sum to the per-protocol denominator with unaccounted = 0', async () => {
    seedFixture()
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM services').get().c, 6,
      'fixture must be the whole table for the identity to be meaningful'
    )

    // concurrency 1 makes the sibling dedup deterministic: whichever row of the pair is probed
    // first, the other is skipped and updated through the sibling path.
    const result = await runHealthChecks({ concurrency: 1 })
    const recon = result.reconciliation
    assert.ok(recon, 'runHealthChecks must return a reconciliation')

    for (const [proto, r] of Object.entries(recon)) {
      const sum = r.probed_total + r.sibling_updated + r.skipped_unprobeable + r.excluded_inactive + r.persist_failed
      assert.equal(sum + r.unaccounted, r.denominator, `${proto} buckets must sum to the denominator`)
      assert.equal(r.unaccounted, 0, `${proto} must have nothing unaccounted for`)
    }

    assert.equal(recon.L402.denominator, 5, 'every L402 row counts toward the denominator')
    assert.equal(recon.x402.denominator, 1)
    assert.equal(recon.L402.skipped_unprobeable, 1)
    assert.equal(recon.L402.excluded_inactive, 2, 'pending + soft-deleted')
    assert.equal(recon.L402.persist_failed, 0)

    const probedTotal = recon.L402.probed_total + recon.x402.probed_total
    const siblingTotal = recon.L402.sibling_updated + recon.x402.sibling_updated
    assert.equal(probedTotal, 2, 'the solo row plus one row of the deduped pair')
    assert.equal(siblingTotal, 1, 'the deduped row is checked, never "skipped"')
  })

  it('breaks probed results down by status including unknown and error', async () => {
    seedFixture()
    const result = await runHealthChecks({ concurrency: 1 })
    const probed = result.reconciliation.L402.probed

    for (const key of ['healthy', 'degraded', 'down', 'unknown', 'error']) {
      assert.ok(key in probed, `probed breakdown must carry ${key}`)
    }
    assert.equal(
      Object.values(probed).reduce((a, b) => a + b, 0),
      result.reconciliation.L402.probed_total,
      'probed_total must equal the sum of its breakdown'
    )
  })

  it('counts an unreachable endpoint under probed.unknown, not as a missing row', async () => {
    insertTestService({ protocol: 'L402', url: `https://${TEST_PREFIX}-dead.example.com/api` })
    globalThis.fetch = async () => { throw new Error('fetch failed') }

    const recon = (await runHealthChecks({ concurrency: 1 })).reconciliation
    assert.equal(recon.L402.probed.unknown, 1)
    assert.equal(recon.L402.probed_total, 1)
    assert.equal(recon.L402.unaccounted, 0)
  })

  it('does not change which endpoints get probed', async () => {
    const fixture = seedFixture()
    const probedUrls = new Set()
    globalThis.fetch = async (url) => {
      probedUrls.add(new URL(url).hostname)
      return mockResponse(402, {
        'www-authenticate': `L402 macaroon="${specCompliantMacaroon}", invoice="${longInvoice}"`,
        'payment-required': makePaymentHeader(),
      })
    }

    await runHealthChecks({ concurrency: 1 })

    assert.equal(probedUrls.size, 2, 'only the pair URL and the solo URL are probed')
    for (const excluded of [fixture.unprobeable, fixture.pending, fixture.softDeleted]) {
      assert.ok(!probedUrls.has(new URL(excluded.url).hostname), `${excluded.id} must not be probed`)
    }
  })
})

describe('reconciliation persistence and reporting', () => {
  it('writes the cycle reconciliation to the counters table', async () => {
    seedFixture()
    const result = await runHealthChecks({ concurrency: 1 })

    const raw = dbModule.getCounter('last_health_cycle')
    assert.ok(raw, 'counters.last_health_cycle must be written at cycle end')
    const stored = JSON.parse(raw)
    assert.deepEqual(stored.by_protocol, result.reconciliation)
    assert.equal(stored.persist_failed, result.persistFailed)
    assert.ok(stored.finished_at, 'the summary must be timestamped')
    assert.equal(stored.unaccounted, 0)
  })

  it('formats one summary both callers share', async () => {
    seedFixture()
    const result = await runHealthChecks({ concurrency: 1 })

    assert.equal(typeof checker.formatCycleSummary, 'function', 'checker must export formatCycleSummary')
    const summary = checker.formatCycleSummary(result)
    assert.match(summary, /persist_failed=0/)
    assert.match(summary, /unaccounted=0/)
    assert.match(summary, /L402/)
  })

  it('both callers report the same reconciliation', () => {
    const scheduler = readFileSync(new URL('../src/scheduler.js', import.meta.url), 'utf8')
    const script = readFileSync(new URL('../scripts/healthcheck.js', import.meta.url), 'utf8')
    assert.match(scheduler, /formatCycleSummary/, 'src/scheduler.js must report the cycle summary')
    assert.match(script, /formatCycleSummary/, 'scripts/healthcheck.js must report the cycle summary')
  })
})
