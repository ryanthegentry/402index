import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import db from '../src/db.js'

const originalFetch = globalThis.fetch

// Minimal mppscan tRPC fixture matching servers.list response shape
const MPPSCAN_FIXTURE = {
  result: {
    data: {
      json: [
        {
          id: 'srv-alpha',
          name: 'Alpha Service',
          url: 'https://alpha.mppscan.example.com',
          description: 'Alpha AI inference',
          category: 'ai',
          endpoints: [
            {
              method: 'POST',
              path: '/v1/chat',
              description: 'Chat completion',
              price: 0.01,
            },
          ],
        },
        {
          id: 'srv-beta',
          name: 'Beta Service',
          url: 'https://beta.mppscan.example.com',
          description: 'Beta web scraping',
          category: 'web',
          endpoints: [
            {
              method: 'POST',
              path: '/v1/scrape',
              description: 'Scrape URL',
              price: 0.05,
            },
            {
              method: 'GET',
              path: '/v1/status',
              description: 'Status check',
              price: null, // no price — should still be ingested with null price_usd
            },
          ],
        },
      ],
    },
  },
}

function cleanupMppscanServices() {
  db.prepare("DELETE FROM health_checks WHERE service_id IN (SELECT id FROM services WHERE source LIKE '%mppscan%')").run()
  db.prepare("DELETE FROM services WHERE source LIKE '%mppscan%'").run()
}

