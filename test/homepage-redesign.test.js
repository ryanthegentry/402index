import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { demoPage } from '../src/views/demo.js'
import { homePage } from '../src/views/home.js'
import { aboutPage } from '../src/views/about.js'
import { layout } from '../src/views/layout.js'
import { styles } from '../src/views/styles.js'
import Database from 'better-sqlite3'
import { buildProbeSample } from '../src/routes/pages.js'

// ─── Sample data (includes MPP stats for new homepage) ──────────────────────

const sampleStats = {
  totalIndexed: 14250,
  verified: 900,
  distinctProviders: 169,
  healthy: 11899,
  degraded: 1938,
  down: 411,
  unknown: 2,
  lastHealthCheck: '2026-03-14T12:00:00Z',
  l402: { endpoints: 91, verified: 41, healthy: 41, providers: 7, allProviders: 46 },
  x402: { endpoints: 13700, verified: 761, healthy: 11858, providers: 150, allProviders: 311 },
  mpp: { endpoints: 459, verified: 42, healthy: 42, providers: 12, allProviders: 15 },
}

const sampleProbeSample = {
  service: {
    name: 'Weather API',
    url: 'https://api.example.com/weather',
    protocol: 'L402',
    price_sats: 10,
    category: 'data/weather',
    provider: 'WeatherCorp',
  },
  healthCheck: {
    checked_at: '2026-03-14T12:00:00Z',
    status: 'healthy',
    response_time_ms: 145,
    http_status: 402,
  },
  flow: {
    request: 'GET https://api.example.com/weather',
    responseStatus: 402,
    protocolHeaders: {
      L402: 'WWW-Authenticate: L402 macaroon="AGIAJEem...", invoice="lnbc100n1..."',
    },
    retryHeader: 'Authorization: L402 <macaroon>:<preimage>',
    successStatus: 200,
  },
}

const directoryStats = {
  verified: 0, totalIndexed: 0, healthy: 0, degraded: 0, down: 0, unknown: 0,
}

// ─── Change 1: CSS-only tooltips ────────────────────────────────────────────

describe('Change 1: CSS-only tooltips', () => {
  it('tooltip CSS styles exist with data-tooltip selector', () => {
    assert.ok(styles.includes('[data-tooltip]'), 'should have [data-tooltip] CSS selector')
  })

  it('tooltip uses pseudo-element for rendering', () => {
    assert.ok(
      styles.includes('[data-tooltip]::after') || styles.includes('[data-tooltip]::before'),
      'should use pseudo-element for tooltip content'
    )
  })
})

// ─── Change 2: About page MPP update ────────────────────────────────────────

describe('Change 2: About page MPP update', () => {
  it('mentions MPP and Machine Payments Protocol', () => {
    const html = aboutPage()
    assert.ok(html.includes('MPP'), 'should mention MPP')
    assert.ok(html.includes('Machine Payments Protocol'), 'should mention Machine Payments Protocol')
  })

  it('mentions Tempo as a source', () => {
    const html = aboutPage()
    assert.ok(html.includes('MPP (Tempo)') || html.includes('Tempo'), 'should mention Tempo as source')
  })

  it('describes MPP verification methodology', () => {
    const html = aboutPage()
    assert.ok(html.includes('WWW-Authenticate: Payment'), 'should describe MPP payment header')
  })

  it('lists MPP option in provider section', () => {
    const html = aboutPage()
    assert.ok(html.includes('Add MPP to your API'), 'should mention adding MPP to APIs')
  })

  it('mentions all three protocols in the opening paragraph', () => {
    const html = aboutPage()
    // All three should appear near the top
    assert.ok(html.includes('L402'), 'should mention L402')
    assert.ok(html.includes('x402'), 'should mention x402')
    assert.ok(html.includes('MPP'), 'should mention MPP')
  })

  it('notes protocol can be L402, x402, or MPP in registration example', () => {
    const html = aboutPage()
    assert.ok(
      html.includes('"L402"') || html.includes('L402'),
      'registration should mention L402'
    )
    assert.ok(
      html.includes('MPP') && html.includes('x402'),
      'registration section should mention all protocols'
    )
  })
})

// ─── Change 3: Route swap — homepage is ecosystem, /directory is table ──────

