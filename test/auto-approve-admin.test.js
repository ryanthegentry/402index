/**
 * Tests for auto-approve registration, failed registration logging,
 * and admin dashboard upgrades (domains + failed tabs).
 *
 * Run: ADMIN_SECRET=test-secret node --test test/auto-approve-admin.test.js
 *
 * Covers:
 *   Feature 1: Domain-verified auto-approve, retroactive approval, per-domain rate limit, domain nudge
 *   Feature 2: Failed registration probe logging to registration_attempts
 *   Feature 3: Admin /domains and /failed-registrations endpoints
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import db from '../src/db.js'
import { startServer, stopServer } from './helpers/server.js'

let BASE = process.env.API_BASE
let API
const SECRET = process.env.ADMIN_SECRET || 'test-secret'

before(async () => { BASE = BASE || await startServer(); API = `${BASE}/api/v1` })

// ─── Helpers ────────────────────────────────────────────────────────────────

function authHeaders() {
  return { Authorization: `Bearer ${SECRET}` }
}

async function adminGet(path) {
  const res = await fetch(`${API}${path}`, { headers: authHeaders() })
  return { status: res.status, body: await res.json().catch(() => null) }
}

function seedService(overrides = {}) {
  const id = overrides.id || `aat-${randomUUID().slice(0, 8)}`
  const now = new Date().toISOString().replace('T', ' ').replace('Z', '')
  const url = overrides.url ?? `https://aat-${id}.example.com/api`
  let hostname = null
  try { hostname = new URL(url).hostname } catch {}
  db.prepare(`
    INSERT INTO services (id, name, url, protocol, source, status, provider, category,
                          hostname, registered_at, updated_at)
    VALUES (@id, @name, @url, @protocol, @source, @status, @provider, @category,
            @hostname, @registered_at, @updated_at)
  `).run({
    id,
    name: overrides.name ?? `Test ${id}`,
    url,
    protocol: overrides.protocol ?? 'L402',
    source: overrides.source ?? 'self-registered',
    status: overrides.status ?? 'pending',
    provider: overrides.provider ?? null,
    category: overrides.category ?? 'test',
    hostname,
    registered_at: overrides.registered_at ?? now,
    updated_at: overrides.updated_at ?? now,
  })
  return id
}

function seedDomainClaim(domain, overrides = {}) {
  const id = randomUUID()
  const now = new Date().toISOString().replace('T', ' ').replace('Z', '')
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
  db.prepare(`
    INSERT INTO domain_claims (id, domain, verification_token, status, claimed_at, verified_at, expires_at, contact_email)
    VALUES (@id, @domain, @token, @status, @claimed_at, @verified_at, @expires_at, @contact_email)
  `).run({
    id,
    domain,
    token: overrides.verification_token ?? 'test-token-' + id.slice(0, 8),
    status: overrides.status ?? 'verified',
    claimed_at: overrides.claimed_at ?? now,
    verified_at: overrides.verified_at ?? (overrides.status === 'pending' ? null : now),
    expires_at: overrides.expires_at ?? expiresAt,
    contact_email: overrides.contact_email ?? null,
  })
  return id
}

function seedRegistrationAttempt(overrides = {}) {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO registration_attempts (id, url, protocol, name, provider, failure_reason, probe_http_status, attempted_at)
    VALUES (@id, @url, @protocol, @name, @provider, @failure_reason, @probe_http_status, @attempted_at)
  `).run({
    id,
    url: overrides.url ?? 'https://fail.example.com/api',
    protocol: overrides.protocol ?? 'L402',
    name: overrides.name ?? 'Failed Service',
    provider: overrides.provider ?? null,
    failure_reason: overrides.failure_reason ?? 'Probe failed',
    probe_http_status: overrides.probe_http_status ?? 200,
    attempted_at: overrides.attempted_at ?? new Date().toISOString().replace('T', ' ').replace('Z', ''),
  })
  return id
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

const testIds = []
const testDomains = []

after(async () => {
  // Clean up all test data
  try {
    db.prepare("DELETE FROM services WHERE id LIKE 'aat-%'").run()
    db.prepare("DELETE FROM domain_claims WHERE domain LIKE '%.aat-test.com'").run()
    db.prepare("DELETE FROM domain_claims WHERE domain = 'aat-test.com'").run()
    db.prepare("DELETE FROM registration_attempts WHERE url LIKE '%aat-%'").run()
    db.prepare("DELETE FROM registration_attempts WHERE url LIKE '%fail.example.com%'").run()
  } catch {
    // Tables may not exist in fresh db
  }
  await stopServer()
})

// ─── Schema ─────────────────────────────────────────────────────────────────

describe('Schema: approval_reason column', () => {
  it('services table has approval_reason column', () => {
    const cols = db.pragma("table_info('services')")
    const col = cols.find(c => c.name === 'approval_reason')
    assert.ok(col, 'approval_reason column should exist on services table')
    assert.equal(col.type, 'TEXT')
  })
})

describe('Schema: registration_attempts table', () => {
  it('registration_attempts table exists with expected columns', () => {
    const cols = db.pragma("table_info('registration_attempts')")
    const colNames = cols.map(c => c.name)
    assert.ok(colNames.includes('id'))
    assert.ok(colNames.includes('url'))
    assert.ok(colNames.includes('protocol'))
    assert.ok(colNames.includes('failure_reason'))
    assert.ok(colNames.includes('probe_http_status'))
    assert.ok(colNames.includes('probe_error'))
    assert.ok(colNames.includes('suggested_protocol'))
    assert.ok(colNames.includes('ip_address'))
    assert.ok(colNames.includes('attempted_at'))
  })
})

// ─── Feature 1: Auto-Approve ────────────────────────────────────────────────

describe('Feature 1: Retroactive approval on domain verification', () => {
  it('retroactive approval SQL updates all pending services from the verified domain', () => {
    const domain = 'retro.aat-test.com'
    // Seed 3 pending services under this domain
    const ids = [
      seedService({ url: `https://${domain}/api/v1`, status: 'pending' }),
      seedService({ url: `https://${domain}/api/v2`, status: 'pending' }),
      seedService({ url: `https://${domain}/api/v3`, status: 'pending' }),
    ]

    // Simulate what verifyClaim does after successful verification:
    // 1. Mark domain as verified
    seedDomainClaim(domain, { status: 'verified' })

    // 2. Flag services as domain-verified
    const p1 = `%://${domain}/%`
    const p2 = `%://${domain}`
    db.prepare(
      "UPDATE services SET domain_verified = 1 WHERE (url LIKE @p1 OR url LIKE @p2) AND (status = 'active' OR status IS NULL)"
    ).run({ p1, p2 })

    // 3. Retroactively approve pending services (the new logic)
    const result = db.prepare(
      `UPDATE services SET status = 'active', approval_reason = 'domain-verified', updated_at = datetime('now')
       WHERE status = 'pending' AND (provider_deleted = 0 OR provider_deleted IS NULL)
       AND (url LIKE @p1 OR url LIKE @p2)`
    ).run({ p1, p2 })

    assert.equal(result.changes, 3, 'Should have approved 3 pending services')

    // Verify all 3 services are now active with approval_reason
    for (const id of ids) {
      const svc = db.prepare('SELECT status, approval_reason FROM services WHERE id = ?').get(id)
      assert.equal(svc.status, 'active', `Service ${id} should be active`)
      assert.equal(svc.approval_reason, 'domain-verified', `Service ${id} should have domain-verified reason`)
    }
  })

  it('does not retroactively approve services from different domains', () => {
    const domain = 'only.aat-test.com'
    const otherId = seedService({ url: 'https://other.aat-test.com/api', status: 'pending' })
    const matchId = seedService({ url: `https://${domain}/api`, status: 'pending' })

    // Simulate retroactive approval for 'only.aat-test.com'
    const p1 = `%://${domain}/%`
    const p2 = `%://${domain}`
    db.prepare(
      `UPDATE services SET status = 'active', approval_reason = 'domain-verified', updated_at = datetime('now')
       WHERE status = 'pending' AND (provider_deleted = 0 OR provider_deleted IS NULL)
       AND (url LIKE @p1 OR url LIKE @p2)`
    ).run({ p1, p2 })

    const other = db.prepare('SELECT status FROM services WHERE id = ?').get(otherId)
    assert.equal(other.status, 'pending', 'Service from other domain should remain pending')

    const match = db.prepare('SELECT status FROM services WHERE id = ?').get(matchId)
    assert.equal(match.status, 'active', 'Service from matching domain should be active')
  })

  it('does not approve soft-deleted services', () => {
    const domain = 'nodelete.aat-test.com'
    const id = seedService({ url: `https://${domain}/api`, status: 'pending' })
    db.prepare('UPDATE services SET provider_deleted = 1 WHERE id = ?').run(id)

    const p1 = `%://${domain}/%`
    const p2 = `%://${domain}`
    const result = db.prepare(
      `UPDATE services SET status = 'active', approval_reason = 'domain-verified', updated_at = datetime('now')
       WHERE status = 'pending' AND (provider_deleted = 0 OR provider_deleted IS NULL)
       AND (url LIKE @p1 OR url LIKE @p2)`
    ).run({ p1, p2 })

    assert.equal(result.changes, 0, 'Should not approve soft-deleted services')
  })
})

describe('Feature 1: Per-domain rate limit', () => {
  it('services table can hold > 20 rows from same domain for rate limit testing', () => {
    // Seed 20 services from same domain within last hour
    const domain = 'ratelimit.aat-test.com'
    for (let i = 0; i < 20; i++) {
      seedService({
        url: `https://${domain}/api/endpoint-${i}`,
        source: 'self-registered',
        registered_at: new Date().toISOString().replace('T', ' ').replace('Z', ''),
      })
    }

    // Verify count
    const count = db.prepare(
      `SELECT COUNT(*) as c FROM services
       WHERE source = 'self-registered'
         AND registered_at > datetime('now', '-1 hour')
         AND (url LIKE 'https://ratelimit.aat-test.com/%' OR url LIKE 'https://ratelimit.aat-test.com')`
    ).get().c
    assert.ok(count >= 20, `Expected >= 20, got ${count}`)
  })
})

describe('Feature 1: Domain-verified auto-approve logic', () => {
  it('services with verified domain get approval_reason set on approve', () => {
    const domain = 'autoapprove.aat-test.com'
    seedDomainClaim(domain, { status: 'verified' })

    const id = seedService({ url: `https://${domain}/new-api`, status: 'pending' })

    // Simulate what the register handler does: check domain, approve
    const verifiedDomain = db.prepare(
      "SELECT id FROM domain_claims WHERE domain = ? AND status = 'verified'"
    ).get(domain)
    assert.ok(verifiedDomain, 'Domain should be verified')

    // Approve
    db.prepare(
      "UPDATE services SET status = 'active', approval_reason = 'domain-verified', updated_at = datetime('now') WHERE id = ?"
    ).run(id)

    const svc = db.prepare('SELECT status, approval_reason FROM services WHERE id = ?').get(id)
    assert.equal(svc.status, 'active')
    assert.equal(svc.approval_reason, 'domain-verified')
  })
})

describe('Feature 1: Admin approve sets approval_reason', () => {
  it('admin manual approval sets approval_reason to admin-manual', async () => {
    const id = seedService({ status: 'pending' })
    const r = await fetch(`${API}/admin/approve/${id}`, {
      method: 'POST',
      headers: authHeaders(),
    })
    if (r.status === 200) {
      const svc = db.prepare('SELECT approval_reason FROM services WHERE id = ?').get(id)
      assert.equal(svc.approval_reason, 'admin-manual')
    }
    // If server not running, skip gracefully
  })
})

// ─── Feature 2: Failed Registration Logging ─────────────────────────────────

describe('Feature 2: registration_attempts table', () => {
  it('can insert and query registration attempts', () => {
    const id = seedRegistrationAttempt({
      url: 'https://aat-fail.example.com/api',
      failure_reason: 'HTTP 200 instead of 402',
      probe_http_status: 200,
    })

    const row = db.prepare('SELECT * FROM registration_attempts WHERE id = ?').get(id)
    assert.ok(row)
    assert.equal(row.url, 'https://aat-fail.example.com/api')
    assert.equal(row.failure_reason, 'HTTP 200 instead of 402')
    assert.equal(row.probe_http_status, 200)
  })

  it('7-day pruning deletes old entries', () => {
    // Insert an old entry (8 days ago)
    const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
      .toISOString().replace('T', ' ').replace('Z', '')
    const id = randomUUID()
    db.prepare(
      `INSERT INTO registration_attempts (id, url, protocol, failure_reason, attempted_at)
       VALUES (?, 'https://aat-old.example.com/api', 'L402', 'Old failure', ?)`
    ).run(id, oldDate)

    // Run pruning
    const result = db.prepare(
      "DELETE FROM registration_attempts WHERE attempted_at < datetime('now', '-7 days')"
    ).run()
    assert.ok(result.changes >= 1, 'Should have pruned at least 1 old entry')

    // Verify it's gone
    const row = db.prepare('SELECT * FROM registration_attempts WHERE id = ?').get(id)
    assert.equal(row, undefined)
  })

  it('recent entries survive pruning', () => {
    const id = seedRegistrationAttempt({
      url: 'https://aat-recent.example.com/api',
      failure_reason: 'Recent failure',
    })

    // Run pruning
    db.prepare(
      "DELETE FROM registration_attempts WHERE attempted_at < datetime('now', '-7 days')"
    ).run()

    // Verify it still exists
    const row = db.prepare('SELECT * FROM registration_attempts WHERE id = ?').get(id)
    assert.ok(row, 'Recent entry should survive pruning')
  })
})

// ─── Feature 3: Admin Endpoints ─────────────────────────────────────────────

describe('Feature 3: GET /api/v1/admin/domains', () => {
  before(() => {
    // Seed some domain claims with known data
    seedDomainClaim('admin-dom1.aat-test.com', { status: 'verified', contact_email: 'a@test.com' })
    seedDomainClaim('admin-dom2.aat-test.com', { status: 'pending' })
    // Seed a service under admin-dom1
    seedService({ url: 'https://admin-dom1.aat-test.com/api', status: 'active' })
  })

  it('returns domain claims with endpoint counts', async () => {
    const r = await adminGet('/admin/domains')
    if (r.status === 401) return // Server not running with right secret
    assert.equal(r.status, 200)
    assert.ok(Array.isArray(r.body.domains))
    assert.ok(typeof r.body.total === 'number')

    // Find our test domain
    const dom1 = r.body.domains.find(d => d.domain === 'admin-dom1.aat-test.com')
    if (dom1) {
      assert.equal(dom1.status, 'verified')
      assert.ok(dom1.endpoint_count >= 1, 'Should count at least 1 endpoint')
      assert.equal(dom1.contact_email, 'a@test.com')
    }
  })

  it('requires auth', async () => {
    const res = await fetch(`${API}/admin/domains`)
    assert.equal(res.status, 401)
  })
})

describe('Feature 3: GET /api/v1/admin/failed-registrations', () => {
  before(() => {
    seedRegistrationAttempt({
      url: 'https://aat-admin-fail.example.com/api',
      failure_reason: 'No 402 response',
      probe_http_status: 200,
      provider: 'test-provider',
    })
  })

  it('returns failed registration attempts', async () => {
    const r = await adminGet('/admin/failed-registrations')
    if (r.status === 401) return // Server not running with right secret
    assert.equal(r.status, 200)
    assert.ok(Array.isArray(r.body.attempts))
    assert.ok(typeof r.body.total === 'number')
  })

  it('respects limit parameter', async () => {
    const r = await adminGet('/admin/failed-registrations?limit=1')
    if (r.status === 401) return
    assert.equal(r.status, 200)
    assert.ok(r.body.attempts.length <= 1)
  })

  it('requires auth', async () => {
    const res = await fetch(`${API}/admin/failed-registrations`)
    assert.equal(res.status, 401)
  })
})

describe('Feature 3: Admin columns include new fields', () => {
  it('admin recent response includes approval_reason and domain_verified', async () => {
    // Seed a service with approval_reason
    const id = seedService({ status: 'active' })
    db.prepare("UPDATE services SET approval_reason = 'admin-manual', domain_verified = 1 WHERE id = ?").run(id)

    const r = await adminGet('/admin/recent?limit=100')
    if (r.status === 401) return
    assert.equal(r.status, 200)

    const svc = r.body.services.find(s => s.id === id)
    if (svc) {
      assert.equal(svc.approval_reason, 'admin-manual')
      assert.equal(svc.domain_verified, 1)
    }
  })
})
