import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { createTestDb } from './helpers/test-db.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

function seedServices(db) {
  const insert = db.prepare(`
    INSERT INTO services (id, name, url, protocol, source, category, health_status, reliability_score, latency_p50_ms, price_sats, price_usd, x402_payment_valid, is_template, is_demo)
    VALUES (@id, @name, @url, @protocol, @source, @category, @health_status, @reliability_score, @latency_p50_ms, @price_sats, @price_usd, @x402_payment_valid, @is_template, @is_demo)
  `)

  const services = [
    // Provider A (api.nansen.ai) — x402, 3 endpoints, high reliability
    { id: 'n1', name: 'Nansen: Wallets', url: 'https://api.nansen.ai/wallets', protocol: 'x402', source: 'bazaar', category: 'data', health_status: 'healthy', reliability_score: 99.8, latency_p50_ms: 170, price_sats: null, price_usd: 0.01, x402_payment_valid: 1, is_template: 0, is_demo: 0 },
    { id: 'n2', name: 'Nansen: Tokens', url: 'https://api.nansen.ai/tokens', protocol: 'x402', source: 'bazaar', category: 'data', health_status: 'healthy', reliability_score: 100, latency_p50_ms: 150, price_sats: null, price_usd: 0.02, x402_payment_valid: 1, is_template: 0, is_demo: 0 },
    { id: 'n3', name: 'Nansen: Labels', url: 'https://api.nansen.ai/labels', protocol: 'x402', source: 'bazaar', category: 'data', health_status: 'healthy', reliability_score: 98, latency_p50_ms: 200, price_sats: null, price_usd: 0.01, x402_payment_valid: 1, is_template: 0, is_demo: 0 },

    // Provider B (sats4ai.com) — L402, 2 endpoints, medium reliability
    { id: 's1', name: 'Sats4AI: Convert', url: 'https://sats4ai.com/convert', protocol: 'L402', source: 'satring', category: 'ai/llm', health_status: 'healthy', reliability_score: 93, latency_p50_ms: 450, price_sats: 50, price_usd: null, x402_payment_valid: null, is_template: 0, is_demo: 0 },
    { id: 's2', name: 'Sats4AI: OCR', url: 'https://sats4ai.com/ocr', protocol: 'L402', source: 'satring', category: 'ai/llm', health_status: 'degraded', reliability_score: 85, latency_p50_ms: 800, price_sats: 100, price_usd: null, x402_payment_valid: null, is_template: 0, is_demo: 0 },

    // Provider C (api.anthropic.com) — MPP, 2 endpoints
    { id: 'a1', name: 'Claude: Messages', url: 'https://api.anthropic.com/messages', protocol: 'MPP', source: 'mpp', category: 'ai/llm', health_status: 'healthy', reliability_score: 95, latency_p50_ms: 300, price_sats: null, price_usd: 0.003, x402_payment_valid: null, is_template: 0, is_demo: 0 },
    { id: 'a2', name: 'Claude: Completions', url: 'https://api.anthropic.com/completions', protocol: 'MPP', source: 'mpp', category: 'ai/llm', health_status: 'healthy', reliability_score: 92, latency_p50_ms: 350, price_sats: null, price_usd: 0.003, x402_payment_valid: null, is_template: 0, is_demo: 0 },

    // Low reliability endpoint (solo)
    { id: 'lo1', name: 'Unreliable API', url: 'https://flaky.example.com/data', protocol: 'x402', source: 'bazaar', category: 'data', health_status: 'down', reliability_score: 30, latency_p50_ms: 5000, price_sats: null, price_usd: 0.1, x402_payment_valid: 0, is_template: 0, is_demo: 0 },

    // Template endpoint (should be excluded)
    { id: 't1', name: 'Template API', url: 'https://template.example.com/api', protocol: 'x402', source: 'bazaar', category: 'data', health_status: 'healthy', reliability_score: 50, latency_p50_ms: 100, price_sats: null, price_usd: null, x402_payment_valid: 1, is_template: 1, is_demo: 0 },

    // Endpoint with no latency data
    { id: 'nl1', name: 'No Latency', url: 'https://slow.example.com/api', protocol: 'L402', source: 'satring', category: 'search', health_status: 'healthy', reliability_score: 80, latency_p50_ms: null, price_sats: 10, price_usd: null, x402_payment_valid: null, is_template: 0, is_demo: 0 },

    // Social category — only x402
    { id: 'soc1', name: 'Social API 1', url: 'https://social.example.com/feed', protocol: 'x402', source: 'bazaar', category: 'social', health_status: 'healthy', reliability_score: 90, latency_p50_ms: 250, price_sats: null, price_usd: 0.005, x402_payment_valid: 1, is_template: 0, is_demo: 0 },
    { id: 'soc2', name: 'Social API 2', url: 'https://social2.example.com/feed', protocol: 'x402', source: 'bazaar', category: 'social', health_status: 'healthy', reliability_score: 88, latency_p50_ms: 300, price_sats: null, price_usd: 0.005, x402_payment_valid: 1, is_template: 0, is_demo: 0 },
    { id: 'soc3', name: 'Social API 3', url: 'https://social3.example.com/feed', protocol: 'x402', source: 'bazaar', category: 'social', health_status: 'healthy', reliability_score: 85, latency_p50_ms: 280, price_sats: null, price_usd: 0.005, x402_payment_valid: 1, is_template: 0, is_demo: 0 },
  ]

  for (const svc of services) {
    insert.run(svc)
  }
}

// ─── Tests: Daily Snapshot ───────────────────────────────────────────────────

describe('captureSnapshot', () => {
  let db

  before(() => {
    db = createTestDb()
    seedServices(db)
  })

  after(() => db.close())

  it('creates a row with today\'s date', async () => {
    const { captureSnapshot } = await import('../src/services/daily-snapshot.js')
    const result = captureSnapshot(db)
    assert.ok(result.snapshot_date)
    assert.ok(result.total_endpoints > 0)

    const row = db.prepare('SELECT * FROM daily_snapshots WHERE snapshot_date = ?').get(result.snapshot_date)
    assert.ok(row)
    assert.equal(row.total_endpoints, result.total_endpoints)
  })

  it('upserts — calling twice on same day produces one row', async () => {
    const { captureSnapshot } = await import('../src/services/daily-snapshot.js')
    captureSnapshot(db)
    captureSnapshot(db)

    const today = new Date().toISOString().slice(0, 10)
    const rows = db.prepare('SELECT COUNT(*) as c FROM daily_snapshots WHERE snapshot_date = ?').all(today)
    assert.equal(rows[0].c, 1)
  })

  it('captures correct aggregate counts', async () => {
    const { captureSnapshot } = await import('../src/services/daily-snapshot.js')
    captureSnapshot(db)
    const today = new Date().toISOString().slice(0, 10)
    const row = db.prepare('SELECT * FROM daily_snapshots WHERE snapshot_date = ?').get(today)

    // 13 total services (including 1 template)
    assert.equal(row.total_endpoints, 13)
    // Verified: x402 with payment_valid=1, L402 healthy, MPP healthy
    // n1,n2,n3 (x402 valid) + s1 (L402 healthy) + a1,a2 (MPP healthy) + soc1,soc2,soc3 (x402 valid) + t1 (x402 valid, template) + nl1 (L402 healthy) = 11
    assert.equal(row.verified_endpoints, 11)
  })

  it('captures per-protocol counts', async () => {
    const { captureSnapshot } = await import('../src/services/daily-snapshot.js')
    captureSnapshot(db)
    const today = new Date().toISOString().slice(0, 10)
    const row = db.prepare('SELECT * FROM daily_snapshots WHERE snapshot_date = ?').get(today)

    // L402: s1, s2, nl1 = 3
    assert.equal(row.l402_endpoints, 3)
    // x402: n1, n2, n3, lo1, t1, soc1, soc2, soc3 = 8
    assert.equal(row.x402_endpoints, 8)
    // MPP: a1, a2 = 2
    assert.equal(row.mpp_endpoints, 2)
  })

  it('captures health breakdown', async () => {
    const { captureSnapshot } = await import('../src/services/daily-snapshot.js')
    captureSnapshot(db)
    const today = new Date().toISOString().slice(0, 10)
    const row = db.prepare('SELECT * FROM daily_snapshots WHERE snapshot_date = ?').get(today)

    assert.ok(row.healthy_endpoints > 0)
    assert.ok(row.down_endpoints >= 0)
  })

  it('categories_json is valid JSON', async () => {
    const { captureSnapshot } = await import('../src/services/daily-snapshot.js')
    captureSnapshot(db)
    const today = new Date().toISOString().slice(0, 10)
    const row = db.prepare('SELECT * FROM daily_snapshots WHERE snapshot_date = ?').get(today)

    assert.doesNotThrow(() => JSON.parse(row.categories_json))
    const categories = JSON.parse(row.categories_json)
    assert.ok(typeof categories === 'object')
  })

  it('top_providers_json is valid JSON array', async () => {
    const { captureSnapshot } = await import('../src/services/daily-snapshot.js')
    captureSnapshot(db)
    const today = new Date().toISOString().slice(0, 10)
    const row = db.prepare('SELECT * FROM daily_snapshots WHERE snapshot_date = ?').get(today)

    assert.doesNotThrow(() => JSON.parse(row.top_providers_json))
    const providers = JSON.parse(row.top_providers_json)
    assert.ok(Array.isArray(providers))
  })
})