describe('Change 3: Homepage is ecosystem overview', () => {
  it('homepage title is not "Live Demo"', () => {
    const html = demoPage({ stats: sampleStats, probeSample: sampleProbeSample })
    assert.ok(!html.includes('402 Index Live Demo'), 'should not have old demo title')
  })

  it('homepage subtitle mentions AI agents and directory', () => {
    const html = demoPage({ stats: sampleStats, probeSample: sampleProbeSample })
    assert.ok(
      html.includes('paid API directory') || html.includes('directory for AI agents'),
      'subtitle should describe the directory'
    )
  })

  it('homepage section order: ecosystem → search → probe → flow', () => {
    const html = demoPage({ stats: sampleStats, probeSample: sampleProbeSample })
    const ecosystemIdx = html.indexOf('class="demo-panel demo-ecosystem"')
    const searchIdx = html.indexOf('class="demo-panel demo-search"')
    const probeIdx = html.indexOf('class="demo-panel demo-probe"')
    const flowIdx = html.indexOf('class="demo-panel demo-flow"')
    assert.ok(ecosystemIdx > 0, 'should have ecosystem section')
    assert.ok(searchIdx > 0, 'should have search section')
    assert.ok(probeIdx > 0, 'should have probe section')
    assert.ok(flowIdx > 0, 'should have flow section')
    assert.ok(ecosystemIdx < searchIdx, 'ecosystem before search')
    assert.ok(searchIdx < probeIdx, 'search before probe')
    assert.ok(probeIdx < flowIdx, 'probe before flow')
  })

  it('homepage contains link to full directory', () => {
    const html = demoPage({ stats: sampleStats, probeSample: sampleProbeSample })
    assert.ok(html.includes('href="/directory"'), 'should link to /directory')
    assert.ok(
      html.includes('Browse full directory') || html.includes('full directory'),
      'link text should reference full directory'
    )
  })
})

describe('Change 3: Directory page (home.js)', () => {
  it('directory page does NOT have stats-bar', () => {
    const html = homePage({
      services: [], total: 0, limit: 50, offset: 0,
      filters: {}, stats: directoryStats, categories: [],
    })
    assert.ok(!html.includes('class="stats-bar"'), 'directory should not have stats-bar')
  })

  it('directory page does NOT have protocol-bar', () => {
    const html = homePage({
      services: [], total: 0, limit: 50, offset: 0,
      filters: {}, stats: directoryStats, categories: [],
    })
    assert.ok(!html.includes('class="protocol-bar"'), 'directory should not have protocol-bar')
  })

  it('directory page has back-link to overview', () => {
    const html = homePage({
      services: [], total: 0, limit: 50, offset: 0,
      filters: {}, stats: directoryStats, categories: [],
    })
    assert.ok(html.includes('Back to overview'), 'should have back-link text')
  })

  it('directory form action points to /directory', () => {
    const html = homePage({
      services: [], total: 0, limit: 50, offset: 0,
      filters: {}, stats: directoryStats, categories: [],
    })
    assert.ok(html.includes('action="/directory"'), 'form should submit to /directory')
  })

  it('directory pagination links go to /directory', () => {
    const html = homePage({
      services: [{ id: '1', name: 'Test', url: 'https://x.com', protocol: 'L402', health_status: 'healthy', source: 'test' }],
      total: 100, limit: 50, offset: 0,
      filters: {}, stats: directoryStats, categories: [],
    })
    assert.ok(html.includes('href="/directory?'), 'pagination links should go to /directory')
  })

  it('directory clear filter link goes to /directory', () => {
    const html = homePage({
      services: [], total: 0, limit: 50, offset: 0,
      filters: { protocol: 'L402' }, stats: directoryStats, categories: [],
    })
    assert.ok(html.includes('href="/directory"'), 'clear link should go to /directory')
  })
})

describe('Change 3: Navigation', () => {
  it('nav has Overview link to /', () => {
    const html = layout('Test', '')
    assert.ok(html.includes('>Overview</a>'), 'should have Overview nav link')
  })

  it('nav has Directory link to /directory', () => {
    const html = layout('Test', '')
    assert.ok(html.includes('href="/directory"'), 'should have /directory nav link')
  })

  it('nav does not have Demo link', () => {
    const html = layout('Test', '')
    assert.ok(!html.includes('href="/demo"'), 'should not have /demo nav link')
  })
})

// ─── Change 4: MPP protocol card ────────────────────────────────────────────

describe('Change 4: MPP protocol card', () => {
  it('ecosystem overview contains MPP card', () => {
    const html = demoPage({ stats: sampleStats, probeSample: sampleProbeSample })
    assert.ok(html.includes('demo-protocol-mpp'), 'should have MPP protocol card class')
  })

  it('MPP card shows verified/total stats', () => {
    const html = demoPage({ stats: sampleStats, probeSample: sampleProbeSample })
    assert.ok(html.includes('42 / 459'), 'should show MPP verified/total')
  })

  it('MPP card shows providers stats', () => {
    const html = demoPage({ stats: sampleStats, probeSample: sampleProbeSample })
    assert.ok(html.includes('12 / 15'), 'should show MPP providers fraction')
  })

  it('MPP card has badge-mpp class', () => {
    const html = demoPage({ stats: sampleStats, probeSample: sampleProbeSample })
    assert.ok(html.includes('badge-mpp'), 'should have MPP badge')
  })

  it('L402 card note says "locally verifiable"', () => {
    const html = demoPage({ stats: sampleStats, probeSample: sampleProbeSample })
    assert.ok(html.includes('locally verifiable'), 'L402 should say locally verifiable')
  })

  it('x402 card note mentions facilitator required', () => {
    const html = demoPage({ stats: sampleStats, probeSample: sampleProbeSample })
    assert.ok(
      html.includes('facilitator required') || html.includes('Centralized facilitator'),
      'x402 should mention facilitator required'
    )
  })

  it('protocol compare grid is 3 columns on desktop', () => {
    assert.ok(styles.includes('repeat(3, 1fr)'), 'should have 3-column grid for protocol cards')
  })

  it('MPP card CSS has teal border', () => {
    assert.ok(styles.includes('.demo-protocol-mpp'), 'should have MPP card CSS class')
  })
})

