// Remove in v1.0.0
// Tests that deprecated Golem aliases still function for backwards compatibility.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { getProvider, resetProvider } from '../src/services/l402-provider.js'

describe('partner-gateway-deprecation (remove in v1.0.0)', () => {
  let originalEnv

  beforeEach(() => {
    originalEnv = { ...process.env }
    resetProvider()
  })

  afterEach(() => {
    process.env = originalEnv
    resetProvider()
  })

  it('L402_GATEWAY=golem + GOLEM_API_KEY creates a provider (deprecated env path)', () => {
    process.env.L402_GATEWAY = 'golem'
    process.env.GOLEM_API_KEY = 'test-key-deprecated'
    const provider = getProvider()
    assert.ok(provider, 'deprecated golem gateway should still create a provider')
  })

  it('GOLEM_API_KEY fallback works when PARTNER_GATEWAY_API_KEY is unset', () => {
    process.env.L402_GATEWAY = 'partner'
    delete process.env.PARTNER_GATEWAY_API_KEY
    process.env.GOLEM_API_KEY = 'test-key-fallback'
    const provider = getProvider()
    assert.ok(provider, 'should fall back to GOLEM_API_KEY')
  })

  it('GOLEM_INTERNAL_URL fallback works when PARTNER_GATEWAY_URL is unset', () => {
    process.env.L402_GATEWAY = 'partner'
    process.env.PARTNER_GATEWAY_API_KEY = 'test-key'
    delete process.env.PARTNER_GATEWAY_URL
    process.env.GOLEM_INTERNAL_URL = 'http://legacy.railway.internal:8402'
    const provider = getProvider()
    assert.ok(provider, 'should fall back to GOLEM_INTERNAL_URL')
  })
})