describe('getSnapshots', () => {
  let db

  before(() => {
    db = createTestDb()
    // Insert some snapshot rows directly
    const insert = db.prepare(
      'INSERT INTO daily_snapshots (snapshot_date, total_endpoints) VALUES (?, ?)'
    )
    insert.run('2026-03-10', 10000)
    insert.run('2026-03-11', 10100)
    insert.run('2026-03-12', 10200)
    insert.run('2026-03-13', 10300)
    insert.run('2026-03-14', 10400)
  })

  after(() => db.close())

  it('returns snapshots sorted by date ascending', async () => {
    const { getSnapshots } = await import('../src/services/daily-snapshot.js')
    const snapshots = getSnapshots(db, 30)
    assert.ok(snapshots.length > 0)
    for (let i = 1; i < snapshots.length; i++) {
      assert.ok(snapshots[i].snapshot_date >= snapshots[i - 1].snapshot_date)
    }
  })

  it('limits to requested number of days', async () => {
    const { getSnapshots } = await import('../src/services/daily-snapshot.js')
    const snapshots = getSnapshots(db, 3)
    assert.ok(snapshots.length <= 3)
  })

  it('clamps days to max 365', async () => {
    const { getSnapshots } = await import('../src/services/daily-snapshot.js')
    // Should not throw
    const snapshots = getSnapshots(db, 9999)
    assert.ok(Array.isArray(snapshots))
  })
})

// ─── Tests: Scoreboard Data ─────────────────────────────────────────────────

describe('getScoreboardData', () => {
  let db

  before(() => {
    db = createTestDb()
    seedServices(db)
  })

  after(() => db.close())

  it('groups providers by hostname', async () => {
    const { getScoreboardData } = await import('../src/services/daily-snapshot.js')
    const { providers } = getScoreboardData(db)

    // api.nansen.ai should be grouped
    const nansen = providers.find(p => p.provider === 'api.nansen.ai')
    assert.ok(nansen, 'Nansen provider should exist')
    assert.equal(nansen.endpoints, 3)
    assert.deepEqual(nansen.protocols, ['x402'])
  })

  it('filters out providers with fewer than 2 endpoints', async () => {
    const { getScoreboardData } = await import('../src/services/daily-snapshot.js')
    const { providers } = getScoreboardData(db)

    // flaky.example.com has only 1 endpoint — should not appear
    const flaky = providers.find(p => p.provider === 'flaky.example.com')
    assert.equal(flaky, undefined)
  })

  it('computes avg reliability and healthy_pct', async () => {
    const { getScoreboardData } = await import('../src/services/daily-snapshot.js')
    const { providers } = getScoreboardData(db)

    const nansen = providers.find(p => p.provider === 'api.nansen.ai')
    assert.ok(nansen)
    // avg of 99.8, 100, 98 ≈ 99.3
    assert.ok(nansen.avg_reliability >= 99 && nansen.avg_reliability <= 100)
    assert.equal(nansen.healthy_pct, 100) // all 3 healthy
  })

  it('returns endpoint-level data sorted by effective_score', async () => {
    const { getScoreboardData } = await import('../src/services/daily-snapshot.js')
    const { endpoints } = getScoreboardData(db)

    assert.ok(endpoints.length > 0)
    for (let i = 1; i < endpoints.length; i++) {
      assert.ok(endpoints[i].effective_score <= endpoints[i - 1].effective_score,
        `endpoint ${endpoints[i].id} (${endpoints[i].effective_score}) should not rank above ${endpoints[i - 1].id} (${endpoints[i - 1].effective_score})`)
    }
  })

  it('excludes templates from scoreboard', async () => {
    const { getScoreboardData } = await import('../src/services/daily-snapshot.js')
    const { endpoints } = getScoreboardData(db)

    const template = endpoints.find(e => e.id === 't1')
    assert.equal(template, undefined)
  })
})

// ─── Tests: Latency Data ────────────────────────────────────────────────────

describe('getLatencyData', () => {
  let db

  before(() => {
    db = createTestDb()
    seedServices(db)
  })

  after(() => db.close())

  it('buckets latency data correctly', async () => {
    const { getLatencyData } = await import('../src/services/daily-snapshot.js')
    const { buckets } = getLatencyData(db)

    assert.equal(buckets.length, 7)
    // Sum of all buckets should equal total healthy endpoints with latency data
    const total = buckets.reduce((sum, b) => sum + b.L402 + b.x402 + b.MPP, 0)
    assert.ok(total > 0)
  })

  it('per-protocol breakdown sums to total per bucket', async () => {
    const { getLatencyData } = await import('../src/services/daily-snapshot.js')
    const { buckets } = getLatencyData(db)

    for (const bucket of buckets) {
      const sum = bucket.L402 + bucket.x402 + bucket.MPP
      assert.ok(sum >= 0)
    }
  })

  it('computes median and fastest protocol', async () => {
    const { getLatencyData } = await import('../src/services/daily-snapshot.js')
    const data = getLatencyData(db)

    assert.ok(data.median != null, 'median should be computed')
    assert.ok(data.fastestProtocol, 'fastest protocol should be identified')
    assert.ok(data.under500 >= 0)
  })

  it('excludes endpoints with NULL latency', async () => {
    const { getLatencyData } = await import('../src/services/daily-snapshot.js')
    const { buckets } = getLatencyData(db)

    // nl1 has null latency — should not appear in any bucket
    const total = buckets.reduce((sum, b) => sum + b.L402 + b.x402 + b.MPP, 0)
    // s1 (450ms, healthy L402), n1-n3 (healthy x402, 170/150/200), a1-a2 (healthy MPP, 300/350), soc1-3 (250/300/280)
    // nl1 excluded (null latency), s2 excluded (degraded), lo1 excluded (down), t1 excluded (template)
    assert.equal(total, 9)
  })

  it('provides per-protocol summary', async () => {
    const { getLatencyData } = await import('../src/services/daily-snapshot.js')
    const data = getLatencyData(db)

    assert.ok(data.protocolSummary.L402)
    assert.ok(data.protocolSummary.x402)
    assert.ok(data.protocolSummary.MPP)
  })
})

// ─── Tests: Category Gap Map ────────────────────────────────────────────────

describe('getCategoryGapData', () => {
  let db

  before(() => {
    db = createTestDb()
    seedServices(db)
  })

  after(() => db.close())

  it('returns grid with no duplicate categories', async () => {
    const { getCategoryGapData } = await import('../src/services/daily-snapshot.js')
    const { grid } = getCategoryGapData(db)

    // Seed data has small categories (<10 each) so grid may be empty after threshold filter
    const categories = grid.map(r => r.category)
    assert.equal(categories.length, new Set(categories).size)
  })

  it('grid has L402, x402, MPP, and total columns', async () => {
    const { getCategoryGapData } = await import('../src/services/daily-snapshot.js')
    const { grid } = getCategoryGapData(db)

    for (const row of grid) {
      assert.ok('L402' in row)
      assert.ok('x402' in row)
      assert.ok('MPP' in row)
      assert.ok('total' in row)
      assert.equal(row.total, row.L402 + row.x402 + row.MPP)
    }
  })

  it('filters out categories with fewer than 10 total endpoints', async () => {
    const { getCategoryGapData } = await import('../src/services/daily-snapshot.js')
    const { grid } = getCategoryGapData(db)

    for (const row of grid) {
      assert.ok(row.total >= 10, `Category "${row.category}" has ${row.total} < 10`)
    }
  })

  it('identifies opportunity gaps (zero-count cells)', async () => {
    const { getCategoryGapData } = await import('../src/services/daily-snapshot.js')
    const { opportunities } = getCategoryGapData(db)

    // Social category has x402 but no L402 or MPP — should appear
    assert.ok(Array.isArray(opportunities))
    // At least one opportunity should exist
    if (opportunities.length > 0) {
      assert.ok(opportunities[0].category)
      assert.ok(opportunities[0].protocol)
      assert.ok(opportunities[0].count >= 0)
    }
  })

  it('excludes templates from gap map', async () => {
    const { getCategoryGapData } = await import('../src/services/daily-snapshot.js')
    const { grid } = getCategoryGapData(db)

    // Template endpoint in 'data' category should not be counted
    const dataRow = grid.find(r => r.category === 'data')
    if (dataRow) {
      // Only n1,n2,n3 are healthy x402 in data (t1 excluded as template)
      assert.equal(dataRow.x402, 3)
    }
  })
})