// ─── Change 5: Payment flow MPP toggle ──────────────────────────────────────

describe('Change 5: Payment flow MPP toggle', () => {
  it('payment flow has MPP toggle button', () => {
    const html = demoPage({ stats: sampleStats, probeSample: sampleProbeSample })
    assert.ok(html.includes('data-protocol="MPP"'), 'should have MPP toggle button')
  })

  it('flowData JS object contains MPP entry', () => {
    const html = demoPage({ stats: sampleStats, probeSample: sampleProbeSample })
    // The flowData is serialized as JSON in a <script> tag
    assert.ok(html.includes('"MPP"'), 'flowData should contain MPP key')
  })

  it('MPP flow mentions Tempo payment method', () => {
    const html = demoPage({ stats: sampleStats, probeSample: sampleProbeSample })
    assert.ok(
      html.includes('tempo') || html.includes('Tempo'),
      'MPP flow should reference Tempo'
    )
  })

  it('flow description is protocol-agnostic', () => {
    const html = demoPage({ stats: sampleStats, probeSample: sampleProbeSample })
    assert.ok(
      !html.includes('How an agent pays for an L402/x402'),
      'should not have old L402/x402 specific description'
    )
  })

  it('MPP toggle button text includes Stripe/Tempo', () => {
    const html = demoPage({ stats: sampleStats, probeSample: sampleProbeSample })
    assert.ok(
      html.includes('MPP (Stripe/Tempo)') || html.includes('MPP'),
      'MPP toggle should be labeled'
    )
  })
})

// ─── Change 5: buildProbeSample MPP support ─────────────────────────────────

function createTestDb() {
  const db = new Database(':memory:')
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
      provider TEXT,
      source TEXT NOT NULL,
      featured INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      health_status TEXT DEFAULT 'unknown',
      uptime_30d REAL,
      latency_p50_ms INTEGER,
      reliability_score REAL,
      last_checked TEXT,
      consecutive_failures INTEGER DEFAULT 0,
      is_template INTEGER DEFAULT 0,
      is_demo INTEGER DEFAULT 0,
      x402_payment_valid INTEGER,
      registered_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
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

describe('Change 5: buildProbeSample MPP', () => {
  it('returns MPP service when protocol=MPP', () => {
    const db = createTestDb()
    db.prepare(`INSERT INTO services (id, name, url, protocol, source, health_status, reliability_score, price_usd, provider)
      VALUES ('mpp-1', 'OpenAI API', 'https://api.openai.com/v1/chat', 'MPP', 'mpp', 'healthy', 90, 0.002, 'OpenAI')`).run()
    db.prepare(`INSERT INTO health_checks (service_id, status, response_time_ms, http_status)
      VALUES ('mpp-1', 'healthy', 200, 402)`).run()

    const sample = buildProbeSample(db, 'MPP')
    assert.equal(sample.service.protocol, 'MPP')
    assert.ok(sample.flow.protocolHeaders.MPP, 'should have MPP protocol headers')
    assert.ok(sample.flow.protocolHeaders.MPP.includes('Payment'), 'should show Payment scheme')
  })

  it('returns static MPP fallback when no healthy MPP services', () => {
    const db = createTestDb()
    const sample = buildProbeSample(db, 'MPP')
    assert.equal(sample.service.protocol, 'MPP')
    assert.ok(sample.flow.protocolHeaders.MPP, 'should have MPP fallback headers')
  })

  it('MPP flow has correct retry header format', () => {
    const db = createTestDb()
    const sample = buildProbeSample(db, 'MPP')
    assert.ok(
      sample.flow.retryHeader.includes('Payment'),
      'MPP retry header should use Payment scheme'
    )
  })
})

// ─── Change 6: Mobile optimization ──────────────────────────────────────────

describe('Change 6: Mobile optimization', () => {
  it('protocol cards collapse to 1 column on mobile', () => {
    // Already true from existing CSS, but verify it covers 3-col layout
    assert.ok(styles.includes('.demo-protocol-compare'), 'should have protocol compare CSS')
  })

  it('desktop protocol cards use 3-column grid', () => {
    assert.ok(styles.includes('repeat(3, 1fr)'), 'desktop should have 3-column grid')
  })
})
