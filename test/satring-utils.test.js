import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mapCategory, satsToUsd, normalizeRawService } from '../src/aggregators/satring-utils.js'
import { BLOCKED_HOSTS } from '../src/aggregators/satring.js'

describe('mapCategory', () => {
  it('maps known Satring slugs to internal categories', () => {
    assert.equal(mapCategory([{ slug: 'ai-ml' }]), 'ai/ml')
    assert.equal(mapCategory([{ slug: 'finance' }]), 'crypto/prices')
    assert.equal(mapCategory([{ slug: 'data' }]), 'real-time-data')
    assert.equal(mapCategory([{ slug: 'weather' }]), 'real-time-data/weather')
    assert.equal(mapCategory([{ slug: 'search' }]), 'tools/search')
    assert.equal(mapCategory([{ slug: 'tools' }]), 'tools')
    assert.equal(mapCategory([{ slug: 'social' }]), 'social')
    assert.equal(mapCategory([{ slug: 'identity' }]), 'identity')
    assert.equal(mapCategory([{ slug: 'media' }]), 'media')
    assert.equal(mapCategory([{ slug: 'compute' }]), 'compute')
    assert.equal(mapCategory([{ slug: 'storage' }]), 'storage')
  })

  it('passes through unknown slugs', () => {
    assert.equal(mapCategory([{ slug: 'unknown-category' }]), 'unknown-category')
  })

  it('uses the first category when multiple provided', () => {
    assert.equal(mapCategory([{ slug: 'ai-ml' }, { slug: 'tools' }]), 'ai/ml')
  })

  it('returns null for null/undefined/empty categories', () => {
    assert.equal(mapCategory(null), null)
    assert.equal(mapCategory(undefined), null)
    assert.equal(mapCategory([]), null)
  })
})

describe('satsToUsd', () => {
  it('converts sats to USD using provided BTC rate', () => {
    // 100_000_000 sats (1 BTC) at $100,000/BTC = $100,000
    const result = satsToUsd(100_000_000, 100_000)
    assert.equal(result, 100_000)
    // 10 sats at $100,000/BTC = $0.01
    const result2 = satsToUsd(10, 100_000)
    assert.ok(Math.abs(result2 - 0.01) < 1e-6)
  })

  it('converts 1 BTC (100M sats) to the BTC rate', () => {
    assert.equal(satsToUsd(100_000_000, 50_000), 50_000)
  })

  it('returns null for null sats', () => {
    assert.equal(satsToUsd(null, 100_000), null)
  })

  it('returns null for zero sats', () => {
    assert.equal(satsToUsd(0, 100_000), null)
  })
})

describe('normalizeRawService', () => {
  it('normalizes a Satring service object', () => {
    const svc = {
      id: 42,
      name: 'Test API',
      description: 'A test service',
      url: 'http://api.example.com/test',
      pricing_sats: 500,
      categories: [{ slug: 'ai-ml' }],
      owner_name: 'TestCorp',
    }

    const result = normalizeRawService(svc, 100_000)
    assert.ok(result.id)
    assert.equal(result.name, 'Test API')
    assert.equal(result.description, 'A test service')
    assert.equal(result.url, 'https://api.example.com/test')
    assert.equal(result.price_sats, 500)
    assert.ok(typeof result.price_usd === 'number')
    assert.equal(result.category, 'ai/ml')
    assert.equal(result.provider, 'TestCorp')
    assert.equal(result.source_id, '42')
  })

  it('falls back to URL as name when name is missing', () => {
    const svc = { id: 1, url: 'https://example.com/api' }
    const result = normalizeRawService(svc, 100_000)
    assert.equal(result.name, 'https://example.com/api')
  })

  it('defaults category to uncategorized when no categories', () => {
    const svc = { id: 1, url: 'https://example.com/api', name: 'Test' }
    const result = normalizeRawService(svc, 100_000)
    assert.equal(result.category, 'uncategorized')
  })

  it('handles null pricing', () => {
    const svc = { id: 1, url: 'https://example.com/api', name: 'Test' }
    const result = normalizeRawService(svc, 100_000)
    assert.equal(result.price_sats, null)
    assert.equal(result.price_usd, null)
  })

  it('throws when URL is missing', () => {
    assert.throws(() => normalizeRawService({ id: 1, name: 'Test' }, 100_000), /missing URL/)
  })
})

describe('BLOCKED_HOSTS', () => {
  it('blocks LightningProx ecosystem hosts', () => {
    assert.ok(BLOCKED_HOSTS.has('lightningprox.com'))
    assert.ok(BLOCKED_HOSTS.has('lpxpoly.com'))
    assert.ok(BLOCKED_HOSTS.has('satsforai.com'))
  })

  it('blocks confirmed non-L402 hosts', () => {
    assert.ok(BLOCKED_HOSTS.has('aiprox.dev'))
    assert.ok(BLOCKED_HOSTS.has('certvera.com'))
    assert.ok(BLOCKED_HOSTS.has('isitarug.com'))
  })

  it('does not block lightningenable.com (status pending)', () => {
    assert.ok(!BLOCKED_HOSTS.has('lightningenable.com'))
  })

  it('does not block legitimate hosts', () => {
    assert.ok(!BLOCKED_HOSTS.has('satring.com'))
    assert.ok(!BLOCKED_HOSTS.has('example.com'))
  })
})