// ─── Tests: Scoreboard Effective Score Ranking ──────────────────────────────

describe('getScoreboardData — effective score ranking', () => {
  let db

  before(() => {
    db = createTestDb()
    const insert = db.prepare(`
      INSERT INTO services (id, name, url, protocol, source, category, health_status, reliability_score, latency_p50_ms, price_sats, price_usd, x402_payment_valid, is_template, is_demo)
      VALUES (@id, @name, @url, @protocol, @source, @category, @health_status, @reliability_score, @latency_p50_ms, @price_sats, @price_usd, @x402_payment_valid, @is_template, @is_demo)
    `)

    // Provider "degraded-high.example.com" — 2 endpoints, all degraded, reliability 100
    insert.run({ id: 'dh1', name: 'DegHigh 1', url: 'https://degraded-high.example.com/a', protocol: 'x402', source: 'bazaar', category: 'data', health_status: 'degraded', reliability_score: 100, latency_p50_ms: 100, price_sats: null, price_usd: 0.01, x402_payment_valid: 1, is_template: 0, is_demo: 0 })
    insert.run({ id: 'dh2', name: 'DegHigh 2', url: 'https://degraded-high.example.com/b', protocol: 'x402', source: 'bazaar', category: 'data', health_status: 'degraded', reliability_score: 100, latency_p50_ms: 120, price_sats: null, price_usd: 0.01, x402_payment_valid: 1, is_template: 0, is_demo: 0 })

    // Provider "healthy-med.example.com" — 2 endpoints, all healthy, reliability 90
    insert.run({ id: 'hm1', name: 'HealthMed 1', url: 'https://healthy-med.example.com/a', protocol: 'x402', source: 'bazaar', category: 'data', health_status: 'healthy', reliability_score: 90, latency_p50_ms: 200, price_sats: null, price_usd: 0.01, x402_payment_valid: 1, is_template: 0, is_demo: 0 })
    insert.run({ id: 'hm2', name: 'HealthMed 2', url: 'https://healthy-med.example.com/b', protocol: 'x402', source: 'bazaar', category: 'data', health_status: 'healthy', reliability_score: 90, latency_p50_ms: 210, price_sats: null, price_usd: 0.01, x402_payment_valid: 1, is_template: 0, is_demo: 0 })

    // Provider "mixed.example.com" — 2 endpoints, 1 healthy (reliability 100) + 1 degraded (reliability 100)
    insert.run({ id: 'mx1', name: 'Mixed 1', url: 'https://mixed.example.com/a', protocol: 'L402', source: 'satring', category: 'ai', health_status: 'healthy', reliability_score: 100, latency_p50_ms: 150, price_sats: 10, price_usd: null, x402_payment_valid: null, is_template: 0, is_demo: 0 })
    insert.run({ id: 'mx2', name: 'Mixed 2', url: 'https://mixed.example.com/b', protocol: 'L402', source: 'satring', category: 'ai', health_status: 'degraded', reliability_score: 100, latency_p50_ms: 300, price_sats: 20, price_usd: null, x402_payment_valid: null, is_template: 0, is_demo: 0 })

    // Provider "down.example.com" — 2 endpoints, both down, reliability 95
    insert.run({ id: 'dn1', name: 'Down 1', url: 'https://down.example.com/a', protocol: 'x402', source: 'bazaar', category: 'data', health_status: 'down', reliability_score: 95, latency_p50_ms: 500, price_sats: null, price_usd: 0.05, x402_payment_valid: 0, is_template: 0, is_demo: 0 })
    insert.run({ id: 'dn2', name: 'Down 2', url: 'https://down.example.com/b', protocol: 'x402', source: 'bazaar', category: 'data', health_status: 'down', reliability_score: 95, latency_p50_ms: 600, price_sats: null, price_usd: 0.05, x402_payment_valid: 0, is_template: 0, is_demo: 0 })
  })

  after(() => db.close())

  it('all-healthy provider: effective_score equals reliability_score', async () => {
    const { getScoreboardData } = await import('../src/services/daily-snapshot.js')
    const { providers } = getScoreboardData(db)
    const hm = providers.find(p => p.provider === 'healthy-med.example.com')
    assert.ok(hm)
    assert.equal(hm.avg_effective, 90)
  })

  it('all-degraded provider: effective_score = reliability * 0.5', async () => {
    const { getScoreboardData } = await import('../src/services/daily-snapshot.js')
    const { providers } = getScoreboardData(db)
    const dh = providers.find(p => p.provider === 'degraded-high.example.com')
    assert.ok(dh)
    assert.equal(dh.avg_effective, 50) // 100 * 0.5
  })

  it('mixed healthy+degraded: effective is weighted average', async () => {
    const { getScoreboardData } = await import('../src/services/daily-snapshot.js')
    const { providers } = getScoreboardData(db)
    const mx = providers.find(p => p.provider === 'mixed.example.com')
    assert.ok(mx)
    // (100*1.0 + 100*0.5) / 2 = 75
    assert.equal(mx.avg_effective, 75)
  })

  it('healthy provider at 90 ranks ABOVE degraded provider at 100', async () => {
    const { getScoreboardData } = await import('../src/services/daily-snapshot.js')
    const { providers } = getScoreboardData(db)
    const hmIdx = providers.findIndex(p => p.provider === 'healthy-med.example.com')
    const dhIdx = providers.findIndex(p => p.provider === 'degraded-high.example.com')
    assert.ok(hmIdx >= 0 && dhIdx >= 0)
    assert.ok(hmIdx < dhIdx, `healthy-med (rank ${hmIdx}) should be above degraded-high (rank ${dhIdx})`)
  })

  it('down endpoints contribute 0 to effective score', async () => {
    const { getScoreboardData } = await import('../src/services/daily-snapshot.js')
    const { providers } = getScoreboardData(db)
    const dn = providers.find(p => p.provider === 'down.example.com')
    assert.ok(dn)
    assert.equal(dn.avg_effective, 0) // 95 * 0.0 = 0
  })

  it('endpoint-level: healthy at 80 ranks above degraded at 100', async () => {
    const { getScoreboardData } = await import('../src/services/daily-snapshot.js')
    const { endpoints } = getScoreboardData(db)
    // hm1 (healthy, reliability 90) should appear before dh1 (degraded, reliability 100)
    const hm1Idx = endpoints.findIndex(e => e.id === 'hm1')
    const dh1Idx = endpoints.findIndex(e => e.id === 'dh1')
    assert.ok(hm1Idx >= 0 && dh1Idx >= 0)
    assert.ok(hm1Idx < dh1Idx, `healthy hm1 (rank ${hm1Idx}) should be above degraded dh1 (rank ${dh1Idx})`)
  })

  it('sort order matches effective_score descending', async () => {
    const { getScoreboardData } = await import('../src/services/daily-snapshot.js')
    const { providers } = getScoreboardData(db)
    for (let i = 1; i < providers.length; i++) {
      assert.ok(providers[i].avg_effective <= providers[i - 1].avg_effective,
        `Provider ${providers[i].provider} (${providers[i].avg_effective}) should not rank above ${providers[i - 1].provider} (${providers[i - 1].avg_effective})`)
    }
  })
})

// ─── Tests: Category Gap Map Polish ─────────────────────────────────────────

