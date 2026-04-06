/**
 * Admin endpoint tests for /api/v1/admin/*
 *
 * Run: ADMIN_SECRET=test-secret node --test test/admin.test.js
 *
 * Requires a running server with ADMIN_SECRET=test-secret
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer, stopServer } from './helpers/server.js'

let BASE = process.env.API_BASE
let API
const SECRET = process.env.ADMIN_SECRET || 'test-secret'

before(async () => { BASE = BASE || await startServer(); API = `${BASE}/api/v1` })
after(async () => { await stopServer() })

async function adminGet(path) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Authorization': `Bearer ${SECRET}` },
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

async function adminPost(path) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SECRET}` },
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

// ─── Auth Tests ─────────────────────────────────────────────────────────────

describe('Admin Auth', () => {
  it('rejects request with no auth header → 401', async () => {
    const res = await fetch(`${API}/admin/pending`)
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'Unauthorized')
  })

  it('rejects request with wrong token → 401', async () => {
    const res = await fetch(`${API}/admin/pending`, {
      headers: { 'Authorization': 'Bearer wrong-token' },
    })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'Unauthorized')
  })

  it('accepts request with correct token → 200', async () => {
    const r = await adminGet('/admin/pending')
    assert.equal(r.status, 200)
    assert.ok(Array.isArray(r.body.services))
  })
})

// ─── Pending List ───────────────────────────────────────────────────────────

describe('GET /api/v1/admin/pending', () => {
  it('returns array of pending services', async () => {
    const r = await adminGet('/admin/pending')
    assert.equal(r.status, 200)
    assert.ok(Array.isArray(r.body.services))
    assert.equal(typeof r.body.total, 'number')
  })
})

// ─── Approve / Reject ───────────────────────────────────────────────────────

describe('Admin approve/reject', () => {
  it('approve non-existent ID → 404', async () => {
    const r = await adminPost('/admin/approve/nonexistent-id-12345')
    assert.equal(r.status, 404)
    assert.ok(r.body.error.includes('No pending'))
  })

  it('reject non-existent ID → 404', async () => {
    const r = await adminPost('/admin/reject/nonexistent-id-12345')
    assert.equal(r.status, 404)
    assert.ok(r.body.error.includes('No pending'))
  })
})
