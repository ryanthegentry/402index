/**
 * Integration tests for admin dashboard v2:
 *   GET  /api/v1/admin/recent
 *   GET  /api/v1/admin/search?q=...
 *   DELETE /api/v1/admin/services/:id
 *
 * Existing endpoints are regression-tested for auth and shape:
 *   GET  /api/v1/admin/pending
 *   POST /api/v1/admin/approve/:id
 *   POST /api/v1/admin/reject/:id
 *
 * Requirements:
 *   - Running server: npm start or npm run dev (default: http://localhost:3402)
 *   - ADMIN_SECRET env var set (must match server's ADMIN_SECRET)
 *
 * Usage:
 *   ADMIN_SECRET=mysecret node --test test/admin-dashboard.test.js
 *   ADMIN_SECRET=mysecret API_BASE=http://localhost:3402 node --test test/admin-dashboard.test.js
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
// Use the project's own db singleton — avoids native module resolution issues
// from the test/ subdirectory and reuses the same connection as the server.
import db from '../src/db.js'

const BASE = process.env.API_BASE || 'http://localhost:3402'
const API = `${BASE}/api/v1`
const SECRET = process.env.ADMIN_SECRET

// ─── Helpers ─────────────────────────────────────────────────────────────────

function authHeaders(secret = SECRET) {
  return { 'Authorization': `Bearer ${secret}` }
}

async function adminFetch(path, opts = {}, secret = SECRET) {
  return fetch(`${API}${path}`, {
    ...opts,
    headers: { ...opts.headers, ...authHeaders(secret) },
  })
}

const TEST_IDS = []

function seedService(overrides = {}) {
  const id = `test-${Math.random().toString(36).slice(2)}`
  const now = new Date().toISOString().replace('T', ' ').replace('Z', '')
  db.prepare(`
    INSERT INTO services (id, name, url, protocol, source, status, provider, category,
                          price_sats, payment_asset, payment_network, registered_at, updated_at)
    VALUES (@id, @name, @url, @protocol, @source, @status, @provider, @category,
            @price_sats, @payment_asset, @payment_network, @registered_at, @updated_at)
  `).run({
    id,
    name: overrides.name ?? `Test Service ${id}`,
    url: overrides.url ?? `https://test-${id}.example.com/api`,
    protocol: overrides.protocol ?? 'L402',
    source: overrides.source ?? 'self-registered',
    status: overrides.status ?? 'active',
    provider: overrides.provider ?? 'golem-gateway',
    category: overrides.category ?? 'test',
    price_sats: overrides.price_sats ?? 100,
    payment_asset: overrides.payment_asset ?? 'BTC',
    payment_network: overrides.payment_network ?? 'Lightning',
    registered_at: overrides.registered_at ?? now,
    updated_at: now,
  })
  TEST_IDS.push(id)
  return id
}

function cleanupTestServices() {
  for (const id of TEST_IDS) {
    try {
      db.prepare('DELETE FROM health_checks WHERE service_id = ?').run(id)
      db.prepare('DELETE FROM services WHERE id = ?').run(id)
    } catch { /* ignore */ }
  }
  TEST_IDS.length = 0
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

let activeId, pendingId, rejectedId

before(async () => {
  if (!SECRET) {
    console.error('ADMIN_SECRET env var not set — admin auth tests will fail 503')
  }

  // Seed three services with different statuses
  activeId = seedService({ name: 'AdminTest Active', status: 'active' })
  pendingId = seedService({ name: 'AdminTest Pending', status: 'pending' })
  rejectedId = seedService({ name: 'AdminTest Rejected', status: 'rejected' })
})

after(() => {
  cleanupTestServices()
  // Don't close — db.js is a shared singleton used by the server process too
})

// ─── Auth: all admin routes require Bearer token ──────────────────────────────

describe('Admin auth — all new routes require Authorization: Bearer', () => {
  it('GET /admin/recent returns 401 without auth', async () => {
    const res = await fetch(`${API}/admin/recent`)
    assert.equal(res.status, 401)
  })

  it('GET /admin/recent returns 503 with no secret configured (bad token)', async () => {
    // With a wrong token, server returns 401
    const res = await fetch(`${API}/admin/recent`, {
      headers: { 'Authorization': 'Bearer wrong-token' },
    })
    assert.ok(res.status === 401 || res.status === 503, `expected 401 or 503, got ${res.status}`)
  })

  it('GET /admin/search returns 401 without auth', async () => {
    const res = await fetch(`${API}/admin/search?q=test`)
    assert.equal(res.status, 401)
  })

  it('DELETE /admin/services/:id returns 401 without auth', async () => {
    const res = await fetch(`${API}/admin/services/${activeId}`, { method: 'DELETE' })
    assert.equal(res.status, 401)
  })
})

// ─── GET /admin/recent ────────────────────────────────────────────────────────

