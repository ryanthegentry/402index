/**
 * Tests for admin HTML page server-side auth gate (GitHub issue #14).
 *
 * The admin page at /admin must use adminAuth middleware so that
 * unauthenticated requests get 401 (not the dashboard markup).
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer, stopServer } from './helpers/server.js'
import { adminAuth } from '../src/middleware/admin-auth.js'
import { adminPage } from '../src/views/admin.js'

let BASE = process.env.API_BASE

// ─── adminAuth middleware unit tests (used by /admin route) ──────────────────

describe('Admin page auth gate (issue #14)', () => {
  const originalSecret = process.env.ADMIN_SECRET

  before(async () => {
    BASE = BASE || await startServer()
  })

  after(async () => {
    // Restore original env
    if (originalSecret !== undefined) {
      process.env.ADMIN_SECRET = originalSecret
    } else {
      delete process.env.ADMIN_SECRET
    }
    await stopServer()
  })

  describe('adminAuth middleware rejects unauthenticated requests', () => {
    before(() => {
      process.env.ADMIN_SECRET = 'test-secret-123'
    })

    it('returns 401 JSON when no Authorization header is present', () => {
      const req = { headers: {} }
      let statusCode, body
      const res = {
        status(code) { statusCode = code; return this },
        json(data) { body = data },
      }
      adminAuth(req, res, () => { throw new Error('next() should not be called') })
      assert.equal(statusCode, 401)
      assert.deepEqual(body, { error: 'Unauthorized' })
    })

    it('returns 401 JSON when Authorization header has wrong token', () => {
      const req = { headers: { authorization: 'Bearer wrong-token' } }
      let statusCode, body
      const res = {
        status(code) { statusCode = code; return this },
        json(data) { body = data },
      }
      adminAuth(req, res, () => { throw new Error('next() should not be called') })
      assert.equal(statusCode, 401)
      assert.deepEqual(body, { error: 'Unauthorized' })
    })

    it('returns 401 when Authorization header is not Bearer scheme', () => {
      const req = { headers: { authorization: 'Basic dXNlcjpwYXNz' } }
      let statusCode, body
      const res = {
        status(code) { statusCode = code; return this },
        json(data) { body = data },
      }
      adminAuth(req, res, () => { throw new Error('next() should not be called') })
      assert.equal(statusCode, 401)
      assert.deepEqual(body, { error: 'Unauthorized' })
    })

    it('returns 503 when ADMIN_SECRET is not configured', () => {
      delete process.env.ADMIN_SECRET
      const req = { headers: { authorization: 'Bearer anything' } }
      let statusCode, body
      const res = {
        status(code) { statusCode = code; return this },
        json(data) { body = data },
      }
      adminAuth(req, res, () => { throw new Error('next() should not be called') })
      assert.equal(statusCode, 503)
      assert.deepEqual(body, { error: 'Admin not configured' })
      // Restore for remaining tests
      process.env.ADMIN_SECRET = 'test-secret-123'
    })

    it('calls next() when Authorization header has valid token', () => {
      const req = { headers: { authorization: 'Bearer test-secret-123' } }
      const res = {
        status() { throw new Error('status() should not be called') },
        json() { throw new Error('json() should not be called') },
      }
      let nextCalled = false
      adminAuth(req, res, () => { nextCalled = true })
      assert.ok(nextCalled, 'next() should be called for valid auth')
    })
  })

  describe('adminPage() renders dashboard for authenticated users', () => {
    it('includes dashboard markup', () => {
      const html = adminPage()
      assert.ok(html.includes('id="dashboard"'), 'should include dashboard')
      assert.ok(html.includes('id="panel-pending"'), 'should include pending panel')
    })
  })

  describe('route does not serve dashboard to unauthenticated requests', () => {
    it('adminAuth blocks before adminPage() is reached — no cookie fallback', () => {
      // Verify there is no cookie-based auth path: adminAuth only checks
      // Authorization: Bearer header, so cookie-only requests are rejected
      const req = { headers: { cookie: 'admin_token=test-secret-123' } }
      let statusCode, body
      const res = {
        status(code) { statusCode = code; return this },
        json(data) { body = data },
      }
      adminAuth(req, res, () => { throw new Error('next() should not be called') })
      assert.equal(statusCode, 401, 'cookie-only auth must not work')
    })
  })

  describe('no dead code from prior revisions', () => {
    it('adminLoginPage is not exported from admin view', async () => {
      const adminViews = await import('../src/views/admin.js')
      assert.equal(adminViews.adminLoginPage, undefined,
        'adminLoginPage should have been removed — it was dead code from revision 1')
    })

    it('constantTimeEqual is not exported from admin-auth middleware', async () => {
      const authModule = await import('../src/middleware/admin-auth.js')
      assert.equal(authModule.constantTimeEqual, undefined,
        'constantTimeEqual should not be exported — only used internally')
    })

    it('adminPage client JS does not set cookies', () => {
      const html = adminPage()
      assert.ok(!html.includes('document.cookie'),
        'admin page should not set cookies — server auth uses Bearer tokens only')
    })
  })

  describe('GET /admin integration (requires running server)', () => {
    it('GET /admin with valid Bearer token → 200 with admin dashboard HTML', async () => {
      const secret = process.env.ADMIN_SECRET
      if (!secret) return // skip if no server configured
      const res = await fetch(`${BASE}/admin`, {
        headers: { 'Authorization': `Bearer ${secret}` },
      })
      assert.equal(res.status, 200)
      const html = await res.text()
      assert.ok(html.includes('id="dashboard"'), 'response should contain dashboard markup')
      assert.ok(html.includes('id="panel-pending"'), 'response should contain pending panel')
    })
  })
})
