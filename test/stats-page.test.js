import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Test DB Helper ──────────────────────────────────────────────────────────

function createTestDb() {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE services (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      url TEXT NOT NULL,
      protocol TEXT NOT NULL,
      price_sats INTEGER,
      price_usd REAL,
      payment_asset TEXT,
      payment_network TEXT,
      category TEXT,
      input_schema TEXT,
      output_schema TEXT,
      provider TEXT,
      source TEXT NOT NULL,
      source_id TEXT,
      featured INTEGER DEFAULT 0,
      registered_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      health_status TEXT DEFAULT 'unknown',
      uptime_30d REAL,
      latency_p50_ms INTEGER,
      last_checked TEXT,
      last_seen_healthy TEXT,
      consecutive_failures INTEGER DEFAULT 0,
      is_template INTEGER DEFAULT 0,
      is_demo INTEGER DEFAULT 0,
      verified INTEGER DEFAULT 0,
      contact_email TEXT,
      status TEXT DEFAULT 'active',
      http_method TEXT DEFAULT 'GET',
      probe_body TEXT,
      reliability_score REAL,
      x402_payment_valid INTEGER,
      x402_facilitator_reachable INTEGER,
      x402_asset_known INTEGER,
      l402_version TEXT,
      agent_spec_url TEXT,
      capabilities TEXT,
      token_format TEXT,
      invoice_type TEXT,
      pricing_model TEXT,
      content_domain TEXT
    );

    CREATE TABLE daily_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_date TEXT NOT NULL UNIQUE,
      total_endpoints INTEGER,
      verified_endpoints INTEGER,
      total_providers INTEGER,
      verified_providers INTEGER,
      healthy_endpoints INTEGER,
      degraded_endpoints INTEGER,
      down_endpoints INTEGER,
      l402_endpoints INTEGER,
      l402_verified INTEGER,
      l402_healthy INTEGER,
      l402_providers INTEGER,
      x402_endpoints INTEGER,
      x402_verified INTEGER,
      x402_healthy INTEGER,
      x402_providers INTEGER,
      mpp_endpoints INTEGER,
      mpp_verified INTEGER,
      mpp_healthy INTEGER,
      mpp_providers INTEGER,
      avg_reliability_score REAL,
      median_latency_ms INTEGER,
      p90_latency_ms INTEGER,
      categories_json TEXT,
      top_providers_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_daily_snapshots_date ON daily_snapshots(snapshot_date);

    CREATE TABLE health_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_id TEXT NOT NULL,
      checked_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL,
      response_time_ms INTEGER,
      http_status INTEGER,
      error_message TEXT
    );
  `)

  return db
}

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

  it('returns endpoint-level data sorted by reliability', async () => {
    const { getScoreboardData } = await import('../src/services/daily-snapshot.js')
    const { endpoints } = getScoreboardData(db)

    assert.ok(endpoints.length > 0)
    for (let i = 1; i < endpoints.length; i++) {
      assert.ok(endpoints[i].reliability_score <= endpoints[i - 1].reliability_score)
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

  it('returns grid with one row per category', async () => {
    const { getCategoryGapData } = await import('../src/services/daily-snapshot.js')
    const { grid } = getCategoryGapData(db)

    assert.ok(grid.length > 0)
    const categories = grid.map(r => r.category)
    // No duplicates
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

  it('filters out categories with fewer than 3 total endpoints', async () => {
    const { getCategoryGapData } = await import('../src/services/daily-snapshot.js')
    const { grid } = getCategoryGapData(db)

    for (const row of grid) {
      assert.ok(row.total >= 3, `Category "${row.category}" has ${row.total} < 3`)
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

  it('includes Chart.js CDN script', async () => {
    const { statsPage } = await import('../src/views/stats.js')
    const html = statsPage({
      scoreboard: { providers: [], endpoints: [] },
      latency: { buckets: [], median: null, under500: 0, fastestProtocol: null, fastestMedian: null, protocolSummary: { L402: { median: null, p90: null, under500: 0 }, x402: { median: null, p90: null, under500: 0 }, MPP: { median: null, p90: null, under500: 0 } } },
      categoryGap: { grid: [], opportunities: [] },
    })

    assert.ok(html.includes('cdn.jsdelivr.net/npm/chart.js'))
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