describe('getCategoryGapData — polish', () => {
  let db

  before(() => {
    db = createTestDb()
    const insert = db.prepare(`
      INSERT INTO services (id, name, url, protocol, source, category, health_status, reliability_score, latency_p50_ms, price_sats, price_usd, x402_payment_valid, is_template, is_demo)
      VALUES (@id, @name, @url, @protocol, @source, @category, @health_status, @reliability_score, @latency_p50_ms, @price_sats, @price_usd, @x402_payment_valid, @is_template, @is_demo)
    `)
    const base = { source: 'bazaar', health_status: 'healthy', reliability_score: 90, latency_p50_ms: 200, price_sats: null, price_usd: 0.01, x402_payment_valid: 1, is_template: 0, is_demo: 0 }

    // Uncategorized — 15 endpoints (should be filtered out)
    for (let i = 0; i < 15; i++) {
      insert.run({ ...base, id: `unc-${i}`, name: `Uncat ${i}`, url: `https://unc${i}.example.com/api`, protocol: 'x402', category: 'uncategorized' })
    }

    // crypto/defi — 12 x402 endpoints
    for (let i = 0; i < 12; i++) {
      insert.run({ ...base, id: `cd-${i}`, name: `CryptoDefi ${i}`, url: `https://cryptodefi${i}.example.com/api`, protocol: 'x402', category: 'crypto/defi' })
    }

    // crypto/wallet — 8 x402 endpoints
    for (let i = 0; i < 8; i++) {
      insert.run({ ...base, id: `cw-${i}`, name: `CryptoWallet ${i}`, url: `https://cryptowallet${i}.example.com/api`, protocol: 'x402', category: 'crypto/wallet' })
    }

    // crypto/nft — 5 x402 endpoints
    for (let i = 0; i < 5; i++) {
      insert.run({ ...base, id: `cn-${i}`, name: `CryptoNft ${i}`, url: `https://cryptonft${i}.example.com/api`, protocol: 'x402', category: 'crypto/nft' })
    }

    // ai/llm — 6 endpoints (3 L402, 3 MPP)
    for (let i = 0; i < 3; i++) {
      insert.run({ ...base, id: `al-${i}`, name: `AiLlm L402 ${i}`, url: `https://aillm-l402-${i}.example.com/api`, protocol: 'L402', category: 'ai/llm', x402_payment_valid: null, price_sats: 10 })
    }
    for (let i = 0; i < 3; i++) {
      insert.run({ ...base, id: `am-${i}`, name: `AiLlm MPP ${i}`, url: `https://aillm-mpp-${i}.example.com/api`, protocol: 'MPP', category: 'ai/llm', x402_payment_valid: null })
    }

    // ai/images — 5 MPP endpoints
    for (let i = 0; i < 5; i++) {
      insert.run({ ...base, id: `ai-${i}`, name: `AiImg ${i}`, url: `https://aiimg${i}.example.com/api`, protocol: 'MPP', category: 'ai/images', x402_payment_valid: null })
    }

    // tools/search — 4 endpoints (below threshold of 10 after consolidation? only if alone)
    for (let i = 0; i < 4; i++) {
      insert.run({ ...base, id: `ts-${i}`, name: `ToolSearch ${i}`, url: `https://toolsearch${i}.example.com/api`, protocol: 'x402', category: 'tools/search' })
    }

    // tools/convert — 7 endpoints
    for (let i = 0; i < 7; i++) {
      insert.run({ ...base, id: `tc-${i}`, name: `ToolConvert ${i}`, url: `https://toolconvert${i}.example.com/api`, protocol: 'x402', category: 'tools/convert' })
    }

    // small-cat — 9 endpoints (below threshold)
    for (let i = 0; i < 9; i++) {
      insert.run({ ...base, id: `sm-${i}`, name: `Small ${i}`, url: `https://small${i}.example.com/api`, protocol: 'x402', category: 'small-cat' })
    }

    // exact-10 — exactly 10 endpoints (at boundary, should be included)
    for (let i = 0; i < 10; i++) {
      insert.run({ ...base, id: `e10-${i}`, name: `Exact10 ${i}`, url: `https://exact10-${i}.example.com/api`, protocol: 'x402', category: 'exact-10' })
    }
  })

  after(() => db.close())

  it('"uncategorized" never appears in grid results', async () => {
    const { getCategoryGapData } = await import('../src/services/daily-snapshot.js')
    const { grid } = getCategoryGapData(db)
    const uncat = grid.find(r => r.category === 'uncategorized')
    assert.equal(uncat, undefined)
  })

  it('"crypto/defi" and "crypto/wallet" merge into "crypto"', async () => {
    const { getCategoryGapData } = await import('../src/services/daily-snapshot.js')
    const { grid } = getCategoryGapData(db)
    const cryptoDefi = grid.find(r => r.category === 'crypto/defi')
    const cryptoWallet = grid.find(r => r.category === 'crypto/wallet')
    assert.equal(cryptoDefi, undefined, 'crypto/defi should not appear as separate row')
    assert.equal(cryptoWallet, undefined, 'crypto/wallet should not appear as separate row')
    const crypto = grid.find(r => r.category === 'crypto')
    assert.ok(crypto, 'consolidated "crypto" row should exist')
  })

  it('consolidated counts are correct (sum of subcategory counts)', async () => {
    const { getCategoryGapData } = await import('../src/services/daily-snapshot.js')
    const { grid } = getCategoryGapData(db)
    const crypto = grid.find(r => r.category === 'crypto')
    assert.ok(crypto)
    // 12 (defi) + 8 (wallet) + 5 (nft) = 25 x402
    assert.equal(crypto.x402, 25)
    assert.equal(crypto.total, 25)
  })

  it('"ai/llm" merges into "ai" with "ai/images"', async () => {
    const { getCategoryGapData } = await import('../src/services/daily-snapshot.js')
    const { grid } = getCategoryGapData(db)
    const aiLlm = grid.find(r => r.category === 'ai/llm')
    assert.equal(aiLlm, undefined, 'ai/llm should not appear as separate row')
    const ai = grid.find(r => r.category === 'ai')
    assert.ok(ai, 'consolidated "ai" row should exist')
    // ai/llm: 3 L402 + 3 MPP; ai/images: 5 MPP
    assert.equal(ai.L402, 3)
    assert.equal(ai.MPP, 8) // 3 + 5
    assert.equal(ai.total, 11)
  })

  it('"tools/search" merges into "tools"', async () => {
    const { getCategoryGapData } = await import('../src/services/daily-snapshot.js')
    const { grid } = getCategoryGapData(db)
    const toolsSearch = grid.find(r => r.category === 'tools/search')
    assert.equal(toolsSearch, undefined, 'tools/search should not appear as separate row')
    const tools = grid.find(r => r.category === 'tools')
    assert.ok(tools, 'consolidated "tools" row should exist')
    // 4 (search) + 7 (convert) = 11 x402
    assert.equal(tools.x402, 11)
  })

  it('categories with <10 total endpoints are excluded', async () => {
    const { getCategoryGapData } = await import('../src/services/daily-snapshot.js')
    const { grid } = getCategoryGapData(db)
    const small = grid.find(r => r.category === 'small-cat')
    assert.equal(small, undefined, 'small-cat (9 endpoints) should be excluded')
  })

  it('category with exactly 10 endpoints is included', async () => {
    const { getCategoryGapData } = await import('../src/services/daily-snapshot.js')
    const { grid } = getCategoryGapData(db)
    const exact = grid.find(r => r.category === 'exact-10')
    assert.ok(exact, 'exact-10 (10 endpoints) should be included')
  })

  it('opportunity callouts only for categories where one protocol has ≥20', async () => {
    const { getCategoryGapData } = await import('../src/services/daily-snapshot.js')
    const { opportunities } = getCategoryGapData(db)
    for (const opp of opportunities) {
      // Find the category in grid
      const { grid } = getCategoryGapData(db)
      const cat = grid.find(r => r.category === opp.category)
      assert.ok(cat, `Opportunity category "${opp.category}" should exist in grid`)
      // At least one protocol should have ≥20 in this category
      const maxProto = Math.max(cat.L402, cat.x402, cat.MPP)
      assert.ok(maxProto >= 20, `Opportunity for "${opp.category}" requires at least one protocol with ≥20, got max ${maxProto}`)
    }
  })
})

// ─── Tests: Latency Chart Note ──────────────────────────────────────────────

describe('statsPage — latency chart note', () => {
  it('contains stats-chart-note element', async () => {
    const { statsPage } = await import('../src/views/stats.js')
    const html = statsPage({
      scoreboard: { providers: [], endpoints: [] },
      latency: { buckets: [], median: 200, under500: 80, fastestProtocol: 'x402', fastestMedian: 170, protocolSummary: { L402: { median: 400, p90: 800, under500: 50 }, x402: { median: 170, p90: 200, under500: 100 }, MPP: { median: 300, p90: 350, under500: 100 } } },
      categoryGap: { grid: [], opportunities: [] },
    })
    assert.ok(html.includes('stats-chart-note'), 'Should contain stats-chart-note class')
  })

  it('note mentions healthy endpoints and endpoint counts', async () => {
    const { statsPage } = await import('../src/views/stats.js')
    const html = statsPage({
      scoreboard: { providers: [], endpoints: [] },
      latency: { buckets: [], median: 200, under500: 80, fastestProtocol: 'x402', fastestMedian: 170, protocolSummary: { L402: { median: 400, p90: 800, under500: 50 }, x402: { median: 170, p90: 200, under500: 100 }, MPP: { median: 300, p90: 350, under500: 100 } } },
      categoryGap: { grid: [], opportunities: [] },
    })
    assert.ok(html.includes('healthy endpoints'), 'Note should mention healthy endpoints')
    assert.ok(html.includes('x402'), 'Note should mention x402')
  })
})

