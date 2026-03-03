import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { getProvider, resetProvider } from '../src/services/l402-provider.js'

describe('l402-provider', () => {
  let originalEnv

  beforeEach(() => {
    originalEnv = { ...process.env }
    resetProvider()
  })

  afterEach(() => {
    process.env = originalEnv
    resetProvider()
  })

  describe('getProvider (stub)', () => {
    it('returns StubL402Provider by default (L402_GATEWAY unset)', async () => {
      delete process.env.L402_GATEWAY
      const provider = getProvider()
      const challenge = await provider.createChallenge()
      assert.equal(challenge, null)
      const verify = await provider.verifyToken('L402 test:abc')
      assert.deepEqual(verify, { valid: false })
    })

    it('returns StubL402Provider for unknown gateway', async () => {
      process.env.L402_GATEWAY = 'none'
      const provider = getProvider()
      const challenge = await provider.createChallenge()
      assert.equal(challenge, null)
    })
  })

  describe('MockL402Provider', () => {
    it('creates a challenge with macaroon and invoice', async () => {
      process.env.L402_GATEWAY = 'mock'
      delete process.env.NODE_ENV
      const provider = getProvider()
      const challenge = await provider.createChallenge(500, 24)
      assert.ok(challenge.macaroon)
      assert.ok(challenge.invoice)
      assert.ok(challenge.invoice.includes('500'))
      assert.ok(challenge.paymentHash)
      assert.equal(challenge.paymentHash.length, 64)
    })

    it('verifies well-formed L402 tokens', async () => {
      process.env.L402_GATEWAY = 'mock'
      delete process.env.NODE_ENV
      const provider = getProvider()
      const token = 'L402 dGVzdA==:' + 'a'.repeat(64)
      const result = await provider.verifyToken(token)
      assert.equal(result.valid, true)
      assert.ok(result.expiresAt)
    })

    it('rejects malformed L402 tokens', async () => {
      process.env.L402_GATEWAY = 'mock'
      delete process.env.NODE_ENV
      const provider = getProvider()
      const result = await provider.verifyToken('L402 garbage')
      assert.equal(result.valid, false)
    })

    it('rejects tokens without L402 prefix', async () => {
      process.env.L402_GATEWAY = 'mock'
      delete process.env.NODE_ENV
      const provider = getProvider()
      const result = await provider.verifyToken('Bearer abc123')
      assert.equal(result.valid, false)
    })

    it('throws in production mode', () => {
      process.env.L402_GATEWAY = 'mock'
      process.env.NODE_ENV = 'production'
      assert.throws(() => getProvider(), /production/)
    })
  })

  describe('GolemL402Provider', () => {
    it('throws if GOLEM_API_KEY is not set', () => {
      process.env.L402_GATEWAY = 'golem'
      delete process.env.GOLEM_API_KEY
      assert.throws(() => getProvider(), /GOLEM_API_KEY/)
    })

    it('constructs successfully with GOLEM_API_KEY set', () => {
      process.env.L402_GATEWAY = 'golem'
      process.env.GOLEM_API_KEY = 'test-key-123'
      const provider = getProvider()
      assert.ok(provider)
    })
  })
})
