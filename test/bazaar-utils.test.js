import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  mapNetworkToPaymentNetwork,
  extractProviderFromUrl,
  categorizeFromDescription,
  normalizeItem,
} from '../src/aggregators/bazaar-utils.js'

describe('mapNetworkToPaymentNetwork', () => {
  it('maps known networks to EIP-155 chain IDs', () => {
    assert.equal(mapNetworkToPaymentNetwork('base'), 'eip155:8453')
    assert.equal(mapNetworkToPaymentNetwork('base-sepolia'), 'eip155:84532')
    assert.equal(mapNetworkToPaymentNetwork('ethereum'), 'eip155:1')
    assert.equal(mapNetworkToPaymentNetwork('arbitrum'), 'eip155:42161')
    assert.equal(mapNetworkToPaymentNetwork('optimism'), 'eip155:10')
    assert.equal(mapNetworkToPaymentNetwork('polygon'), 'eip155:137')
  })

  it('passes through unknown networks unchanged', () => {
    assert.equal(mapNetworkToPaymentNetwork('solana'), 'solana')
    assert.equal(mapNetworkToPaymentNetwork('unknown'), 'unknown')
  })
})

describe('extractProviderFromUrl', () => {
  it('extracts provider name from hostname', () => {
    assert.equal(extractProviderFromUrl('https://example.com/api'), 'example')
    assert.equal(extractProviderFromUrl('https://myservice.io/v1'), 'myservice')
  })

  it('strips common prefixes (www, api, public)', () => {
    assert.equal(extractProviderFromUrl('https://api.example.com/v1'), 'example')
    assert.equal(extractProviderFromUrl('https://www.example.com'), 'example')
    assert.equal(extractProviderFromUrl('https://public.example.com'), 'example')
  })

  it('returns null for invalid URLs', () => {
    assert.equal(extractProviderFromUrl('not-a-url'), null)
    assert.equal(extractProviderFromUrl(''), null)
  })
})

describe('categorizeFromDescription', () => {
  it('categorizes crypto-related descriptions', () => {
    assert.equal(categorizeFromDescription('Get NFT metadata'), 'crypto/nft')
    assert.equal(categorizeFromDescription('Check token balance'), 'crypto/balances')
    assert.equal(categorizeFromDescription('Token holding details'), 'crypto/balances')
    assert.equal(categorizeFromDescription('Get token price data'), 'crypto/prices')
    assert.equal(categorizeFromDescription('Market cap tracker'), 'crypto/prices')
    assert.equal(categorizeFromDescription('DeFi liquidity pools'), 'crypto/defi')
    assert.equal(categorizeFromDescription('Swap tokens easily'), 'crypto/defi')
    assert.equal(categorizeFromDescription('Transaction history'), 'crypto/transactions')
    assert.equal(categorizeFromDescription('Wallet portfolio view'), 'crypto/wallet')
  })

  it('categorizes other descriptions', () => {
    assert.equal(categorizeFromDescription('Weather forecast API'), 'real-time-data/weather')
    assert.equal(categorizeFromDescription('News aggregator'), 'real-time-data/news')
    assert.equal(categorizeFromDescription('Web search API'), 'tools/search')
    assert.equal(categorizeFromDescription('Image processing'), 'media/images')
  })

  it('returns null for null/undefined/unmatched descriptions', () => {
    assert.equal(categorizeFromDescription(null), null)
    assert.equal(categorizeFromDescription(undefined), null)
    assert.equal(categorizeFromDescription('some random API'), null)
  })
})

describe('normalizeItem', () => {
  it('normalizes a valid Bazaar item', () => {
    const item = {
      resource: 'http://api.example.com/weather',
      accepts: [{
        resource: 'http://api.example.com/weather',
        maxAmountRequired: '1000000',
        network: 'base',
        description: 'Weather forecast API',
      }],
    }

    const result = normalizeItem(item)
    assert.ok(result)
    assert.ok(result.id)
    assert.equal(result.url, 'https://api.example.com/weather')
    assert.equal(result.price_usd, 1.0)
    assert.equal(result.payment_asset, 'USDC')
    assert.equal(result.payment_network, 'eip155:8453')
    assert.equal(result.category, 'real-time-data/weather')
    assert.equal(result.provider, 'example')
  })

  it('throws when no accepts array', () => {
    assert.throws(() => normalizeItem({}), /missing accepts/)
    assert.throws(() => normalizeItem({ accepts: [] }), /missing accepts/)
  })

  it('throws when no resource URL', () => {
    const item = { accepts: [{ maxAmountRequired: '1000' }] }
    assert.throws(() => normalizeItem(item), /missing resource URL/)
  })

  it('truncates long descriptions for name field', () => {
    const longDesc = 'A'.repeat(100)
    const item = {
      accepts: [{
        resource: 'https://example.com/api',
        description: longDesc,
      }],
    }
    const result = normalizeItem(item)
    assert.ok(result.name.length <= 83)
    assert.ok(result.name.endsWith('...'))
  })

  it('uses URL as name when no description', () => {
    const item = {
      accepts: [{
        resource: 'https://example.com/api',
      }],
    }
    const result = normalizeItem(item)
    assert.equal(result.name, 'https://example.com/api')
  })

  it('handles custom payment asset names', () => {
    const item = {
      accepts: [{
        resource: 'https://example.com/api',
        extra: { name: 'WETH' },
      }],
    }
    const result = normalizeItem(item)
    assert.equal(result.payment_asset, 'WETH')
  })

  it('defaults to USDC when no asset name', () => {
    const item = {
      accepts: [{
        resource: 'https://example.com/api',
      }],
    }
    const result = normalizeItem(item)
    assert.equal(result.payment_asset, 'USDC')
  })

  it('serializes input and output schemas', () => {
    const item = {
      accepts: [{
        resource: 'https://example.com/api',
        outputSchema: {
          input: { type: 'string' },
          output: { type: 'number' },
        },
      }],
    }
    const result = normalizeItem(item)
    assert.equal(result.input_schema, '{"type":"string"}')
    assert.equal(result.output_schema, '{"type":"number"}')
  })
})
