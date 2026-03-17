import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mapCategory, satsToUsd, mapX402Network, normalizeRawService } from '../src/aggregators/satring-utils.js'
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
    const result = satsToUsd(100_000_000, 100_000)
    assert.equal(result, 100_000)
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

describe('mapX402Network', () => {
  it('maps CAIP-2 chain IDs to human-readable names', () => {
    assert.equal(mapX402Network('eip155:8453'), 'Base')
    assert.equal(mapX402Network('eip155:1'), 'Ethereum')
    assert.equal(mapX402Network('eip155:42161'), 'Arbitrum')
    assert.equal(mapX402Network('eip155:10'), 'Optimism')
    assert.equal(mapX402Network('eip155:137'), 'Polygon')
  })

  it('maps plain network names', () => {
    assert.equal(mapX402Network('base'), 'Base')
    assert.equal(mapX402Network('ethereum'), 'Ethereum')
    assert.equal(mapX402Network('solana'), 'Solana')
  })

  it('defaults to Base for null/undefined', () => {
    assert.equal(mapX402Network(null), 'Base')
    assert.equal(mapX402Network(undefined), 'Base')
  })

  it('passes through unknown networks', () => {
    assert.equal(mapX402Network('some-new-chain'), 'some-new-chain')
  })
})

describe('normalizeRawService', () => {
  it('normalizes an L402 service', () => {
    const svc = {
      id: 42,
      name: 'Test API',
      description: 'A test service',
      url: 'http://api.example.com/test',
      protocol: 'L402',
      pricing_sats: 500,
      categories: [{ slug: 'ai-ml' }],
      owner_name: 'TestCorp',
    }

    const results = normalizeRawService(svc, 100_000)
    assert.equal(results.length, 1)
    const result = results[0]
    assert.ok(result.id)
    assert.equal(result.name, 'Test API')
    assert.equal(result.description, 'A test service')
    assert.equal(result.url, 'https://api.example.com/test')
    assert.equal(result.protocol, 'L402')
    assert.equal(result.price_sats, 500)
    assert.ok(typeof result.price_usd === 'number')
    assert.equal(result.payment_asset, 'BTC')
    assert.equal(result.payment_network, 'Lightning')
    assert.equal(result.category, 'ai/ml')
    assert.equal(result.provider, 'TestCorp')
    assert.equal(result.source_id, '42')
  })

  it('normalizes an x402 service', () => {
    const svc = {
      id: 99,
      name: 'x402 Service',
      description: 'Paid via x402',
      url: 'https://x402.example.com/api',
      protocol: 'x402',
      pricing_usd: 0.05,
      x402_asset: 'USDC',
      x402_network: 'eip155:8453',
      categories: [{ slug: 'data' }],
      owner_name: 'x402Corp',
    }

    const results = normalizeRawService(svc, 100_000)
    assert.equal(results.length, 1)
    const result = results[0]
    assert.equal(result.protocol, 'x402')
    assert.equal(result.price_sats, null)
    assert.equal(result.price_usd, 0.05)
    assert.equal(result.payment_asset, 'USDC')
    assert.equal(result.payment_network, 'Base')
    assert.equal(result.source_id, '99')
  })

  it('produces two rows for L402+x402 dual-protocol services', () => {
    const svc = {
      id: 77,
      name: 'Dual Protocol',
      url: 'https://dual.example.com/api',
      protocol: 'L402+x402',
      pricing_sats: 1000,
      pricing_usd: 0.10,
      x402_asset: 'USDC',
      x402_network: 'base',
      categories: [{ slug: 'tools' }],
      owner_name: 'DualCorp',
    }

    const results = normalizeRawService(svc, 100_000)
    assert.equal(results.length, 2)

    const l402 = results.find(r => r.protocol === 'L402')
    assert.ok(l402)
    assert.equal(l402.payment_asset, 'BTC')
    assert.equal(l402.payment_network, 'Lightning')
    assert.equal(l402.price_sats, 1000)

    const x402 = results.find(r => r.protocol === 'x402')
    assert.ok(x402)
    assert.equal(x402.payment_asset, 'USDC')
    assert.equal(x402.payment_network, 'Base')
    assert.equal(x402.price_usd, 0.10)
    assert.equal(x402.price_sats, null)

    // Different UUIDs
    assert.notEqual(l402.id, x402.id)
    // Same source_id
    assert.equal(l402.source_id, x402.source_id)
  })

  it('defaults to L402 when protocol field is missing', () => {
    const svc = { id: 1, url: 'https://example.com/api', name: 'Test' }
    const results = normalizeRawService(svc, 100_000)
    assert.equal(results.length, 1)
    assert.equal(results[0].protocol, 'L402')
    assert.equal(results[0].payment_asset, 'BTC')
    assert.equal(results[0].payment_network, 'Lightning')
  })

  it('defaults x402 payment_asset to USDC when not specified', () => {
    const svc = { id: 1, url: 'https://example.com/api', protocol: 'x402' }
    const results = normalizeRawService(svc, 100_000)
    assert.equal(results[0].payment_asset, 'USDC')
  })

  it('falls back to URL as name when name is missing', () => {
    const svc = { id: 1, url: 'https://example.com/api', protocol: 'L402' }
    const results = normalizeRawService(svc, 100_000)
    assert.equal(results[0].name, 'https://example.com/api')
  })

  it('defaults category to uncategorized when no categories', () => {
    const svc = { id: 1, url: 'https://example.com/api', name: 'Test', protocol: 'L402' }
    const results = normalizeRawService(svc, 100_000)
    assert.equal(results[0].category, 'uncategorized')
  })

  it('handles null pricing', () => {
    const svc = { id: 1, url: 'https://example.com/api', name: 'Test', protocol: 'L402' }
    const results = normalizeRawService(svc, 100_000)
    assert.equal(results[0].price_sats, null)
    assert.equal(results[0].price_usd, null)
  })

  it('throws when URL is missing', () => {
    assert.throws(() => normalizeRawService({ id: 1, name: 'Test' }, 100_000), /missing URL/)
  })

  it('falls back to L402 for unknown protocol strings', () => {
    const svc = { id: 1, url: 'https://example.com/api', protocol: 'WeirdProto' }
    const results = normalizeRawService(svc, 100_000)
    assert.equal(results.length, 1)
    assert.equal(results[0].protocol, 'L402')
  })
})

describe('BLOCKED_HOSTS', () => {
  it('blocks LightningProx ecosystem hosts', () => {
    assert.ok(BLOCKED_HOSTS.has('lightningprox.com'))
    assert.ok(BLOCKED_HOSTS.has('lpxpoly.com'))
    assert.ok(BLOCKED_HOSTS.has('satsforai.com'))
  })

  it('does not block hosts that may have valid x402 endpoints', () => {
    // These were previously blocked as non-L402, but may have x402 endpoints
    assert.ok(!BLOCKED_HOSTS.has('aiprox.dev'))
    assert.ok(!BLOCKED_HOSTS.has('certvera.com'))
    assert.ok(!BLOCKED_HOSTS.has('isitarug.com'))
  })

  it('does not block legitimate hosts', () => {
    assert.ok(!BLOCKED_HOSTS.has('satring.com'))
    assert.ok(!BLOCKED_HOSTS.has('example.com'))
  })
})
