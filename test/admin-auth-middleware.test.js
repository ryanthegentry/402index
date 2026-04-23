/**
 * Tests for the adminAuth middleware (mounted on /api/v1/admin/* at
 * src/server.js:97) and the adminPage() view renderer.
 *
 * The /admin HTML route is intentionally OPEN — no Bearer middleware.
 * See src/routes/pages.js (the "Admin dashboard — auth is client-side"
 * comment block) and PR #197 (issue #194) for rationale. Do NOT add
 * server-side Bearer auth to /admin — browsers don't send Bearer on
 * plain GET, and the route would be unreachable.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { startServer, stopServer } from './helpers/server.js'
import { adminAuth } from '../src/middleware/admin-auth.js'
import { adminPage } from '../src/views/admin.js'

// ─── repo-meta: file naming + header accuracy (issue #210) ──────────────────

describe('repo-meta: file naming + header accuracy', () => {
  const thisFile = fileURLToPath(import.meta.url)
  const contents = readFileSync(thisFile, 'utf-8')
  const header = contents.slice(0, 800)

  it('filename matches content: admin-auth-middleware.test.js', () => {
    assert.ok(
      thisFile.endsWith('admin-auth-middleware.test.js'),
      `expected filename to end with admin-auth-middleware.test.js, got ${thisFile}`
    )
  })

  it('header does not misframe the route', () => {
    // Split stale string so this assertion doesn't self-match when reading own source
    const staleHeader = 'must use adminAuth' + ' middleware'
    assert.ok(
      !header.includes(staleHeader),
      'header should not claim /admin must use adminAuth middleware'
    )
    assert.ok(
      header.includes('intentionally OPEN'),
      'header should state /admin is intentionally OPEN'
    )
  })

  it('section comment fixed', () => {
    // Split stale string so this assertion doesn't self-match
    const staleComment = 'adminAuth middleware unit tests (used by' + ' /admin route)'
    assert.ok(
      !contents.includes(staleComment),
      'should not contain stale section comment referencing /admin route'
    )
  })

  it('describe label fixed', () => {
    // Split stale string so this assertion doesn't self-match
    const staleLabel = 'Admin page auth gate' + ' (issue #14)'
    assert.ok(
      !contents.includes(staleLabel),
      'should not contain stale describe label'
    )
    assert.ok(
      contents.includes('adminAuth middleware + adminPage() rendering'),
      'should contain updated describe label'
    )
  })
})

let BASE = process.env.API_BASE

// ─── adminAuth middleware unit tests (used on /api/v1/admin/* endpoints) ─────

describe('adminAuth middleware + adminPage() rendering (issue #198)', () => {
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

  describe('GET /admin integration (requires running server)', () => {
    it('GET /admin → 200 with auth-gate markup (no Bearer required)', async () => {
      const res = await fetch(`${BASE}/admin`)
      assert.equal(res.status, 200)
      const html = await res.text()
      assert.ok(html.includes('id="auth-gate"'), 'response should contain auth-gate markup')
      assert.ok(html.includes('id="secret-input"'), 'response should contain secret-input field')
    })
  })
})
