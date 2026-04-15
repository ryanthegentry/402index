import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { verifiedBadge } from '../src/views/helpers.js'

describe('verifiedBadge', () => {
  it('returns filled shield for domain_verified service', () => {
    const html = verifiedBadge({ domain_verified: 1, x402_payment_valid: 1, health_status: 'healthy' })
    assert.ok(html.includes('badge-verified-domain'), 'should have domain badge class')
    assert.ok(html.includes('svg'), 'should contain SVG')
  })

  it('returns outline shield for payment-verified-only x402 service', () => {
    const html = verifiedBadge({ domain_verified: 0, x402_payment_valid: 1, health_status: 'healthy' })
    assert.ok(html.includes('badge-verified-payment'), 'should have payment badge class')
    assert.ok(!html.includes('badge-verified-domain'), 'should NOT have domain badge class')
  })

  it('returns outline shield for healthy L402 service without domain verification', () => {
    const html = verifiedBadge({ domain_verified: 0, x402_payment_valid: 0, health_status: 'healthy' })
    assert.ok(html.includes('badge-verified-payment'))
  })

  it('returns empty string for unverified service', () => {
    const html = verifiedBadge({ domain_verified: 0, x402_payment_valid: 0, health_status: 'down' })
    assert.equal(html, '')
  })

  it('domain_verified takes precedence over payment_verified', () => {
    const html = verifiedBadge({ domain_verified: 1, x402_payment_valid: 1, health_status: 'healthy' })
    assert.ok(html.includes('badge-verified-domain'))
    assert.ok(!html.includes('badge-verified-payment'))
  })
})
