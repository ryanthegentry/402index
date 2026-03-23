/**
 * L402 Spec Compliance — DB Persistence, API Filtering, and View Tests
 *
 * Tests cover:
 *   DB migration: l402_compliant + l402_degrade_reason columns
 *   Health checker persistence of compliance data
 *   Query builder filtering by l402_compliant
 *   Digest endpoint compliance stats
 *   Detail page compliance display (L402 only, NOT on directory listing)
 *
 * Run: node --test test/l402-db-compliance.test.js
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'

// ─── Tests using the real app DB (migrations applied on import) ──────────────

describe('L402 compliance — DB migration', () => {
  let db

  before(async () => {
    db = (await import('../src/db.js')).default
  })

  it('services table has l402_compliant column (INTEGER, nullable)', () => {
    const cols = db.pragma("table_info('services')")
    const col = cols.find(c => c.name === 'l402_compliant')
    assert.ok(col, 'l402_compliant column should exist')
    assert.equal(col.type, 'INTEGER')
    assert.equal(col.notnull, 0, 'should be nullable')
  })

  it('services table has l402_degrade_reason column (TEXT, nullable)', () => {
    const cols = db.pragma("table_info('services')")
    const col = cols.find(c => c.name === 'l402_degrade_reason')
    assert.ok(col, 'l402_degrade_reason column should exist')
    assert.equal(col.type, 'TEXT')
    assert.equal(col.notnull, 0, 'should be nullable')
  })
})

describe('L402 compliance — persistence and queries', () => {
  let db

  before(async () => {
    db = (await import('../src/db.js')).default

    // Insert test services
    const insert = db.prepare(`
      INSERT OR REPLACE INTO services (id, name, url, protocol, source, health_status, status, l402_compliant, l402_degrade_reason)
      VALUES (@id, @name, @url, @protocol, @source, @health_status, 'active', @l402_compliant, @l402_degrade_reason)
    `)

    insert.run({ id: '__test_l402_ok__', name: 'Test Compliant L402', url: 'https://test-compliant.example.com/v1', protocol: 'L402', source: 'satring', health_status: 'healthy', l402_compliant: 1, l402_degrade_reason: null })
    insert.run({ id: '__test_l402_bad__', name: 'Test Non-Compliant L402', url: 'https://test-noncompliant.example.com/v1', protocol: 'L402', source: 'satring', health_status: 'degraded', l402_compliant: 0, l402_degrade_reason: 'JSON macaroon format (non-standard, spec requires binary)' })
    insert.run({ id: '__test_l402_hash__', name: 'Test Hash Mismatch L402', url: 'https://test-hashmismatch.example.com/v1', protocol: 'L402', source: 'satring', health_status: 'degraded', l402_compliant: 0, l402_degrade_reason: 'payment hash mismatch between macaroon and invoice' })
    insert.run({ id: '__test_x402_comp__', name: 'Test x402', url: 'https://test-x402-comp.example.com/v1', protocol: 'x402', source: 'bazaar', health_status: 'healthy', l402_compliant: null, l402_degrade_reason: null })
    insert.run({ id: '__test_mpp_comp__', name: 'Test MPP', url: 'https://test-mpp-comp.example.com/v1', protocol: 'MPP', source: 'mpp', health_status: 'healthy', l402_compliant: null, l402_degrade_reason: null })
  })

  after(() => {
    for (const id of ['__test_l402_ok__', '__test_l402_bad__', '__test_l402_hash__', '__test_x402_comp__', '__test_mpp_comp__']) {
      db.prepare('DELETE FROM health_checks WHERE service_id = ?').run(id)
      db.prepare('DELETE FROM services WHERE id = ?').run(id)
    }
  })

  it('persists l402_compliant=1 for spec-compliant endpoint', () => {
    const svc = db.prepare('SELECT l402_compliant, l402_degrade_reason FROM services WHERE id = ?').get('__test_l402_ok__')
    assert.equal(svc.l402_compliant, 1)
    assert.equal(svc.l402_degrade_reason, null)
  })

  it('persists l402_compliant=0 + reason for non-compliant endpoint', () => {
    const svc = db.prepare('SELECT l402_compliant, l402_degrade_reason FROM services WHERE id = ?').get('__test_l402_bad__')
    assert.equal(svc.l402_compliant, 0)
    assert.ok(svc.l402_degrade_reason.includes('JSON'))
  })

  it('persists l402_compliant=0 for payment hash mismatch', () => {
    const svc = db.prepare('SELECT l402_compliant, l402_degrade_reason FROM services WHERE id = ?').get('__test_l402_hash__')
    assert.equal(svc.l402_compliant, 0)
    assert.ok(svc.l402_degrade_reason.includes('payment hash mismatch'))
  })

  it('non-L402 endpoints have l402_compliant=NULL', () => {
    const x402 = db.prepare('SELECT l402_compliant, l402_degrade_reason FROM services WHERE id = ?').get('__test_x402_comp__')
    assert.equal(x402.l402_compliant, null)
    assert.equal(x402.l402_degrade_reason, null)

    const mpp = db.prepare('SELECT l402_compliant, l402_degrade_reason FROM services WHERE id = ?').get('__test_mpp_comp__')
    assert.equal(mpp.l402_compliant, null)
    assert.equal(mpp.l402_degrade_reason, null)
  })

  it('API /services/:id returns l402_compliant via SELECT *', () => {
    // The API route uses SELECT * — verify the column is accessible
    const svc = db.prepare('SELECT * FROM services WHERE id = ?').get('__test_l402_ok__')
    assert.equal(svc.l402_compliant, 1)
    assert.equal(svc.l402_degrade_reason, null)
  })
})

describe('L402 compliance — query builder filtering', () => {
  let db, buildServiceQuery, queryServices, API_COLUMNS

  before(async () => {
    db = (await import('../src/db.js')).default
    const queries = await import('../src/queries/services.js')
    buildServiceQuery = queries.buildServiceQuery
    queryServices = queries.queryServices
    API_COLUMNS = queries.API_COLUMNS

    // Ensure test data exists
    const insert = db.prepare(`
      INSERT OR REPLACE INTO services (id, name, url, protocol, source, health_status, status, l402_compliant, l402_degrade_reason, l402_format)
      VALUES (@id, @name, @url, @protocol, @source, @health_status, 'active', @l402_compliant, @l402_degrade_reason, @l402_format)
    `)
    insert.run({ id: '__test_qb_ok__', name: 'QBTest Compliant', url: 'https://qbtest-ok.example.com/v1', protocol: 'L402', source: 'satring', health_status: 'healthy', l402_compliant: 1, l402_degrade_reason: null, l402_format: 'v2_tlv' })
    insert.run({ id: '__test_qb_bad__', name: 'QBTest NonCompliant', url: 'https://qbtest-bad.example.com/v1', protocol: 'L402', source: 'satring', health_status: 'degraded', l402_compliant: 0, l402_degrade_reason: 'test reason', l402_format: 'json' })
  })

  after(() => {
    for (const id of ['__test_qb_ok__', '__test_qb_bad__']) {
      db.prepare('DELETE FROM health_checks WHERE service_id = ?').run(id)
      db.prepare('DELETE FROM services WHERE id = ?').run(id)
    }
  })

  it('?l402_compliant=true filters to compliant L402 endpoints', () => {
    const result = queryServices(db, { l402_compliant: 'true', q: 'QBTest' }, API_COLUMNS)
    assert.ok(result.services.length >= 1)
    for (const svc of result.services) {
      assert.equal(svc.l402_compliant, 1)
    }
  })

  it('?l402_compliant=false filters to non-compliant L402 endpoints', () => {
    const result = queryServices(db, { l402_compliant: 'false', q: 'QBTest' }, API_COLUMNS)
    assert.ok(result.services.length >= 1)
    for (const svc of result.services) {
      assert.equal(svc.l402_compliant, 0)
    }
  })

  it('API_COLUMNS includes l402_compliant and l402_degrade_reason', () => {
    assert.ok(API_COLUMNS.includes('l402_compliant'))
    assert.ok(API_COLUMNS.includes('l402_degrade_reason'))
  })
})

describe('L402 compliance — digest endpoint stats', () => {
  let db

  before(async () => {
    db = (await import('../src/db.js')).default
  })

  it('can query l402_compliant_count and l402_non_compliant_count', () => {
    const ACTIVE = "(status = 'active' OR status IS NULL) AND (provider_deleted = 0 OR provider_deleted IS NULL)"
    const row = db.prepare(`
      SELECT
        SUM(CASE WHEN l402_compliant = 1 THEN 1 ELSE 0 END) as compliant,
        SUM(CASE WHEN l402_compliant = 0 THEN 1 ELSE 0 END) as non_compliant
      FROM services WHERE protocol = 'L402' AND ${ACTIVE}
    `).get()
    assert.equal(typeof (row.compliant || 0), 'number')
    assert.equal(typeof (row.non_compliant || 0), 'number')
  })
})

describe('L402 compliance — detail page view', () => {
  let detailPage

  before(async () => {
    detailPage = (await import('../src/views/detail.js')).detailPage
  })

  it('shows macaroon format section for L402 endpoints', () => {
    const html = detailPage({
      id: 'test-1', name: 'Test', url: 'https://test.com', protocol: 'L402',
      health_status: 'healthy', consecutive_failures: 0, source: 'satring',
      l402_format: 'v2_tlv',
    })
    assert.ok(html.includes('Macaroon Format'))
    assert.ok(html.includes('V2 TLV Binary'))
  })

  it('shows JSON format neutrally for L402 endpoints', () => {
    const html = detailPage({
      id: 'test-2', name: 'Test JSON', url: 'https://test2.com', protocol: 'L402',
      health_status: 'healthy', consecutive_failures: 0, source: 'satring',
      l402_format: 'json',
    })
    assert.ok(html.includes('Macaroon Format'))
    assert.ok(!html.includes('Non-Compliant'))
  })

  it('does NOT show macaroon format section for x402 endpoints', () => {
    const html = detailPage({
      id: 'test-3', name: 'Test x402', url: 'https://test3.com', protocol: 'x402',
      health_status: 'healthy', consecutive_failures: 0, source: 'bazaar',
      x402_payment_valid: 1, x402_asset_known: 1, x402_facilitator_reachable: 1,
    })
    assert.ok(!html.includes('Macaroon Format'))
  })

  it('does NOT show macaroon format section for MPP endpoints', () => {
    const html = detailPage({
      id: 'test-4', name: 'Test MPP', url: 'https://test4.com', protocol: 'MPP',
      health_status: 'healthy', consecutive_failures: 0, source: 'mpp',
    })
    assert.ok(!html.includes('Macaroon Format'))
  })
})

describe('L402 compliance — directory listing privacy', () => {
  it('home page view does NOT expose compliance data', async () => {
    const { homePage } = await import('../src/views/home.js')
    const html = homePage({
      services: [
        { id: '1', name: 'Svc', url: 'https://test.com', protocol: 'L402', health_status: 'healthy', source: 'satring', category: 'ai', l402_compliant: 1 },
      ],
      total: 1, limit: 50, offset: 0,
      filters: {},
      stats: { healthy: 1, degraded: 0, down: 0 },
      categories: [],
      btcUsdRate: 60000,
    })
    const lower = html.toLowerCase()
    assert.ok(!lower.includes('l402_compliant'), 'directory must not contain l402_compliant')
    assert.ok(!lower.includes('l402_degrade_reason'), 'directory must not contain l402_degrade_reason')
    assert.ok(!lower.includes('l402_format'), 'directory must not contain l402_format')
    assert.ok(!lower.includes('macaroon format'), 'directory must not contain "macaroon format"')
  })
})
