import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { resetProvider } from '../src/services/l402-provider.js'
import { verifyL402 } from '../src/middleware/l402.js'

describe('verifyL402 middleware', () => {
  let originalEnv

  beforeEach(() => {
    originalEnv = { ...process.env }
    process.env.L402_GATEWAY = 'mock'
    delete process.env.NODE_ENV
    resetProvider()
  })

  afterEach(() => {
    process.env = originalEnv
    resetProvider()
  })

  it('calls next() with no authorization header', async () => {
    let nextCalled = false
    const req = { headers: {} }
    await verifyL402(req, {}, () => { nextCalled = true })
    assert.ok(nextCalled)
    assert.equal(req.l402Verified, undefined)
  })

  it('calls next() for non-L402 authorization headers', async () => {
    let nextCalled = false
    const req = { headers: { authorization: 'Bearer token123' } }
    await verifyL402(req, {}, () => { nextCalled = true })
    assert.ok(nextCalled)
    assert.equal(req.l402Verified, undefined)
  })

  it('sets l402Verified=true for valid L402 token', async () => {
    let nextCalled = false
    const token = 'L402 dGVzdA==:' + 'a'.repeat(64)
    const req = { headers: { authorization: token } }
    await verifyL402(req, {}, () => { nextCalled = true })
    assert.ok(nextCalled)
    assert.equal(req.l402Verified, true)
    assert.ok(req.l402ExpiresAt)
  })

  it('does not set l402Verified for invalid L402 token', async () => {
    let nextCalled = false
    const req = { headers: { authorization: 'L402 badtoken' } }
    await verifyL402(req, {}, () => { nextCalled = true })
    assert.ok(nextCalled)
    assert.equal(req.l402Verified, undefined)
  })

  it('still calls next() if verification throws', async () => {
    let nextCalled = false
    const req = { headers: { authorization: 'L402 ' } }
    await verifyL402(req, {}, () => { nextCalled = true })
    assert.ok(nextCalled)
  })
})