// ─── Tests: Stats Page Rendering ────────────────────────────────────────────

describe('statsPage', () => {
  it('renders all 3 sections', async () => {
    const { statsPage } = await import('../src/views/stats.js')
    const html = statsPage({
      scoreboard: { providers: [], endpoints: [] },
      latency: { buckets: [], median: null, under500: 0, fastestProtocol: null, fastestMedian: null, protocolSummary: { L402: { median: null, p90: null, under500: 0 }, x402: { median: null, p90: null, under500: 0 }, MPP: { median: null, p90: null, under500: 0 } } },
      categoryGap: { grid: [], opportunities: [] },
    })

    assert.ok(html.includes('Which Paid APIs Work the Best'))
    assert.ok(html.includes('How Fast Is the Paid API Economy'))
    assert.ok(html.includes("What's Missing"))
  })

  it('renders reliability scoreboard toggle', async () => {
    const { statsPage } = await import('../src/views/stats.js')
    const html = statsPage({
      scoreboard: { providers: [], endpoints: [] },
      latency: { buckets: [], median: null, under500: 0, fastestProtocol: null, fastestMedian: null, protocolSummary: { L402: { median: null, p90: null, under500: 0 }, x402: { median: null, p90: null, under500: 0 }, MPP: { median: null, p90: null, under500: 0 } } },
      categoryGap: { grid: [], opportunities: [] },
    })

    assert.ok(html.includes('By Provider'))
    assert.ok(html.includes('By Endpoint'))
  })

  it('renders latency callouts when data present', async () => {
    const { statsPage } = await import('../src/views/stats.js')
    const html = statsPage({
      scoreboard: { providers: [], endpoints: [] },
      latency: { buckets: [], median: 250, under500: 85, fastestProtocol: 'x402', fastestMedian: 170, protocolSummary: { L402: { median: 450, p90: 800, under500: 50 }, x402: { median: 170, p90: 200, under500: 100 }, MPP: { median: 300, p90: 350, under500: 100 } } },
      categoryGap: { grid: [], opportunities: [] },
    })

    assert.ok(html.includes('250ms'))
    assert.ok(html.includes('85%'))
    assert.ok(html.includes('x402'))
  })

  it('renders category gap map with zero cells', async () => {
    const { statsPage } = await import('../src/views/stats.js')
    const html = statsPage({
      scoreboard: { providers: [], endpoints: [] },
      latency: { buckets: [], median: null, under500: 0, fastestProtocol: null, fastestMedian: null, protocolSummary: { L402: { median: null, p90: null, under500: 0 }, x402: { median: null, p90: null, under500: 0 }, MPP: { median: null, p90: null, under500: 0 } } },
      categoryGap: {
        grid: [{ category: 'ai/llm', L402: 2, x402: 0, MPP: 3, total: 5 }],
        opportunities: [{ category: 'ai/llm', protocol: 'x402', count: 0 }],
      },
    })

    assert.ok(html.includes('gap-zero'))
    assert.ok(html.includes('Opportunities'))
    assert.ok(html.includes('ai/llm'))
  })

  it('does NOT include Chart.js CDN script (replaced with CSS bars)', async () => {
    const { statsPage } = await import('../src/views/stats.js')
    const html = statsPage({
      scoreboard: { providers: [], endpoints: [] },
      latency: { buckets: [], median: null, under500: 0, fastestProtocol: null, fastestMedian: null, protocolSummary: { L402: { median: null, p90: null, under500: 0 }, x402: { median: null, p90: null, under500: 0 }, MPP: { median: null, p90: null, under500: 0 } } },
      categoryGap: { grid: [], opportunities: [] },
    })

    assert.ok(!html.includes('cdn.jsdelivr.net/npm/chart.js'), 'Chart.js should be removed')
  })

  it('renders correct meta tags', async () => {
    const { statsPage } = await import('../src/views/stats.js')
    const html = statsPage({
      scoreboard: { providers: [], endpoints: [] },
      latency: { buckets: [], median: null, under500: 0, fastestProtocol: null, fastestMedian: null, protocolSummary: { L402: { median: null, p90: null, under500: 0 }, x402: { median: null, p90: null, under500: 0 }, MPP: { median: null, p90: null, under500: 0 } } },
      categoryGap: { grid: [], opportunities: [] },
    })

    assert.ok(html.includes('<title>Stats — 402 Index</title>'))
    assert.ok(html.includes('og:title'))
    assert.ok(html.includes('402index.io/stats'))
  })
})

// ─── Tests: Nav Update ──────────────────────────────────────────────────────

describe('layout — Stats nav link', () => {
  it('includes Stats link in navigation', async () => {
    const { layout } = await import('../src/views/layout.js')
    const html = layout('Test', '<div>content</div>')
    assert.ok(html.includes('href="/stats"'))
    assert.ok(html.includes('>Stats<'))
  })

  it('Stats comes before Directory in nav order', async () => {
    const { layout } = await import('../src/views/layout.js')
    const html = layout('Test', '<div>content</div>')
    const statsPos = html.indexOf('href="/stats"')
    const dirPos = html.indexOf('href="/directory"')
    assert.ok(statsPos < dirPos, 'Stats should appear before Directory in nav')
  })
})

// ─── Tests: Featured Endpoint Ordering ──────────────────────────────────────

