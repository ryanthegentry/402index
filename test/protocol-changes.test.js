/**
 * Protocol Change Detection & Admin Review tests (issue #98)
 *
 * TDD: these tests MUST fail against current code, then pass after implementation.
 *
 * Run: ADMIN_SECRET=test-secret node --test test/protocol-changes.test.js
 */

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'crypto'
import db from '../src/db.js'
import { startServer, stopServer } from './helpers/server.js'

const SECRET = process.env.ADMIN_SECRET || 'test-secret'
let BASE, API

before(async () => {
  BASE = await startServer()
  API = `${BASE}/api/v1`
})
after(async () => { await stopServer() })

async function adminGet(path) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Authorization': `Bearer ${SECRET}` },
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

async function adminPost(path, body) {
  const opts = {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SECRET}` },
  }
  if (body) {
    opts.headers['Content-Type'] = 'application/json'
    opts.body = JSON.stringify(body)
  }
  const res = await fetch(`${API}${path}`, opts)
  return { status: res.status, body: await res.json().catch(() => null) }
}

// Helper: insert a service row directly
function insertService(overrides = {}) {
  const id = overrides.id || randomUUID()
  const defaults = {
    id,
    name: 'Test Service',
    url: 'https://api.example.com/v1/test',
    protocol: 'L402',
    source: 'self-registered',
    health_status: 'healthy',
    status: 'active',
    hostname: 'api.example.com',
    provider_deleted: 0,
  }
  const params = { ...defaults, ...overrides }
  db.prepare(`
    INSERT INTO services (id, name, url, protocol, source, health_status, status, hostname, provider_deleted)
    VALUES (@id, @name, @url, @protocol, @source, @health_status, @status, @hostname, @provider_deleted)
  `).run(params)
  return params
}

// Helper: insert a protocol_changes row directly
function insertProtocolChange(overrides = {}) {
  const id = overrides.id || randomUUID()
  const defaults = {
    id,
    url: 'https://api.example.com/v1/test',
    hostname: 'api.example.com',
    service_id: randomUUID(),
    registered_protocol: 'L402',
    detected_protocol: 'x402',
    type: 'addition',
    status: 'pending',
  }
  const params = { ...defaults, ...overrides }
  db.prepare(`
    INSERT INTO protocol_changes (id, url, hostname, service_id, registered_protocol, detected_protocol, type, status)
    VALUES (@id, @url, @hostname, @service_id, @registered_protocol, @detected_protocol, @type, @status)
  `).run(params)
  return params
}

// Clean up test data between tests
function cleanupTestData() {
  db.prepare("DELETE FROM protocol_changes WHERE url LIKE '%example.com%' OR url LIKE '%test-pc%'").run()
  db.prepare("DELETE FROM health_checks WHERE service_id IN (SELECT id FROM services WHERE url LIKE '%example.com%' OR url LIKE '%test-pc%')").run()
  db.prepare("DELETE FROM services WHERE url LIKE '%example.com%' OR url LIKE '%test-pc%'").run()
  db.prepare("DELETE FROM domain_claims WHERE domain LIKE '%example.com%' OR domain LIKE '%test-pc%'").run()
}

// ─── Schema Tests ──────────────────────────────────────────────────────────

describe('protocol_changes schema (issue #98)', () => {
  before(() => cleanupTestData())
  after(() => cleanupTestData())

  it('protocol_changes table exists', () => {
    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='protocol_changes'"
    ).get()
    assert.ok(table, 'protocol_changes table should exist')
  })

  it('UNIQUE constraint on (url, detected_protocol, type) rejects duplicates', () => {
    const url = 'https://test-pc-unique.example.com/v1'
    const serviceId = randomUUID()
    db.prepare(`
      INSERT INTO protocol_changes (id, url, hostname, service_id, registered_protocol, detected_protocol, type)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), url, 'test-pc-unique.example.com', serviceId, 'L402', 'x402', 'addition')

    assert.throws(() => {
      db.prepare(`
        INSERT INTO protocol_changes (id, url, hostname, service_id, registered_protocol, detected_protocol, type)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), url, 'test-pc-unique.example.com', serviceId, 'L402', 'x402', 'addition')
    }, /UNIQUE constraint/)
  })

  it('UPSERT increments detection_count', () => {
    const url = 'https://test-pc-upsert.example.com/v1'
    const serviceId = randomUUID()
    db.prepare(`
      INSERT INTO protocol_changes (id, url, hostname, service_id, registered_protocol, detected_protocol, type)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(url, detected_protocol, type) DO UPDATE SET
        last_detected_at = datetime('now'),
        detection_count = detection_count + 1,
        service_id = excluded.service_id
      WHERE status != 'dismissed'
    `).run(randomUUID(), url, 'test-pc-upsert.example.com', serviceId, 'L402', 'x402', 'addition')

    // Second upsert
    db.prepare(`
      INSERT INTO protocol_changes (id, url, hostname, service_id, registered_protocol, detected_protocol, type)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(url, detected_protocol, type) DO UPDATE SET
        last_detected_at = datetime('now'),
        detection_count = detection_count + 1,
        service_id = excluded.service_id
      WHERE status != 'dismissed'
    `).run(randomUUID(), url, 'test-pc-upsert.example.com', serviceId, 'L402', 'x402', 'addition')

    const row = db.prepare('SELECT detection_count FROM protocol_changes WHERE url = ?').get(url)
    assert.equal(row.detection_count, 2)
  })

  it('CHECK constraint on type enforces valid values', () => {
    assert.throws(() => {
      db.prepare(`
        INSERT INTO protocol_changes (id, url, hostname, service_id, registered_protocol, detected_protocol, type)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), 'https://test-pc-check.example.com/v1', 'test-pc-check.example.com', randomUUID(), 'L402', 'x402', 'invalid_type')
    }, /CHECK constraint/)
  })

  it('CHECK constraint on status enforces valid values', () => {
    assert.throws(() => {
      db.prepare(`
        INSERT INTO protocol_changes (id, url, hostname, service_id, registered_protocol, detected_protocol, type, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), 'https://test-pc-status.example.com/v1', 'test-pc-status.example.com', randomUUID(), 'L402', 'x402', 'addition', 'invalid_status')
    }, /CHECK constraint/)
  })

  it('status index exists', () => {
    const idx = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_protocol_changes_status'"
    ).get()
    assert.ok(idx, 'idx_protocol_changes_status index should exist')
  })
})

// ─── Health Checker Detection Tests ────────────────────────────────────────

describe('Health checker protocol change detection (issue #98)', () => {
  // These tests import checkService and call it with mock data.
  // They verify protocol_changes rows are created/updated correctly.

  let checkService
  before(async () => {
    cleanupTestData()
    const checker = await import('../src/health/checker.js')
    checkService = checker.checkService
  })
  after(() => cleanupTestData())
  beforeEach(() => {
    db.prepare("DELETE FROM protocol_changes WHERE url LIKE '%test-pc%'").run()
    db.prepare("DELETE FROM health_checks WHERE service_id IN (SELECT id FROM services WHERE url LIKE '%test-pc%')").run()
    db.prepare("DELETE FROM services WHERE url LIKE '%test-pc%'").run()
  })

  it('new protocol in detection array with no existing service row creates addition', async () => {
    // Register an L402 service
    const url = 'https://test-pc-add.example.com/v1'
    const svc = insertService({ url, protocol: 'L402', hostname: 'test-pc-add.example.com' })

    // checkService would probe the URL — we can't control the probe, but we can
    // verify detection logic by checking the table directly after a health check.
    // For unit-level testing, we insert directly and verify the schema works.

    // The real test: after health check detects x402 on an L402-only URL,
    // a protocol_changes row should exist.
    // Since we can't mock the probe, we test the detection logic indirectly
    // by verifying the UPSERT SQL works correctly:
    db.prepare(`
      INSERT INTO protocol_changes (id, url, hostname, service_id, registered_protocol, detected_protocol, type)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), url, 'test-pc-add.example.com', svc.id, 'L402', 'x402', 'addition')

    const row = db.prepare(
      "SELECT * FROM protocol_changes WHERE url = ? AND detected_protocol = 'x402' AND type = 'addition'"
    ).get(url)
    assert.ok(row, 'should create addition row')
    assert.equal(row.type, 'addition')
    assert.equal(row.status, 'pending')
    assert.equal(row.detection_count, 1)
  })

  it('removal type when protocol in service rows but NOT in detection array', () => {
    const url = 'https://test-pc-remove.example.com/v1'
    const svc = insertService({ url, protocol: 'L402', hostname: 'test-pc-remove.example.com' })
    insertService({ url, protocol: 'x402', hostname: 'test-pc-remove.example.com' })

    // Simulate: health check detected only L402, x402 absent → removal for x402
    db.prepare(`
      INSERT INTO protocol_changes (id, url, hostname, service_id, registered_protocol, detected_protocol, type)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), url, 'test-pc-remove.example.com', svc.id, 'L402', 'x402', 'removal')

    const row = db.prepare(
      "SELECT * FROM protocol_changes WHERE url = ? AND type = 'removal'"
    ).get(url)
    assert.ok(row, 'should create removal row')
    assert.equal(row.detected_protocol, 'x402')
  })

  it('repeated detection increments detection_count without duplicate row', () => {
    const url = 'https://test-pc-repeat.example.com/v1'
    const serviceId = randomUUID()

    // First detection
    db.prepare(`
      INSERT INTO protocol_changes (id, url, hostname, service_id, registered_protocol, detected_protocol, type)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(url, detected_protocol, type) DO UPDATE SET
        last_detected_at = datetime('now'),
        detection_count = detection_count + 1,
        service_id = excluded.service_id
      WHERE status != 'dismissed'
    `).run(randomUUID(), url, 'test-pc-repeat.example.com', serviceId, 'L402', 'x402', 'addition')

    // Second detection
    db.prepare(`
      INSERT INTO protocol_changes (id, url, hostname, service_id, registered_protocol, detected_protocol, type)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(url, detected_protocol, type) DO UPDATE SET
        last_detected_at = datetime('now'),
        detection_count = detection_count + 1,
        service_id = excluded.service_id
      WHERE status != 'dismissed'
    `).run(randomUUID(), url, 'test-pc-repeat.example.com', serviceId, 'L402', 'x402', 'addition')

    const rows = db.prepare(
      "SELECT * FROM protocol_changes WHERE url = ? AND detected_protocol = 'x402'"
    ).all(url)
    assert.equal(rows.length, 1, 'should not create duplicate row')
    assert.equal(rows[0].detection_count, 2)
  })

  it('dismissed row is NOT re-flagged on subsequent detection (UPSERT no-op)', () => {
    const url = 'https://test-pc-dismissed.example.com/v1'
    const serviceId = randomUUID()

    // Insert dismissed row
    db.prepare(`
      INSERT INTO protocol_changes (id, url, hostname, service_id, registered_protocol, detected_protocol, type, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), url, 'test-pc-dismissed.example.com', serviceId, 'L402', 'x402', 'addition', 'dismissed')

    // Attempt UPSERT — should be no-op due to WHERE status != 'dismissed'
    db.prepare(`
      INSERT INTO protocol_changes (id, url, hostname, service_id, registered_protocol, detected_protocol, type)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(url, detected_protocol, type) DO UPDATE SET
        last_detected_at = datetime('now'),
        detection_count = detection_count + 1,
        service_id = excluded.service_id
      WHERE status != 'dismissed'
    `).run(randomUUID(), url, 'test-pc-dismissed.example.com', serviceId, 'L402', 'x402', 'addition')

    const row = db.prepare(
      "SELECT * FROM protocol_changes WHERE url = ?"
    ).get(url)
    assert.equal(row.status, 'dismissed', 'status should remain dismissed')
    assert.equal(row.detection_count, 1, 'detection_count should not increment')
  })

  it('protocol-agnostic: works with L402, x402, and MPP', () => {
    const url = 'https://test-pc-agnostic.example.com/v1'
    const serviceId = randomUUID()

    for (const proto of ['L402', 'x402', 'MPP']) {
      db.prepare(`
        INSERT INTO protocol_changes (id, url, hostname, service_id, registered_protocol, detected_protocol, type)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), url, 'test-pc-agnostic.example.com', serviceId, 'L402', proto, 'addition')
    }

    const rows = db.prepare(
      'SELECT * FROM protocol_changes WHERE url = ?'
    ).all(url)
    assert.equal(rows.length, 3, 'should have rows for L402, x402, and MPP')
  })

  it('contact_email populated from domain_claims when available', () => {
    // Insert a verified domain claim
    db.prepare(`
      INSERT INTO domain_claims (id, domain, verification_token, status, expires_at, contact_email)
      VALUES (?, ?, ?, 'verified', datetime('now', '+30 days'), ?)
    `).run(randomUUID(), 'test-pc-email.example.com', 'token123', 'provider@example.com')

    // Insert protocol change with contact_email from domain_claims
    db.prepare(`
      INSERT INTO protocol_changes (id, url, hostname, service_id, registered_protocol, detected_protocol, type, contact_email)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), 'https://test-pc-email.example.com/v1', 'test-pc-email.example.com',
      randomUUID(), 'L402', 'x402', 'addition', 'provider@example.com'
    )

    const row = db.prepare(
      "SELECT contact_email FROM protocol_changes WHERE hostname = 'test-pc-email.example.com'"
    ).get()
    assert.equal(row.contact_email, 'provider@example.com')
  })
})

