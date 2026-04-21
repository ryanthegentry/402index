/**
 * Unit tests for admin auth middleware.
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { adminAuth, digestAuth } from '../src/middleware/admin-auth.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const sourceCode = readFileSync(join(__dirname, '../src/middleware/admin-auth.js'), 'utf8')

function mockReqRes(authHeader) {
  const req = { headers: {} }
  if (authHeader !== undefined) req.headers.authorization = authHeader
  let statusCode, jsonBody
  const res = {
    status(code) { statusCode = code; return res },
    json(body) { jsonBody = body; return res },
  }
  return { req, res, getStatus: () => statusCode, getBody: () => jsonBody }
}

describe('adminAuth middleware', () => {
  const originalSecret = process.env.ADMIN_SECRET

  afterEach(() => {
    if (originalSecret !== undefined) {
      process.env.ADMIN_SECRET = originalSecret
    } else {
      delete process.env.ADMIN_SECRET
    }
  })

  it('returns 503 when ADMIN_SECRET not set', () => {
    delete process.env.ADMIN_SECRET
    const { req, res, getStatus, getBody } = mockReqRes('Bearer test')
    adminAuth(req, res, () => { throw new Error('should not call next') })
    assert.equal(getStatus(), 503)
    assert.equal(getBody().error, 'Admin not configured')
  })

  it('returns 401 when no Authorization header', () => {
    process.env.ADMIN_SECRET = 'secret123'
    const { req, res, getStatus, getBody } = mockReqRes(undefined)
    adminAuth(req, res, () => { throw new Error('should not call next') })
    assert.equal(getStatus(), 401)
    assert.equal(getBody().error, 'Unauthorized')
  })

  it('returns 401 when Authorization header is not Bearer', () => {
    process.env.ADMIN_SECRET = 'secret123'
    const { req, res, getStatus, getBody } = mockReqRes('Basic abc123')
    adminAuth(req, res, () => { throw new Error('should not call next') })
    assert.equal(getStatus(), 401)
    assert.equal(getBody().error, 'Unauthorized')
  })

  it('returns 401 when token does not match', () => {
    process.env.ADMIN_SECRET = 'secret123'
    const { req, res, getStatus, getBody } = mockReqRes('Bearer wrong-token')
    adminAuth(req, res, () => { throw new Error('should not call next') })
    assert.equal(getStatus(), 401)
    assert.equal(getBody().error, 'Unauthorized')
  })

  it('calls next() when token matches', () => {
    process.env.ADMIN_SECRET = 'secret123'
    const { req, res } = mockReqRes('Bearer secret123')
    let called = false
    adminAuth(req, res, () => { called = true })
    assert.ok(called, 'next() should have been called')
  })

  it('uses timing-safe comparison to prevent timing attacks', () => {
    assert.ok(
      sourceCode.includes('constantTimeEqual'),
      'adminAuth must use constantTimeEqual for token comparison'
    )
    assert.ok(
      sourceCode.includes("from '../util/constant-time.js'"),
      'adminAuth must import constantTimeEqual from util/constant-time.js'
    )
    assert.ok(
      !sourceCode.match(/token\s*!==\s*secret/),
      'must not use direct string comparison (token !== secret)'
    )
  })
})

describe('digestAuth middleware', () => {
  const originalKey = process.env.DIGEST_API_KEY

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.DIGEST_API_KEY = originalKey
    } else {
      delete process.env.DIGEST_API_KEY
    }
  })

  it('returns 503 when DIGEST_API_KEY not set', () => {
    delete process.env.DIGEST_API_KEY
    const { req, res, getStatus, getBody } = mockReqRes('Bearer test')
    digestAuth(req, res, () => { throw new Error('should not call next') })
    assert.equal(getStatus(), 503)
    assert.equal(getBody().error, 'Digest API not configured')
  })

  it('returns 401 when token does not match', () => {
    process.env.DIGEST_API_KEY = 'digest-secret'
    const { req, res, getStatus, getBody } = mockReqRes('Bearer wrong')
    digestAuth(req, res, () => { throw new Error('should not call next') })
    assert.equal(getStatus(), 401)
  })

  it('calls next() when token matches', () => {
    process.env.DIGEST_API_KEY = 'digest-secret'
    const { req, res } = mockReqRes('Bearer digest-secret')
    let called = false
    digestAuth(req, res, () => { called = true })
    assert.ok(called)
  })

  it('uses timing-safe comparison to prevent timing attacks', () => {
    assert.ok(
      sourceCode.includes('constantTimeEqual'),
      'digestAuth must use constantTimeEqual for token comparison'
    )
    assert.ok(
      sourceCode.includes("from '../util/constant-time.js'"),
      'digestAuth must import constantTimeEqual from util/constant-time.js'
    )
  })
})