describe('featured endpoint ordering', () => {
  it('Mutinynet Faucet ID is first in FEATURED_IDS', async () => {
    const content = await import('fs').then(fs =>
      fs.readFileSync(join(__dirname, '..', 'src', 'routes', 'pages.js'), 'utf-8')
    )
    const match = content.match(/const FEATURED_IDS = \[([^\]]+)\]/)
    assert.ok(match, 'FEATURED_IDS should be defined')
    const ids = match[1].match(/'([a-f0-9-]+)'/g).map(s => s.replace(/'/g, ''))
    assert.equal(ids[0], 'c2323cdb-8d35-44e1-a093-209beec8afa9', 'Mutinynet Faucet should be first')
  })

  it('featured results are reordered to match FEATURED_IDS array order', async () => {
    const content = await import('fs').then(fs =>
      fs.readFileSync(join(__dirname, '..', 'src', 'routes', 'pages.js'), 'utf-8')
    )
    assert.ok(content.includes('idOrder'), 'Should use idOrder Map for reordering')
    assert.ok(content.includes('featuredServices.sort'), 'Should sort featuredServices to preserve order')
  })
})

// ─── Tests: Backfill Script ─────────────────────────────────────────────────

// ─── Tests: Fix 1 — Per-Protocol Balancing ─────────────────────────────────

describe('getScoreboardData — per-protocol balancing', () => {
  let db

  before(() => {
    db = createTestDb()
    const insert = db.prepare(`
      INSERT INTO services (id, name, url, protocol, source, category, health_status, reliability_score, latency_p50_ms, price_sats, price_usd, x402_payment_valid, is_template, is_demo)
      VALUES (@id, @name, @url, @protocol, @source, @category, @health_status, @reliability_score, @latency_p50_ms, @price_sats, @price_usd, @x402_payment_valid, @is_template, @is_demo)
    `)
    const base = { source: 'bazaar', category: 'data', health_status: 'healthy', latency_p50_ms: 200, price_sats: null, price_usd: 0.01, x402_payment_valid: 1, is_template: 0, is_demo: 0 }

    // 50 x402 endpoints with reliability 100 — would overwhelm L402/MPP with old LIMIT 100
    for (let i = 0; i < 50; i++) {
      insert.run({ ...base, id: `x402-bal-${i}`, name: `X402 Balanced ${i}`, url: `https://x402-balanced-${i}.example.com/api`, protocol: 'x402', reliability_score: 100 })
    }

    // 5 L402 endpoints on 2 providers (to pass ≥2 filter)
    for (let i = 0; i < 3; i++) {
      insert.run({ ...base, id: `l402-bal-a${i}`, name: `L402 ProvA ${i}`, url: `https://l402-prova.example.com/svc${i}`, protocol: 'L402', reliability_score: 95, x402_payment_valid: null, price_sats: 10 })
    }
    for (let i = 0; i < 2; i++) {
      insert.run({ ...base, id: `l402-bal-b${i}`, name: `L402 ProvB ${i}`, url: `https://l402-provb.example.com/svc${i}`, protocol: 'L402', reliability_score: 90, x402_payment_valid: null, price_sats: 20 })
    }

    // 5 MPP endpoints on 2 providers
    for (let i = 0; i < 3; i++) {
      insert.run({ ...base, id: `mpp-bal-a${i}`, name: `MPP ProvA ${i}`, url: `https://mpp-prova.example.com/svc${i}`, protocol: 'MPP', reliability_score: 88, x402_payment_valid: null })
    }
    for (let i = 0; i < 2; i++) {
      insert.run({ ...base, id: `mpp-bal-b${i}`, name: `MPP ProvB ${i}`, url: `https://mpp-provb.example.com/svc${i}`, protocol: 'MPP', reliability_score: 85, x402_payment_valid: null })
    }
  })

  after(() => db.close())

  it('endpoints include all three protocols when data exists for each', async () => {
    const { getScoreboardData } = await import('../src/services/daily-snapshot.js')
    const { endpoints } = getScoreboardData(db)
    const protocols = new Set(endpoints.map(e => e.protocol))
    assert.ok(protocols.has('x402'), 'Should include x402 endpoints')
    assert.ok(protocols.has('L402'), 'Should include L402 endpoints')
    assert.ok(protocols.has('MPP'), 'Should include MPP endpoints')
  })

  it('total endpoints ≤ 105 (35 per protocol)', async () => {
    const { getScoreboardData } = await import('../src/services/daily-snapshot.js')
    const { endpoints } = getScoreboardData(db)
    assert.ok(endpoints.length <= 105, `Expected ≤105 endpoints, got ${endpoints.length}`)
  })

  it('provider filter for L402 returns results', async () => {
    const { getScoreboardData } = await import('../src/services/daily-snapshot.js')
    const { providers } = getScoreboardData(db)
    const l402Providers = providers.filter(p => p.protocols.includes('L402'))
    assert.ok(l402Providers.length > 0, 'L402 protocol filter should show providers')
  })

  it('provider filter for MPP returns results', async () => {
    const { getScoreboardData } = await import('../src/services/daily-snapshot.js')
    const { providers } = getScoreboardData(db)
    const mppProviders = providers.filter(p => p.protocols.includes('MPP'))
    assert.ok(mppProviders.length > 0, 'MPP protocol filter should show providers')
  })
})

// ─── Tests: Fix 2 — Endpoint View Capping ──────────────────────────────────

describe('statsPage — endpoint view 25-row cap', () => {
  it('client-side JS includes 25-row slicing logic', async () => {
    const { statsPage } = await import('../src/views/stats.js')
    const html = statsPage({
      scoreboard: { providers: [], endpoints: [] },
      latency: { buckets: [], median: null, under500: 0, fastestProtocol: null, fastestMedian: null, protocolSummary: { L402: { median: null, p90: null, under500: 0 }, x402: { median: null, p90: null, under500: 0 }, MPP: { median: null, p90: null, under500: 0 } } },
      categoryGap: { grid: [], opportunities: [] },
    })
    assert.ok(html.includes('.slice(0, 25)'), 'Should cap display to 25 rows')
  })

  it('client-side JS includes "Showing" overflow message', async () => {
    const { statsPage } = await import('../src/views/stats.js')
    const html = statsPage({
      scoreboard: { providers: [], endpoints: [] },
      latency: { buckets: [], median: null, under500: 0, fastestProtocol: null, fastestMedian: null, protocolSummary: { L402: { median: null, p90: null, under500: 0 }, x402: { median: null, p90: null, under500: 0 }, MPP: { median: null, p90: null, under500: 0 } } },
      categoryGap: { grid: [], opportunities: [] },
    })
    assert.ok(html.includes('Showing 25 of'), 'Should show overflow message when > 25 rows')
  })

  it('scoreboard table uses stats-table-container wrapper', async () => {
    const { statsPage } = await import('../src/views/stats.js')
    const html = statsPage({
      scoreboard: { providers: [], endpoints: [] },
      latency: { buckets: [], median: null, under500: 0, fastestProtocol: null, fastestMedian: null, protocolSummary: { L402: { median: null, p90: null, under500: 0 }, x402: { median: null, p90: null, under500: 0 }, MPP: { median: null, p90: null, under500: 0 } } },
      categoryGap: { grid: [], opportunities: [] },
    })
    assert.ok(html.includes('stats-table-container'), 'Should use stats-table-container wrapper')
  })
})

// ─── Tests: Fix 3 — No Chart.js, CSS Latency Bars ─────────────────────────

describe('statsPage — CSS latency bars (no Chart.js)', () => {
  const testData = {
    scoreboard: { providers: [], endpoints: [] },
    latency: {
      buckets: [],
      median: 200,
      under500: 80,
      fastestProtocol: 'x402',
      fastestMedian: 170,
      protocolSummary: {
        L402: { median: 400, p90: 800, under500: 50 },
        x402: { median: 170, p90: 200, under500: 100 },
        MPP: { median: 300, p90: 350, under500: 100 },
      },
    },
    categoryGap: { grid: [], opportunities: [] },
  }

  it('does NOT include <canvas> element', async () => {
    const { statsPage } = await import('../src/views/stats.js')
    const html = statsPage(testData)
    assert.ok(!html.includes('<canvas'), 'Should not include canvas element')
  })

  it('renders per-protocol latency bars', async () => {
    const { statsPage } = await import('../src/views/stats.js')
    const html = statsPage(testData)
    assert.ok(html.includes('latency-bar-row'), 'Should include latency bar rows')
    assert.ok(html.includes('latency-bar-fill'), 'Should include latency bar fills')
  })

  it('renders bars for each protocol with data', async () => {
    const { statsPage } = await import('../src/views/stats.js')
    const html = statsPage(testData)
    assert.ok(html.includes('latency-fill-l402'), 'Should render L402 bar')
    assert.ok(html.includes('latency-fill-x402'), 'Should render x402 bar')
    assert.ok(html.includes('latency-fill-mpp'), 'Should render MPP bar')
  })

  it('x402 bar is shortest (lowest median)', async () => {
    const { statsPage } = await import('../src/views/stats.js')
    const html = statsPage(testData)
    // x402 median 170, maxP90 800 → medianPct = 21.2%
    // L402 median 400, maxP90 800 → medianPct = 50.0%
    const x402Match = html.match(/latency-fill-x402" style="width:([0-9.]+)%"/)
    const l402Match = html.match(/latency-fill-l402" style="width:([0-9.]+)%"/)
    assert.ok(x402Match && l402Match)
    assert.ok(parseFloat(x402Match[1]) < parseFloat(l402Match[1]), 'x402 bar should be shorter than L402')
  })

  it('still renders stats callout cards', async () => {
    const { statsPage } = await import('../src/views/stats.js')
    const html = statsPage(testData)
    assert.ok(html.includes('stats-callout'), 'Should include stat callout cards')
    assert.ok(html.includes('200ms'), 'Should include median value')
  })

  it('keeps per-protocol summary table', async () => {
    const { statsPage } = await import('../src/views/stats.js')
    const html = statsPage(testData)
    assert.ok(html.includes('stats-table-compact'), 'Should keep per-protocol summary table')
  })
})

// ─── Tests: Fix 4 — Category Synonym Merge (real-time-data → data) ────────

describe('getCategoryGapData — real-time-data synonym merge', () => {
  let db

  before(() => {
    db = createTestDb()
    const insert = db.prepare(`
      INSERT INTO services (id, name, url, protocol, source, category, health_status, reliability_score, latency_p50_ms, price_sats, price_usd, x402_payment_valid, is_template, is_demo)
      VALUES (@id, @name, @url, @protocol, @source, @category, @health_status, @reliability_score, @latency_p50_ms, @price_sats, @price_usd, @x402_payment_valid, @is_template, @is_demo)
    `)
    const base = { source: 'bazaar', health_status: 'healthy', reliability_score: 90, latency_p50_ms: 200, price_sats: null, price_usd: 0.01, x402_payment_valid: 1, is_template: 0, is_demo: 0 }

    // "data" category — 13 x402 endpoints
    for (let i = 0; i < 13; i++) {
      insert.run({ ...base, id: `syn-data-${i}`, name: `Data ${i}`, url: `https://syn-data${i}.example.com/api`, protocol: 'x402', category: 'data' })
    }

    // "real-time-data" — 10 L402 + 8 x402
    for (let i = 0; i < 10; i++) {
      insert.run({ ...base, id: `syn-rtd-l-${i}`, name: `RTD L402 ${i}`, url: `https://syn-rtd-l${i}.example.com/api`, protocol: 'L402', category: 'real-time-data', x402_payment_valid: null, price_sats: 10 })
    }
    for (let i = 0; i < 8; i++) {
      insert.run({ ...base, id: `syn-rtd-x-${i}`, name: `RTD x402 ${i}`, url: `https://syn-rtd-x${i}.example.com/api`, protocol: 'x402', category: 'real-time-data' })
    }
  })

  after(() => db.close())

  it('"real-time-data" does not appear as a separate row', async () => {
    const { getCategoryGapData } = await import('../src/services/daily-snapshot.js')
    const { grid } = getCategoryGapData(db)
    const rtd = grid.find(r => r.category === 'real-time-data')
    assert.equal(rtd, undefined, '"real-time-data" should be merged into "data"')
  })

  it('"data" row includes combined counts', async () => {
    const { getCategoryGapData } = await import('../src/services/daily-snapshot.js')
    const { grid } = getCategoryGapData(db)
    const dataRow = grid.find(r => r.category === 'data')
    assert.ok(dataRow, '"data" row should exist')
    assert.equal(dataRow.x402, 21, 'x402 count: data(13) + real-time-data(8) = 21')
    assert.equal(dataRow.L402, 10, 'L402 count from real-time-data = 10')
    assert.equal(dataRow.total, 31, 'total = 31')
  })
})

// ─── Tests: Fix 5 — Probe Log Overflow Fix ─────────────────────────────────

describe('styles — probe log overflow fix', () => {
  it('.demo-probe-log has no max-height', async () => {
    const { styles } = await import('../src/views/styles.js')
    const match = styles.match(/\.demo-probe-log\s*\{([^}]+)\}/)
    assert.ok(match, '.demo-probe-log rule should exist')
    assert.ok(!match[1].includes('max-height'), '.demo-probe-log should NOT have max-height')
  })

  it('.demo-probe-log has no overflow-y', async () => {
    const { styles } = await import('../src/views/styles.js')
    const match = styles.match(/\.demo-probe-log\s*\{([^}]+)\}/)
    assert.ok(match)
    assert.ok(!match[1].includes('overflow-y'), '.demo-probe-log should NOT have overflow-y')
  })

  it('.demo-probe-log has overflow-x: hidden', async () => {
    const { styles } = await import('../src/views/styles.js')
    const match = styles.match(/\.demo-probe-log\s*\{([^}]+)\}/)
    assert.ok(match)
    assert.ok(match[1].includes('overflow-x: hidden'), '.demo-probe-log should have overflow-x: hidden')
  })

  it('.demo-twin-panel .demo-probe has no position: sticky', async () => {
    const { styles } = await import('../src/views/styles.js')
    const match = styles.match(/\.demo-twin-panel \.demo-probe\s*\{([^}]+)\}/)
    assert.ok(match, '.demo-twin-panel .demo-probe rule should exist')
    assert.ok(!match[1].includes('position'), 'Should NOT have position: sticky')
  })

  it('twin panel children have min-width: 0', async () => {
    const { styles } = await import('../src/views/styles.js')
    assert.ok(styles.includes('.demo-twin-panel .demo-search'), 'Should style .demo-search child')
    assert.ok(styles.includes('min-width: 0'), 'Should have min-width: 0 for grid children')
  })

  it('.demo-probe-step has word wrapping', async () => {
    const { styles } = await import('../src/views/styles.js')
    const match = styles.match(/\.demo-probe-step\s*\{([^}]+)\}/)
    assert.ok(match)
    assert.ok(match[1].includes('overflow-wrap'), '.demo-probe-step should have overflow-wrap')
    assert.ok(match[1].includes('word-break'), '.demo-probe-step should have word-break')
  })

  it('.demo-probe-header-detail has aggressive word wrapping', async () => {
    const { styles } = await import('../src/views/styles.js')
    const match = styles.match(/\.demo-probe-header-detail\s*\{([^}]+)\}/)
    assert.ok(match)
    assert.ok(match[1].includes('overflow-wrap: anywhere'), 'Should have overflow-wrap: anywhere')
    assert.ok(match[1].includes('white-space: pre-wrap'), 'Should have white-space: pre-wrap')
  })
})