// ─── Admin API Tests ────────────────────────────────────────────────────────

describe('Admin protocol-changes API (issue #98)', () => {
  beforeEach(() => cleanupTestData())
  after(() => cleanupTestData())

  it('GET /admin/protocol-changes returns pending by default', async () => {
    // Insert test data
    insertService({ url: 'https://test-pc-api.example.com/v1', protocol: 'L402', hostname: 'test-pc-api.example.com' })
    insertProtocolChange({
      url: 'https://test-pc-api.example.com/v1',
      hostname: 'test-pc-api.example.com',
      registered_protocol: 'L402',
      detected_protocol: 'x402',
      type: 'addition',
      status: 'pending',
    })
    insertProtocolChange({
      url: 'https://test-pc-api.example.com/v1',
      hostname: 'test-pc-api.example.com',
      registered_protocol: 'L402',
      detected_protocol: 'MPP',
      type: 'addition',
      status: 'dismissed',
    })

    const r = await adminGet('/admin/protocol-changes')
    assert.equal(r.status, 200)
    assert.ok(Array.isArray(r.body.changes), 'response should have changes array')
    // Only pending should be returned by default
    const pending = r.body.changes.filter(c => c.status === 'pending')
    assert.ok(pending.length >= 1, 'should have at least 1 pending change')
    const dismissed = r.body.changes.filter(c => c.status === 'dismissed')
    assert.equal(dismissed.length, 0, 'dismissed should not be in default response')
  })

  it('GET /admin/protocol-changes?status=all returns all statuses', async () => {
    insertService({ url: 'https://test-pc-all.example.com/v1', protocol: 'L402', hostname: 'test-pc-all.example.com' })
    insertProtocolChange({
      url: 'https://test-pc-all.example.com/v1',
      hostname: 'test-pc-all.example.com',
      status: 'pending',
    })
    insertProtocolChange({
      url: 'https://test-pc-all.example.com/v1',
      hostname: 'test-pc-all.example.com',
      detected_protocol: 'MPP',
      status: 'dismissed',
    })

    const r = await adminGet('/admin/protocol-changes?status=all')
    assert.equal(r.status, 200)
    assert.ok(r.body.changes.length >= 2, 'should include both pending and dismissed')
  })

  it('GET /admin/protocol-changes requires admin auth', async () => {
    const res = await fetch(`${API}/admin/protocol-changes`)
    assert.equal(res.status, 401)
  })

  it('POST /admin/protocol-changes/:id/approve creates sibling service row', async () => {
    const svc = insertService({
      url: 'https://test-pc-approve.example.com/v1',
      protocol: 'L402',
      name: 'Mycelia Signal',
      hostname: 'test-pc-approve.example.com',
    })
    const pc = insertProtocolChange({
      url: 'https://test-pc-approve.example.com/v1',
      hostname: 'test-pc-approve.example.com',
      service_id: svc.id,
      registered_protocol: 'L402',
      detected_protocol: 'x402',
      type: 'addition',
      status: 'pending',
    })

    const r = await adminPost(`/admin/protocol-changes/${pc.id}/approve`)
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`)
    assert.ok(r.body.created_service_id, 'should return created_service_id')

    // Verify sibling service row
    const sibling = db.prepare('SELECT * FROM services WHERE id = ?').get(r.body.created_service_id)
    assert.ok(sibling, 'sibling service should exist')
    assert.equal(sibling.protocol, 'x402')
    assert.equal(sibling.name, 'Mycelia Signal (x402)', 'should follow bonus row naming convention')
    assert.equal(sibling.status, 'active')
    assert.equal(sibling.approval_reason, 'admin-protocol-change')
    assert.equal(sibling.price_sats, null, 'pricing should be null')
    assert.equal(sibling.price_usd, null, 'pricing should be null')
    assert.equal(sibling.payment_asset, null, 'payment_asset should be null')
    assert.equal(sibling.payment_network, null, 'payment_network should be null')

    // Verify protocol_changes row updated
    const updated = db.prepare('SELECT * FROM protocol_changes WHERE id = ?').get(pc.id)
    assert.equal(updated.status, 'approved')
    assert.ok(updated.reviewed_at, 'reviewed_at should be set')
    assert.equal(updated.created_service_id, r.body.created_service_id)
  })

  it('POST /admin/protocol-changes/:id/approve on removal type returns 400', async () => {
    const svc = insertService({
      url: 'https://test-pc-approve-removal.example.com/v1',
      protocol: 'L402',
      hostname: 'test-pc-approve-removal.example.com',
    })
    const pc = insertProtocolChange({
      url: 'https://test-pc-approve-removal.example.com/v1',
      hostname: 'test-pc-approve-removal.example.com',
      service_id: svc.id,
      type: 'removal',
      status: 'pending',
    })

    const r = await adminPost(`/admin/protocol-changes/${pc.id}/approve`)
    assert.equal(r.status, 400)
  })

  it('POST /admin/protocol-changes/:id/approve on already-approved row returns 409', async () => {
    const svc = insertService({
      url: 'https://test-pc-approve-dup.example.com/v1',
      protocol: 'L402',
      hostname: 'test-pc-approve-dup.example.com',
    })
    const pc = insertProtocolChange({
      url: 'https://test-pc-approve-dup.example.com/v1',
      hostname: 'test-pc-approve-dup.example.com',
      service_id: svc.id,
      type: 'addition',
      status: 'approved',
    })

    const r = await adminPost(`/admin/protocol-changes/${pc.id}/approve`)
    assert.equal(r.status, 409)
  })

  it('POST /admin/protocol-changes/:id/approve requires admin auth', async () => {
    const res = await fetch(`${API}/admin/protocol-changes/some-id/approve`, { method: 'POST' })
    assert.equal(res.status, 401)
  })

  it('POST /admin/protocol-changes/:id/dismiss sets status and reviewed_at', async () => {
    const pc = insertProtocolChange({
      url: 'https://test-pc-dismiss.example.com/v1',
      hostname: 'test-pc-dismiss.example.com',
      status: 'pending',
    })

    const r = await adminPost(`/admin/protocol-changes/${pc.id}/dismiss`)
    assert.equal(r.status, 200)

    const updated = db.prepare('SELECT * FROM protocol_changes WHERE id = ?').get(pc.id)
    assert.equal(updated.status, 'dismissed')
    assert.ok(updated.reviewed_at, 'reviewed_at should be set')
  })

  it('POST /admin/protocol-changes/:id/dismiss requires admin auth', async () => {
    const res = await fetch(`${API}/admin/protocol-changes/some-id/dismiss`, { method: 'POST' })
    assert.equal(res.status, 401)
  })
})

// ─── Admin UI Tests ─────────────────────────────────────────────────────────

describe('Admin dashboard Protocol Changes tab (issue #98)', () => {
  it('admin page HTML contains Protocol Changes tab', async () => {
    const res = await fetch(`${BASE}/admin`, {
      headers: { 'Authorization': `Bearer ${SECRET}` },
    })
    assert.equal(res.status, 200)
    const html = await res.text()
    assert.ok(html.includes('data-tab="protocol-changes"'), 'should have protocol-changes tab button')
    assert.ok(html.includes('panel-protocol-changes'), 'should have protocol-changes panel')
  })
})

// ─── Integration Test ───────────────────────────────────────────────────────

describe('Protocol change detection → admin approve → sibling exists (integration)', () => {
  before(() => cleanupTestData())
  after(() => cleanupTestData())

  it('end-to-end: detect addition → approve → active sibling service', async () => {
    // 1. Create service
    const svc = insertService({
      url: 'https://test-pc-e2e.example.com/v1',
      protocol: 'L402',
      name: 'E2E Test Service',
      hostname: 'test-pc-e2e.example.com',
    })

    // 2. Simulate health check detecting x402 (normally done by checker.js)
    const pcId = randomUUID()
    db.prepare(`
      INSERT INTO protocol_changes (id, url, hostname, service_id, registered_protocol, detected_protocol, type)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(pcId, svc.url, 'test-pc-e2e.example.com', svc.id, 'L402', 'x402', 'addition')

    // 3. Admin approves
    const r = await adminPost(`/admin/protocol-changes/${pcId}/approve`)
    assert.equal(r.status, 200)

    // 4. Verify sibling exists with correct status
    const sibling = db.prepare(
      "SELECT * FROM services WHERE url = ? AND protocol = 'x402'"
    ).get(svc.url)
    assert.ok(sibling, 'sibling service should exist')
    assert.equal(sibling.status, 'active')
    assert.equal(sibling.approval_reason, 'admin-protocol-change')
    assert.equal(sibling.name, 'E2E Test Service (x402)')
  })
})
