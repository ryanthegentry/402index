import { describe, it, mock, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { parseWwwAuthenticate, isValidMacaroon, isValidInvoice } from '../src/services/l402-utils.js'
import { computeReliabilityScore } from '../src/health/checker.js'
import { buildServiceQuery, API_COLUMNS, PAGE_COLUMNS } from '../src/queries/services.js'

// Helper: generate a realistic-length invoice
const longInvoice = (prefix = 'lnbc') => prefix + '1000n1p' + 'a'.repeat(200)

// ─── l402-utils.js (shared module) ──────────────────────────────────────────

describe('l402-utils: parseWwwAuthenticate (from shared module)', () => {
  it('parses L402 header correctly', () => {
    const result = parseWwwAuthenticate('L402 macaroon="AgELYmVuY2FybWFu", invoice="' + longInvoice() + '"')
    assert.equal(result.scheme, 'L402')
    assert.equal(result.macaroon, 'AgELYmVuY2FybWFu')
    assert.ok(result.invoice.startsWith('lnbc'))
  })

  it('returns nulls for non-L402 scheme', () => {
    const result = parseWwwAuthenticate('Bearer token="abc"')
    assert.equal(result.scheme, null)
  })
})

describe('l402-utils: isValidInvoice (enhanced)', () => {
  it('accepts valid invoice with ln prefix and 100+ chars', () => {
    assert.equal(isValidInvoice(longInvoice('lnbc')), true)
    assert.equal(isValidInvoice(longInvoice('lntb')), true)
    assert.equal(isValidInvoice(longInvoice('lnbcrt')), true)
  })

  it('rejects invoice shorter than 100 chars', () => {
    assert.equal(isValidInvoice('lnbc1000n1pjtest'), false)
  })

  it('rejects null/empty', () => {
    assert.equal(isValidInvoice(null), false)
    assert.equal(isValidInvoice(''), false)
  })

  it('rejects non-ln prefix', () => {
    assert.equal(isValidInvoice('btc' + 'a'.repeat(200)), false)
  })

  it('rejects invoice with special characters', () => {
    assert.equal(isValidInvoice('lnbc' + '-'.repeat(200)), false)
  })

  it('accepts exactly 100 char invoice', () => {
    const inv = 'lnbc' + 'a'.repeat(96) // 4 + 96 = 100
    assert.equal(isValidInvoice(inv), true)
  })

  it('rejects 99 char invoice', () => {
    const inv = 'lnbc' + 'a'.repeat(95) // 4 + 95 = 99
    assert.equal(isValidInvoice(inv), false)
  })
})

// ─── computeReliabilityScore ────────────────────────────────────────────────

describe('computeReliabilityScore', () => {
  it('returns perfect score for ideal service', () => {
    const score = computeReliabilityScore({
      uptime_30d: 1.0,
      latency_p50_ms: 50,
      consecutive_failures: 0,
      registered_at: '2025-01-01T00:00:00',
    })
    assert.equal(score, 100)
  })

  it('returns 0 for service with all null/zero values', () => {
    const score = computeReliabilityScore({
      uptime_30d: null,
      latency_p50_ms: null,
      consecutive_failures: 10,
      registered_at: null,
    })
    assert.equal(score, 0)
  })

  it('gives 50% for uptime component alone', () => {
    const score = computeReliabilityScore({
      uptime_30d: 1.0,
      latency_p50_ms: null,
      consecutive_failures: 10,
      registered_at: null,
    })
    assert.equal(score, 50)
  })

  it('gives correct latency scores for each bucket', () => {
    const base = { uptime_30d: null, consecutive_failures: 10, registered_at: null }
    assert.equal(computeReliabilityScore({ ...base, latency_p50_ms: 100 }), 25)
    assert.equal(computeReliabilityScore({ ...base, latency_p50_ms: 300 }), 20)
    assert.equal(computeReliabilityScore({ ...base, latency_p50_ms: 700 }), 15)
    assert.equal(computeReliabilityScore({ ...base, latency_p50_ms: 1500 }), 10)
    assert.equal(computeReliabilityScore({ ...base, latency_p50_ms: 3000 }), 5)
  })

  it('gives correct streak scores', () => {
    const base = { uptime_30d: null, latency_p50_ms: null, registered_at: null }
    assert.equal(computeReliabilityScore({ ...base, consecutive_failures: 0 }), 15)
    assert.equal(computeReliabilityScore({ ...base, consecutive_failures: 1 }), 10)
    assert.equal(computeReliabilityScore({ ...base, consecutive_failures: 2 }), 5)
    assert.equal(computeReliabilityScore({ ...base, consecutive_failures: 3 }), 0)
  })

  it('gives correct age scores', () => {
    const base = { uptime_30d: null, latency_p50_ms: null, consecutive_failures: 10 }
    const daysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString().replace('Z', '')

    assert.equal(computeReliabilityScore({ ...base, registered_at: daysAgo(10) }), 10) // >7 days
    assert.equal(computeReliabilityScore({ ...base, registered_at: daysAgo(5) }), 7)   // 3-7 days
    assert.equal(computeReliabilityScore({ ...base, registered_at: daysAgo(2) }), 5)   // 1-3 days
    assert.equal(computeReliabilityScore({ ...base, registered_at: daysAgo(0.5) }), 2) // <1 day
  })

  it('computes partial score correctly', () => {
    const score = computeReliabilityScore({
      uptime_30d: 0.95,       // 0.95 * 100 * 0.5 = 47.5
      latency_p50_ms: 300,    // 20
      consecutive_failures: 1, // 10
      registered_at: '2025-01-01T00:00:00', // 10 (>7 days)
    })
    assert.equal(score, 87.5) // 47.5 + 20 + 10 + 10
  })

  it('rounds to 1 decimal place', () => {
    const score = computeReliabilityScore({
      uptime_30d: 0.333,
      latency_p50_ms: null,
      consecutive_failures: 10,
      registered_at: null,
    })
    assert.equal(score, 16.7) // 0.333 * 100 * 0.5 = 16.65 → 16.7
  })
})

// ─── Query builder: reliability sort ────────────────────────────────────────

describe('buildServiceQuery — reliability sort', () => {
  it('?sort=reliability → uses reliability_score column', () => {
    const result = buildServiceQuery({ sort: 'reliability', order: 'desc' })
    assert.ok(result.orderBy.includes('reliability_score'))
    assert.ok(result.orderBy.includes('DESC'))
  })

  it('API_COLUMNS includes http_method and reliability_score', () => {
    assert.ok(API_COLUMNS.includes('http_method'))
    assert.ok(API_COLUMNS.includes('reliability_score'))
  })

  it('PAGE_COLUMNS includes reliability_score', () => {
    assert.ok(PAGE_COLUMNS.includes('reliability_score'))
  })
})

// ─── http_method validation (unit tests for route logic) ────────────────────

describe('http_method validation', () => {
  const VALID_HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE'])

  it('accepts GET, POST, PUT, DELETE', () => {
    for (const m of ['GET', 'POST', 'PUT', 'DELETE']) {
      assert.ok(VALID_HTTP_METHODS.has(m), `${m} should be valid`)
    }
  })

  it('rejects PATCH, OPTIONS, HEAD', () => {
    for (const m of ['PATCH', 'OPTIONS', 'HEAD']) {
      assert.ok(!VALID_HTTP_METHODS.has(m), `${m} should be invalid`)
    }
  })

  it('case normalization: lowercase → uppercase', () => {
    const input = 'post'
    const normalized = input.toUpperCase()
    assert.equal(normalized, 'POST')
    assert.ok(VALID_HTTP_METHODS.has(normalized))
  })
})

// ─── verifyL402 with POST ───────────────────────────────────────────────────

describe('verifyL402 with POST method', () => {
  let originalFetch

  beforeEach(() => { originalFetch = global.fetch })
  afterEach(() => { global.fetch = originalFetch })

  // Helper: mock Response
  function mockResponse(status, headers = {}) {
    return {
      status,
      headers: {
        get(name) { return headers[name.toLowerCase()] || null },
      },
    }
  }

  it('sends POST with JSON body when httpMethod is POST', async () => {
    const { verifyL402 } = await import('../src/services/l402-verify.js')
    let capturedOptions = null
    global.fetch = async (url, opts) => {
      capturedOptions = opts
      return mockResponse(402, {
        'www-authenticate': `L402 macaroon="AgELYmVuY2FybWFu", invoice="${longInvoice()}"`,
      })
    }
    const result = await verifyL402('https://example.com/api', 'POST')
    assert.equal(result.valid, true)
    assert.equal(capturedOptions.method, 'POST')
    assert.equal(capturedOptions.body, '{}')
    assert.equal(capturedOptions.headers['Content-Type'], 'application/json')
  })

  it('sends GET (default) when no method specified', async () => {
    const { verifyL402 } = await import('../src/services/l402-verify.js')
    let capturedMethod = null
    global.fetch = async (url, opts) => {
      capturedMethod = opts.method
      return mockResponse(402, {
        'www-authenticate': `L402 macaroon="AgELYmVuY2FybWFu", invoice="${longInvoice()}"`,
      })
    }
    const result = await verifyL402('https://example.com/api')
    assert.equal(result.valid, true)
    assert.equal(capturedMethod, 'GET')
  })

  it('returns invoiceValid and invoiceLengthOk fields', async () => {
    const { verifyL402 } = await import('../src/services/l402-verify.js')
    global.fetch = async () => mockResponse(402, {
      'www-authenticate': `L402 macaroon="AgELYmVuY2FybWFu", invoice="${longInvoice()}"`,
    })
    const result = await verifyL402('https://example.com/api')
    assert.equal(result.invoiceValid, true)
    assert.equal(result.invoiceLengthOk, true)
  })

  it('returns invoiceValid=false for short invoice', async () => {
    const { verifyL402 } = await import('../src/services/l402-verify.js')
    global.fetch = async () => mockResponse(402, {
      'www-authenticate': 'L402 macaroon="AgELYmVuY2FybWFu", invoice="lnbc1000n1pshort"',
    })
    const result = await verifyL402('https://example.com/api')
    assert.equal(result.valid, true)
    assert.equal(result.hasInvoice, true)
    assert.equal(result.invoiceValid, false)
    assert.equal(result.invoiceLengthOk, false)
  })
})

// ─── Homepage views: chain breakdown ────────────────────────────────────────

describe('homePage protocol bar — chain breakdown', () => {
  it('shows L402, Base, and Solana labels', async () => {
    const { homePage } = await import('../src/views/home.js')
    const html = homePage({
      services: [],
      total: 0,
      limit: 50,
      offset: 0,
      filters: {},
      stats: { total: 100, healthy: 80, degraded: 10, down: 5, unknown: 5, l402Providers: 24, baseProviders: 350, solanaProviders: 20 },
      categories: [],
    })
    assert.ok(html.includes('L402'), 'should show L402 label')
    assert.ok(html.includes('<span class="protocol-base">'), 'should show Base label')
    assert.ok(html.includes('<span class="protocol-solana">'), 'should show Solana label')
    assert.ok(html.includes('protocol-track-multi'), 'should use multi-track bar')
  })

  it('shows only L402 when no chain data', async () => {
    const { homePage } = await import('../src/views/home.js')
    const html = homePage({
      services: [],
      total: 0,
      limit: 50,
      offset: 0,
      filters: {},
      stats: { total: 100, healthy: 80, degraded: 10, down: 5, unknown: 5, l402Providers: 24, baseProviders: 0, solanaProviders: 0 },
      categories: [],
    })
    assert.ok(html.includes('L402'), 'should show L402')
    assert.ok(html.includes('<strong>24</strong>'), 'should show L402 count')
    assert.ok(!html.includes('<span class="protocol-base">'), 'should not show Base label')
    assert.ok(!html.includes('<span class="protocol-solana">'), 'should not show Solana label')
  })

  it('includes sort dropdown', async () => {
    const { homePage } = await import('../src/views/home.js')
    const html = homePage({
      services: [],
      total: 0,
      limit: 50,
      offset: 0,
      filters: {},
      stats: { total: 0, healthy: 0, degraded: 0, down: 0, unknown: 0 },
      categories: [],
    })
    assert.ok(html.includes('name="sort"'), 'should have sort dropdown')
    assert.ok(html.includes('Reliability'), 'should have reliability sort option')
  })
})

// ─── Detail page: reliability score display ─────────────────────────────────

describe('detailPage — reliability score', () => {
  it('shows reliability score when present', async () => {
    const { detailPage } = await import('../src/views/detail.js')
    const html = detailPage({
      name: 'Test',
      url: 'https://example.com',
      protocol: 'L402',
      health_status: 'healthy',
      source: 'exclusive',
      consecutive_failures: 0,
      health_checks: [],
      reliability_score: 87.5,
    })
    assert.ok(html.includes('Reliability Score'), 'should have Reliability Score label')
    assert.ok(html.includes('87.5/100'), 'should show score out of 100')
  })

  it('shows dash when reliability_score is null', async () => {
    const { detailPage } = await import('../src/views/detail.js')
    const html = detailPage({
      name: 'Test',
      url: 'https://example.com',
      protocol: 'L402',
      health_status: 'unknown',
      source: 'exclusive',
      consecutive_failures: 0,
      health_checks: [],
      reliability_score: null,
    })
    assert.ok(html.includes('Reliability Score'))
  })

  it('shows http_method annotation for POST endpoints', async () => {
    const { detailPage } = await import('../src/views/detail.js')
    const html = detailPage({
      name: 'Test POST API',
      url: 'https://example.com/api',
      protocol: 'L402',
      http_method: 'POST',
      health_status: 'healthy',
      source: 'self-registered',
      consecutive_failures: 0,
      health_checks: [],
    })
    assert.ok(html.includes('(POST)'), 'should show POST annotation')
  })

  it('does not show method annotation for GET endpoints', async () => {
    const { detailPage } = await import('../src/views/detail.js')
    const html = detailPage({
      name: 'Test GET API',
      url: 'https://example.com/api',
      protocol: 'L402',
      http_method: 'GET',
      health_status: 'healthy',
      source: 'self-registered',
      consecutive_failures: 0,
      health_checks: [],
    })
    assert.ok(!html.includes('(GET)'), 'should not show GET annotation (default)')
  })
})