describe('GET /api/v1/admin/recent', () => {
  it('returns 200 with valid auth', async () => {
    const res = await adminFetch('/admin/recent')
    assert.equal(res.status, 200)
  })

  it('response has services array and total', async () => {
    const res = await adminFetch('/admin/recent')
    const data = await res.json()
    assert.ok(Array.isArray(data.services), 'services should be array')
    assert.equal(typeof data.total, 'number')
  })

  it('includes services of all statuses (active, pending, rejected)', async () => {
    const res = await adminFetch('/admin/recent?limit=100')
    const data = await res.json()
    const ids = data.services.map(s => s.id)
    assert.ok(ids.includes(activeId), 'should include active test service')
    assert.ok(ids.includes(pendingId), 'should include pending test service')
    assert.ok(ids.includes(rejectedId), 'should include rejected test service')
  })

  it('is sorted newest first', async () => {
    const res = await adminFetch('/admin/recent?limit=100')
    const data = await res.json()
    const dates = data.services.map(s => s.registered_at)
    for (let i = 1; i < dates.length; i++) {
      assert.ok(
        dates[i - 1] >= dates[i],
        `services should be sorted newest first: ${dates[i - 1]} < ${dates[i]}`
      )
    }
  })

  it('respects limit param', async () => {
    const res = await adminFetch('/admin/recent?limit=2')
    const data = await res.json()
    assert.ok(data.services.length <= 2, `expected max 2 services, got ${data.services.length}`)
  })

  it('each service includes id, name, url, status, protocol fields', async () => {
    const res = await adminFetch('/admin/recent?limit=5')
    const data = await res.json()
    if (data.services.length === 0) return // nothing to check
    const s = data.services[0]
    for (const field of ['id', 'name', 'url', 'status', 'protocol']) {
      assert.ok(field in s, `service should have field: ${field}`)
    }
  })
})

// ─── GET /admin/search ────────────────────────────────────────────────────────

describe('GET /api/v1/admin/search', () => {
  it('returns 200 with valid auth and q param', async () => {
    const res = await adminFetch('/admin/search?q=AdminTest')
    assert.equal(res.status, 200)
  })

  it('returns 400 when q param is missing', async () => {
    const res = await adminFetch('/admin/search')
    assert.equal(res.status, 400)
  })

  it('returns 400 when q param is empty string', async () => {
    const res = await adminFetch('/admin/search?q=')
    assert.equal(res.status, 400)
  })

  it('response has services array and total', async () => {
    const res = await adminFetch('/admin/search?q=AdminTest')
    const data = await res.json()
    assert.ok(Array.isArray(data.services))
    assert.equal(typeof data.total, 'number')
  })

  it('matches by name', async () => {
    const res = await adminFetch('/admin/search?q=AdminTest+Active')
    const data = await res.json()
    const ids = data.services.map(s => s.id)
    assert.ok(ids.includes(activeId), 'should find service by name')
  })

  it('matches by URL', async () => {
    const activeService = db.prepare('SELECT url FROM services WHERE id = ?').get(activeId)
    const urlSlug = activeService.url.split('/')[2].slice(0, 15) // hostname prefix
    const res = await adminFetch(`/admin/search?q=${encodeURIComponent(urlSlug)}`)
    const data = await res.json()
    const ids = data.services.map(s => s.id)
    assert.ok(ids.includes(activeId), 'should find service by URL')
  })

  it('matches by provider', async () => {
    const res = await adminFetch('/admin/search?q=golem-gateway')
    const data = await res.json()
    // All our test services use golem-gateway as provider
    const ids = data.services.map(s => s.id)
    assert.ok(ids.includes(activeId), 'should find service by provider')
  })

  it('matches across all statuses (active, pending, rejected)', async () => {
    const res = await adminFetch('/admin/search?q=AdminTest&limit=100')
    const data = await res.json()
    const ids = data.services.map(s => s.id)
    assert.ok(ids.includes(activeId), 'should include active')
    assert.ok(ids.includes(pendingId), 'should include pending')
    assert.ok(ids.includes(rejectedId), 'should include rejected')
  })

  it('returns empty array for no-match query', async () => {
    const res = await adminFetch('/admin/search?q=xyzzy-definitely-no-match-12345')
    const data = await res.json()
    assert.ok(Array.isArray(data.services))
    assert.equal(data.services.length, 0)
    assert.equal(data.total, 0)
  })

  it('respects limit param', async () => {
    const res = await adminFetch('/admin/search?q=test&limit=1')
    const data = await res.json()
    assert.ok(data.services.length <= 1)
  })
})

// ─── DELETE /admin/services/:id ───────────────────────────────────────────────