function seedRow({ url, protocol = 'MPP', source = 'mppscan', provider_deleted = 0, deleted_at = null, name = 'Test' }) {
  const id = crypto.randomUUID()
  db.prepare(`
    INSERT INTO services (id, name, url, protocol, source, source_id, provider_deleted, deleted_at, hostname)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, url, protocol, source, `seed:${url}`, provider_deleted, deleted_at, 'test.example.com')
  return id
}

describe('pollMppscan', () => {
  beforeEach(() => {
    cleanupMppscanServices()
    // Also clean any mpp-only rows that might interfere with cross-source tests
    db.prepare("DELETE FROM services WHERE source = 'mpp' AND url LIKE '%mppscan.example.com%'").run()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    cleanupMppscanServices()
    db.prepare("DELETE FROM services WHERE source LIKE '%mpp%' AND url LIKE '%mppscan.example.com%'").run()
  })

  it('unwraps tRPC envelope and ingests services', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => MPPSCAN_FIXTURE,
    })

    const { pollMppscan } = await import('../src/aggregators/mppscan.js')
    const result = await pollMppscan()

    assert.ok(result.new >= 2, 'should ingest at least 2 endpoints from fixture')
    assert.equal(result.errors, 0)
  })

  it('handles malformed tRPC envelope gracefully', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({}),
    })

    const { pollMppscan } = await import('../src/aggregators/mppscan.js')
    const result = await pollMppscan()

    assert.equal(result.new, 0)
    assert.equal(result.updated, 0)
    assert.equal(result.errors, 0)
    assert.equal(result.swept, 0)
  })

  it('ingests rows with null price_usd', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => MPPSCAN_FIXTURE,
    })

    const { pollMppscan } = await import('../src/aggregators/mppscan.js')
    await pollMppscan()

    // The status endpoint has price: null
    const rows = db.prepare("SELECT price_usd FROM services WHERE source LIKE '%mppscan%' AND url LIKE '%/v1/status'").all()
    assert.ok(rows.length >= 1, 'null-price endpoint should be ingested')
    assert.equal(rows[0].price_usd, null, 'price_usd should be null')
  })

  it('sets payment_asset and payment_network explicitly (no db.js backfill dependency)', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => MPPSCAN_FIXTURE,
    })

    const { pollMppscan } = await import('../src/aggregators/mppscan.js')
    await pollMppscan()

    const rows = db.prepare("SELECT payment_asset, payment_network FROM services WHERE source LIKE '%mppscan%'").all()
    assert.ok(rows.length >= 1, 'should have mppscan rows')
    for (const row of rows) {
      assert.ok(row.payment_asset, 'payment_asset must be non-null')
      assert.ok(row.payment_network, 'payment_network must be non-null')
    }
  })

  it('sets protocol to MPP and source to mppscan', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => MPPSCAN_FIXTURE,
    })

    const { pollMppscan } = await import('../src/aggregators/mppscan.js')
    await pollMppscan()

    const rows = db.prepare("SELECT protocol, source FROM services WHERE source LIKE '%mppscan%'").all()
    for (const row of rows) {
      assert.equal(row.protocol, 'MPP')
      assert.ok(row.source.includes('mppscan'))
    }
  })

  it('cross-source merge: appends ,mppscan to mpp-only rows', async () => {
    const url = 'https://alpha.mppscan.example.com/v1/chat'
    seedRow({ url, source: 'mpp' })

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => MPPSCAN_FIXTURE,
    })

    const { pollMppscan } = await import('../src/aggregators/mppscan.js')
    await pollMppscan()

    const row = db.prepare("SELECT source FROM services WHERE url = ? AND protocol = 'MPP'").get(url)
    assert.ok(row.source.includes('mpp'), 'must retain mpp')
    assert.ok(row.source.includes('mppscan'), 'must include mppscan')
    assert.match(row.source, /mpp,mppscan|mppscan,mpp/, 'source must contain both tokens')
  })

  it('sweeps stale mppscan rows not in API response', async () => {
    seedRow({ url: 'https://stale-scan.example.com/v1/old', source: 'mppscan' })

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => MPPSCAN_FIXTURE,
    })

    const { pollMppscan } = await import('../src/aggregators/mppscan.js')
    const result = await pollMppscan()

    assert.equal(typeof result.swept, 'number', 'result must include swept count')
    assert.ok(result.swept >= 1, 'stale row should be swept')

    const row = db.prepare("SELECT provider_deleted, deleted_at FROM services WHERE url = 'https://stale-scan.example.com/v1/old'").get()
    assert.equal(row.provider_deleted, 1)
    assert.ok(row.deleted_at, 'deleted_at must be set')
  })

  it('does NOT sweep when API returns empty array', async () => {
    seedRow({ url: 'https://keeper-scan.example.com/v1/stay', source: 'mppscan' })

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ result: { data: { json: [] } } }),
    })

    const { pollMppscan } = await import('../src/aggregators/mppscan.js')
    const result = await pollMppscan()

    assert.equal(result.swept, 0, 'sweep must be skipped on empty response')

    const row = db.prepare("SELECT provider_deleted FROM services WHERE url = 'https://keeper-scan.example.com/v1/stay'").get()
    assert.equal(row.provider_deleted, 0)
  })

  it('sweep is idempotent — second run sweeps 0', async () => {
    seedRow({ url: 'https://orphan-scan.example.com/v1/dead', source: 'mppscan' })

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => MPPSCAN_FIXTURE,
    })

    const { pollMppscan } = await import('../src/aggregators/mppscan.js')
    const first = await pollMppscan()
    assert.ok(first.swept >= 1)

    const second = await pollMppscan()
    assert.equal(second.swept, 0)
  })

  it('handles fetch error without throwing', async () => {
    globalThis.fetch = async () => {
      throw new Error('ECONNREFUSED')
    }

    const { pollMppscan } = await import('../src/aggregators/mppscan.js')
    const result = await pollMppscan()

    assert.equal(result.new, 0)
    assert.equal(result.updated, 0)
    assert.equal(result.errors, 0)
    assert.equal(result.swept, 0)
  })

  it('handles HTTP error without throwing', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 500,
    })

    const { pollMppscan } = await import('../src/aggregators/mppscan.js')
    const result = await pollMppscan()

    assert.equal(result.new, 0)
    assert.equal(result.swept, 0)
  })
})