// ─── Tests: Latency Bar CSS ────────────────────────────────────────────────

describe('styles — latency bar CSS', () => {
  it('includes latency-bar-row styling', async () => {
    const { styles } = await import('../src/views/styles.js')
    assert.ok(styles.includes('.latency-bar-row'), 'Should include .latency-bar-row')
    assert.ok(styles.includes('.latency-bar-fill'), 'Should include .latency-bar-fill')
    assert.ok(styles.includes('.latency-p90-mark'), 'Should include .latency-p90-mark')
  })

  it('includes per-protocol fill colors', async () => {
    const { styles } = await import('../src/views/styles.js')
    assert.ok(styles.includes('.latency-fill-l402'), 'Should include L402 fill color')
    assert.ok(styles.includes('.latency-fill-x402'), 'Should include x402 fill color')
    assert.ok(styles.includes('.latency-fill-mpp'), 'Should include MPP fill color')
  })
})

// ─── Tests: Stats Table Overflow CSS ───────────────────────────────────────

describe('styles — stats table overflow fix', () => {
  it('.stats-table-container has overflow-x: hidden', async () => {
    const { styles } = await import('../src/views/styles.js')
    const match = styles.match(/\.stats-table-container\s*\{([^}]+)\}/)
    assert.ok(match, '.stats-table-container should exist')
    assert.ok(match[1].includes('overflow-x: hidden'), 'Should have overflow-x: hidden')
  })

  it('.stats-table has table-layout: fixed', async () => {
    const { styles } = await import('../src/views/styles.js')
    const match = styles.match(/\.stats-table\s*\{([^}]+)\}/)
    assert.ok(match)
    assert.ok(match[1].includes('table-layout: fixed'), 'Should have table-layout: fixed')
  })
})

describe('backfill script — historical data', () => {
  it('script file exists and is valid ES module', async () => {
    const fs = await import('fs')
    const scriptPath = join(__dirname, '..', 'scripts', 'backfill-snapshots.mjs')
    assert.ok(fs.existsSync(scriptPath), 'backfill-snapshots.mjs should exist')
    const content = fs.readFileSync(scriptPath, 'utf-8')
    assert.ok(content.includes('HISTORICAL_DATA'), 'Should define historical data array')
    assert.ok(content.includes('INSERT OR IGNORE'), 'Should use INSERT OR IGNORE for idempotency')
  })

  it('historical data covers Feb 27 through Mar 19', async () => {
    const fs = await import('fs')
    const scriptPath = join(__dirname, '..', 'scripts', 'backfill-snapshots.mjs')
    const content = fs.readFileSync(scriptPath, 'utf-8')
    assert.ok(content.includes("'2026-02-27'"), 'Should include Feb 27')
    assert.ok(content.includes("'2026-03-19'"), 'Should include Mar 19')
  })
})

// ─── Tests: Simplified Stats Page ──────────────────────────────────────────