describe('DELETE /api/v1/admin/services/:id', () => {
  it('returns 404 for nonexistent id', async () => {
    const res = await adminFetch('/admin/services/nonexistent-id-xyz', { method: 'DELETE' })
    assert.equal(res.status, 404)
  })

  it('returns 200 and deletes an active service', async () => {
    const deleteId = seedService({ name: 'AdminTest Delete Active', status: 'active' })
    const res = await adminFetch(`/admin/services/${deleteId}`, { method: 'DELETE' })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.deleted, true)
    assert.equal(data.id, deleteId)
    // Verify it's gone from DB
    const row = db.prepare('SELECT id FROM services WHERE id = ?').get(deleteId)
    assert.equal(row, undefined, 'service should be gone from DB')
  })

  it('returns 200 and deletes a pending service', async () => {
    const deleteId = seedService({ name: 'AdminTest Delete Pending', status: 'pending' })
    const res = await adminFetch(`/admin/services/${deleteId}`, { method: 'DELETE' })
    assert.equal(res.status, 200)
    const row = db.prepare('SELECT id FROM services WHERE id = ?').get(deleteId)
    assert.equal(row, undefined)
  })

  it('returns 200 and deletes a rejected service', async () => {
    const deleteId = seedService({ name: 'AdminTest Delete Rejected', status: 'rejected' })
    const res = await adminFetch(`/admin/services/${deleteId}`, { method: 'DELETE' })
    assert.equal(res.status, 200)
    const row = db.prepare('SELECT id FROM services WHERE id = ?').get(deleteId)
    assert.equal(row, undefined)
  })

  it('second delete of same id returns 404', async () => {
    const deleteId = seedService({ name: 'AdminTest Delete Twice', status: 'active' })
    await adminFetch(`/admin/services/${deleteId}`, { method: 'DELETE' })
    const res2 = await adminFetch(`/admin/services/${deleteId}`, { method: 'DELETE' })
    assert.equal(res2.status, 404)
  })

  it('deleted service no longer appears in /admin/recent', async () => {
    const deleteId = seedService({ name: 'AdminTest Delete Recent', status: 'active' })
    await adminFetch(`/admin/services/${deleteId}`, { method: 'DELETE' })
    const res = await adminFetch('/admin/recent?limit=100')
    const data = await res.json()
    const ids = data.services.map(s => s.id)
    assert.ok(!ids.includes(deleteId), 'deleted service should not appear in recent')
  })

  it('deleted service no longer appears in /admin/search', async () => {
    const deleteId = seedService({ name: 'AdminTest DeleteSearch Unique', status: 'active' })
    await adminFetch(`/admin/services/${deleteId}`, { method: 'DELETE' })
    const res = await adminFetch('/admin/search?q=AdminTest+DeleteSearch+Unique')
    const data = await res.json()
    assert.equal(data.services.length, 0, 'deleted service should not appear in search')
  })
})

// ─── Regression: existing admin endpoints unchanged ──────────────────────────

describe('Regression: GET /api/v1/admin/pending (unchanged)', () => {
  it('returns 200 with valid auth', async () => {
    const res = await adminFetch('/admin/pending')
    assert.equal(res.status, 200)
  })

  it('response shape unchanged: { services, total }', async () => {
    const res = await adminFetch('/admin/pending')
    const data = await res.json()
    assert.ok(Array.isArray(data.services))
    assert.equal(typeof data.total, 'number')
  })

  it('includes seeded pending service', async () => {
    const res = await adminFetch('/admin/pending')
    const data = await res.json()
    const ids = data.services.map(s => s.id)
    assert.ok(ids.includes(pendingId), 'seeded pending service should appear in pending list')
  })

  it('returns 401 without auth', async () => {
    const res = await fetch(`${API}/admin/pending`)
    assert.equal(res.status, 401)
  })
})

describe('Regression: POST /api/v1/admin/approve/:id (unchanged)', () => {
  it('approves a pending service', async () => {
    const approveId = seedService({ name: 'AdminTest Approve', status: 'pending' })
    const res = await adminFetch(`/admin/approve/${approveId}`, { method: 'POST' })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.ok('message' in data || 'id' in data, 'response should have message or id')
    // Verify status changed in DB
    const row = db.prepare('SELECT status FROM services WHERE id = ?').get(approveId)
    assert.equal(row?.status, 'active')
  })

  it('returns 404 for non-pending service', async () => {
    const res = await adminFetch(`/admin/approve/${activeId}`, { method: 'POST' })
    // active service can't be approved again — should 404
    assert.equal(res.status, 404)
  })

  it('returns 401 without auth', async () => {
    const res = await fetch(`${API}/admin/approve/${pendingId}`, { method: 'POST' })
    assert.equal(res.status, 401)
  })
})

describe('Regression: POST /api/v1/admin/reject/:id (unchanged)', () => {
  it('rejects a pending service', async () => {
    const rejectId = seedService({ name: 'AdminTest Reject', status: 'pending' })
    const res = await adminFetch(`/admin/reject/${rejectId}`, { method: 'POST' })
    assert.equal(res.status, 200)
    const row = db.prepare('SELECT status FROM services WHERE id = ?').get(rejectId)
    assert.equal(row?.status, 'rejected')
  })

  it('returns 404 for non-pending service', async () => {
    const res = await adminFetch(`/admin/reject/${activeId}`, { method: 'POST' })
    assert.equal(res.status, 404)
  })

  it('returns 401 without auth', async () => {
    const res = await fetch(`${API}/admin/reject/${pendingId}`, { method: 'POST' })
    assert.equal(res.status, 401)
  })
})