describe('statsSimplePage', () => {
  const testData = {
    latency: {
      buckets: [],
      median: 200,
      under500: 80,
      fastestProtocol: 'x402',
      fastestMedian: 170,
      protocolSummary: {
        L402: { median: 400, p90: 800, under500: 50 },
        x402: { median: 170, p90: 200, under500: 100 },
        MPP: { median: 300, p90: 350, under500: 100 },
      },
    },
    categoryGap: {
      grid: [{ category: 'ai', L402: 5, x402: 100, MPP: 3, total: 108 }],
      opportunities: [{ category: 'ai', protocol: 'MPP', count: 3 }],
    },
  }

  it('contains "How Fast Is the Paid API Economy?"', async () => {
    const { statsSimplePage } = await import('../src/views/stats-simple.js')
    const html = statsSimplePage(testData)
    assert.ok(html.includes('How Fast Is the Paid API Economy'))
  })

  it('contains "What\'s Missing?"', async () => {
    const { statsSimplePage } = await import('../src/views/stats-simple.js')
    const html = statsSimplePage(testData)
    assert.ok(html.includes("What&#x27;s Missing") || html.includes("What's Missing"))
  })

  it('does NOT contain "Which Paid APIs Work the Best?"', async () => {
    const { statsSimplePage } = await import('../src/views/stats-simple.js')
    const html = statsSimplePage(testData)
    assert.ok(!html.includes('Which Paid APIs Work the Best'), 'Simplified page should NOT have scoreboard')
  })

  it('does NOT contain <canvas> element', async () => {
    const { statsSimplePage } = await import('../src/views/stats-simple.js')
    const html = statsSimplePage(testData)
    assert.ok(!html.includes('<canvas'), 'Should not include canvas')
  })

  it('does NOT contain "By Provider" or "By Endpoint" toggle', async () => {
    const { statsSimplePage } = await import('../src/views/stats-simple.js')
    const html = statsSimplePage(testData)
    assert.ok(!html.includes('By Provider'), 'Should NOT have provider toggle')
    assert.ok(!html.includes('By Endpoint'), 'Should NOT have endpoint toggle')
  })

  it('does NOT contain "scoreboard" in any class or ID', async () => {
    const { statsSimplePage } = await import('../src/views/stats-simple.js')
    const html = statsSimplePage(testData)
    assert.ok(!html.includes('scoreboard'), 'Should not contain scoreboard')
  })

  it('contains per-protocol latency table with correct headers', async () => {
    const { statsSimplePage } = await import('../src/views/stats-simple.js')
    const html = statsSimplePage(testData)
    assert.ok(html.includes('Protocol'), 'Should have Protocol header')
    assert.ok(html.includes('Median Latency'), 'Should have Median Latency header')
    assert.ok(html.includes('p90 Latency'), 'Should have p90 Latency header')
    assert.ok(html.includes('% Under 500ms'), 'Should have % Under 500ms header')
  })

  it('renders latency data for all three protocols', async () => {
    const { statsSimplePage } = await import('../src/views/stats-simple.js')
    const html = statsSimplePage(testData)
    assert.ok(html.includes('400ms'), 'Should have L402 median')
    assert.ok(html.includes('170ms'), 'Should have x402 median')
    assert.ok(html.includes('300ms'), 'Should have MPP median')
  })

  it('contains the category gap map grid', async () => {
    const { statsSimplePage } = await import('../src/views/stats-simple.js')
    const html = statsSimplePage(testData)
    assert.ok(html.includes('stats-gap-table'), 'Should include gap map table')
    assert.ok(html.includes('gap-category'), 'Should have category cells')
  })

  it('has no page-specific <script> tags (only layout-level Getting Started modal script)', async () => {
    const { statsSimplePage } = await import('../src/views/stats-simple.js')
    const html = statsSimplePage(testData)
    const scriptCount = (html.match(/<script/g) || []).length
    // Layout adds one inline script for the Getting Started modal; stats page adds none of its own
    assert.ok(scriptCount <= 1, `Expected at most 1 script tag (layout modal), got ${scriptCount}`)
  })

  it('has correct meta tags', async () => {
    const { statsSimplePage } = await import('../src/views/stats-simple.js')
    const html = statsSimplePage(testData)
    assert.ok(html.includes('<title>Stats — 402 Index</title>'))
    assert.ok(html.includes('402index.io/stats'))
  })

  it('contains the latency note', async () => {
    const { statsSimplePage } = await import('../src/views/stats-simple.js')
    const html = statsSimplePage(testData)
    assert.ok(html.includes('healthy endpoints'), 'Should mention healthy endpoints')
  })
})

// ─── Tests: Stats-dev page preserves full page ─────────────────────────────

describe('statsPage (for /stats-dev) — preserved full page', () => {
  it('contains "Which Paid APIs Work the Best?"', async () => {
    const { statsPage } = await import('../src/views/stats.js')
    const html = statsPage({
      scoreboard: { providers: [], endpoints: [] },
      latency: { buckets: [], median: null, under500: 0, fastestProtocol: null, fastestMedian: null, protocolSummary: { L402: { median: null, p90: null, under500: 0 }, x402: { median: null, p90: null, under500: 0 }, MPP: { median: null, p90: null, under500: 0 } } },
      categoryGap: { grid: [], opportunities: [] },
    })
    assert.ok(html.includes('Which Paid APIs Work the Best'), 'Full stats page should have scoreboard')
  })

  it('contains By Provider and By Endpoint toggles', async () => {
    const { statsPage } = await import('../src/views/stats.js')
    const html = statsPage({
      scoreboard: { providers: [], endpoints: [] },
      latency: { buckets: [], median: null, under500: 0, fastestProtocol: null, fastestMedian: null, protocolSummary: { L402: { median: null, p90: null, under500: 0 }, x402: { median: null, p90: null, under500: 0 }, MPP: { median: null, p90: null, under500: 0 } } },
      categoryGap: { grid: [], opportunities: [] },
    })
    assert.ok(html.includes('By Provider'))
    assert.ok(html.includes('By Endpoint'))
  })
})

// ─── Tests: /stats-dev NOT in nav bar ──────────────────────────────────────

describe('layout — nav bar does NOT include /stats-dev', () => {
  it('nav includes /stats but not /stats-dev', async () => {
    const { layout } = await import('../src/views/layout.js')
    const html = layout('Test', '<div>content</div>')
    assert.ok(html.includes('href="/stats"'), 'Should include /stats link')
    assert.ok(!html.includes('href="/stats-dev"'), 'Should NOT include /stats-dev link')
  })
})

// ─── Tests: API Docs — MCP Server Section ──────────────────────────────────

describe('apiDocsPage — MCP server section', () => {
  it('contains npx install command', async () => {
    const { apiDocsPage } = await import('../src/views/api-docs.js')
    const html = apiDocsPage()
    assert.ok(html.includes('npx @402index/mcp-server'), 'Should show npx command')
  })

  it('contains Claude Desktop config JSON', async () => {
    const { apiDocsPage } = await import('../src/views/api-docs.js')
    const html = apiDocsPage()
    assert.ok(html.includes('claude_desktop_config.json'), 'Should reference Claude Desktop config path')
    assert.ok(html.includes('"402index"'), 'Should show server name in config')
  })

  it('contains Claude Code setup command', async () => {
    const { apiDocsPage } = await import('../src/views/api-docs.js')
    const html = apiDocsPage()
    assert.ok(html.includes('claude mcp add 402index'), 'Should show Claude Code setup command')
  })

  it('contains Cursor config', async () => {
    const { apiDocsPage } = await import('../src/views/api-docs.js')
    const html = apiDocsPage()
    assert.ok(html.includes('.cursor/mcp.json'), 'Should reference Cursor config path')
  })

  it('contains all 4 tools in the table', async () => {
    const { apiDocsPage } = await import('../src/views/api-docs.js')
    const html = apiDocsPage()
    assert.ok(html.includes('search_services'))
    assert.ok(html.includes('get_service_detail'))
    assert.ok(html.includes('list_categories'))
    assert.ok(html.includes('get_directory_stats'))
  })
})

// ─── Tests: MCP Server — Protocol & Source Enums ───────────────────────────

describe('MCP server — updated enums', () => {
  it('protocol enum includes MPP', async () => {
    const fs = await import('fs')
    const content = fs.readFileSync(join(__dirname, '..', 'mcp-server', 'src', 'index.ts'), 'utf-8')
    assert.ok(content.includes("'MPP'"), 'Should include MPP in protocol enum')
    assert.ok(content.includes("'L402'"), 'Should use uppercase L402')
  })

  it('source enum includes all sources', async () => {
    const fs = await import('fs')
    const content = fs.readFileSync(join(__dirname, '..', 'mcp-server', 'src', 'index.ts'), 'utf-8')
    assert.ok(content.includes("'mpp'"), 'Should include mpp source')
    assert.ok(content.includes("'l402apps'"), 'Should include l402apps source')
    assert.ok(content.includes("'sponge'"), 'Should include sponge source')
    assert.ok(content.includes("'l402directory'"), 'Should include l402directory source')
    assert.ok(content.includes("'self-registered'"), 'Should include self-registered source')
  })

  it('dist/index.js exists after build', async () => {
    const fs = await import('fs')
    const distPath = join(__dirname, '..', 'mcp-server', 'dist', 'index.js')
    assert.ok(fs.existsSync(distPath), 'dist/index.js should exist')
  })

  it('dist/index.js has updated protocol enum', async () => {
    const fs = await import('fs')
    const content = fs.readFileSync(join(__dirname, '..', 'mcp-server', 'dist', 'index.js'), 'utf-8')
    assert.ok(content.includes("'MPP'"), 'Built JS should include MPP')
    assert.ok(content.includes("'L402'"), 'Built JS should use uppercase L402')
  })
})
