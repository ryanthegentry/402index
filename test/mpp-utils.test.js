import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeMppEndpoint,
  parseMppCurrency,
  mapMppCategory,
} from '../src/aggregators/mpp-utils.js'

describe('mapMppCategory', () => {
  it('maps known MPP categories to internal categories', () => {
    assert.equal(mapMppCategory(['ai']), 'ai/llm')
    assert.equal(mapMppCategory(['blockchain']), 'blockchain')
    assert.equal(mapMppCategory(['data']), 'data')
    assert.equal(mapMppCategory(['search']), 'search')
    assert.equal(mapMppCategory(['web']), 'web-scraping')
    assert.equal(mapMppCategory(['compute']), 'compute')
    assert.equal(mapMppCategory(['media']), 'media')
    assert.equal(mapMppCategory(['social']), 'social')
    assert.equal(mapMppCategory(['storage']), 'storage')
  })

  it('uses the first category when multiple provided', () => {
    assert.equal(mapMppCategory(['ai', 'data', 'web']), 'ai/llm')
  })

  it('passes through unknown categories', () => {
    assert.equal(mapMppCategory(['some-new-category']), 'some-new-category')
  })

  it('returns uncategorized for null/undefined/empty', () => {
    assert.equal(mapMppCategory(null), 'uncategorized')
    assert.equal(mapMppCategory(undefined), 'uncategorized')
    assert.equal(mapMppCategory([]), 'uncategorized')
  })
})

describe('parseMppCurrency', () => {
  it('returns USDC for known Tempo USDC address', () => {
    assert.equal(
      parseMppCurrency('0x20c000000000000000000000b9537d11c60e8b50'),
      'USDC'
    )
  })

  it('returns USD for Stripe "usd" currency string', () => {
    assert.equal(parseMppCurrency('usd'), 'USD')
  })

  it('returns USDC for unknown address (default)', () => {
    assert.equal(parseMppCurrency('0xdeadbeef'), 'USDC')
  })

  it('returns USDC for null/undefined', () => {
    assert.equal(parseMppCurrency(null), 'USDC')
    assert.equal(parseMppCurrency(undefined), 'USDC')
  })
})

describe('normalizeMppEndpoint', () => {
  const baseService = {
    id: 'openai',
    name: 'OpenAI',
    url: 'https://openai.mpp.tempo.xyz',
    description: 'AI inference provider',
    categories: ['ai'],
    provider: { name: 'OpenAI', url: 'https://openai.com' },
  }

  it('normalizes a paid endpoint with fixed pricing', () => {
    const ep = {
      method: 'POST',
      path: '/v1/responses',
      description: 'Create a response',
      payment: {
        intent: 'charge',
        method: 'tempo',
        currency: '0x20c000000000000000000000b9537d11c60e8b50',
        decimals: 6,
        amount: '10000',
      },
    }
    const result = normalizeMppEndpoint(baseService, ep)
    assert.ok(result)
    assert.ok(result.id)
    assert.equal(result.name, 'OpenAI: Create a response')
    assert.equal(result.url, 'https://openai.mpp.tempo.xyz/v1/responses')
    assert.equal(result.price_usd, 0.01)
    assert.equal(result.payment_asset, 'USDC')
    assert.equal(result.payment_network, 'Tempo')
    assert.equal(result.category, 'ai/llm')
    assert.equal(result.provider, 'OpenAI')
    assert.equal(result.source_id, 'openai:/v1/responses')
    assert.equal(result.http_method, 'POST')
    assert.equal(result.probe_body, '{}')
  })

  it('converts price correctly: 10000 with decimals 6 = $0.01', () => {
    const ep = {
      method: 'GET',
      path: '/v1/data',
      payment: {
        amount: '10000',
        decimals: 6,
        method: 'tempo',
        currency: '0x20c000000000000000000000b9537d11c60e8b50',
      },
    }
    const result = normalizeMppEndpoint(baseService, ep)
    assert.equal(result.price_usd, 0.01)
  })

  it('converts large amounts correctly: 1000000 with decimals 6 = $1.00', () => {
    const ep = {
      method: 'POST',
      path: '/v1/expensive',
      payment: {
        amount: '1000000',
        decimals: 6,
        method: 'tempo',
        currency: '0x20c000000000000000000000b9537d11c60e8b50',
      },
    }
    const result = normalizeMppEndpoint(baseService, ep)
    assert.equal(result.price_usd, 1.0)
  })

  it('handles zero amount', () => {
    const ep = {
      method: 'GET',
      path: '/v1/zero',
      payment: {
        amount: '0',
        decimals: 6,
        method: 'tempo',
        currency: '0x20c000000000000000000000b9537d11c60e8b50',
      },
    }
    const result = normalizeMppEndpoint(baseService, ep)
    assert.equal(result.price_usd, 0)
  })

  it('handles missing decimals (defaults to 6)', () => {
    const ep = {
      method: 'GET',
      path: '/v1/data',
      payment: {
        amount: '500000',
        method: 'tempo',
        currency: '0x20c000000000000000000000b9537d11c60e8b50',
      },
    }
    const result = normalizeMppEndpoint(baseService, ep)
    assert.equal(result.price_usd, 0.5)
  })

  it('sets price_usd to null for dynamic pricing', () => {
    const ep = {
      method: 'POST',
      path: '/v1/dynamic',
      description: 'Dynamic pricing endpoint',
      payment: {
        amount: '10000',
        decimals: 6,
        method: 'tempo',
        dynamic: true,
        currency: '0x20c000000000000000000000b9537d11c60e8b50',
      },
    }
    const result = normalizeMppEndpoint(baseService, ep)
    assert.equal(result.price_usd, null)
  })

  it('returns null for free endpoints (payment: null)', () => {
    const ep = {
      method: 'GET',
      path: '/health',
      description: 'Health check',
      payment: null,
    }
    const result = normalizeMppEndpoint(baseService, ep)
    assert.equal(result, null)
  })

  it('builds full URL from service.url + endpoint.path', () => {
    const ep = {
      method: 'GET',
      path: '/v1/models',
      payment: {
        amount: '5000',
        decimals: 6,
        method: 'tempo',
        currency: '0x20c000000000000000000000b9537d11c60e8b50',
      },
    }
    const result = normalizeMppEndpoint(baseService, ep)
    assert.equal(result.url, 'https://openai.mpp.tempo.xyz/v1/models')
  })

  it('maps stripe payment method to Stripe network', () => {
    const svc = {
      ...baseService,
      categories: ['blockchain'],
    }
    const ep = {
      method: 'POST',
      path: '/v1/charge',
      payment: {
        amount: '100000',
        decimals: 6,
        method: 'stripe',
        currency: '0x20c000000000000000000000b9537d11c60e8b50',
      },
    }
    const result = normalizeMppEndpoint(svc, ep)
    assert.equal(result.payment_network, 'Stripe')
  })

  it('extracts provider name from service.provider.name', () => {
    const ep = {
      method: 'GET',
      path: '/v1/data',
      payment: {
        amount: '5000',
        decimals: 6,
        method: 'tempo',
        currency: '0x20c000000000000000000000b9537d11c60e8b50',
      },
    }
    const result = normalizeMppEndpoint(baseService, ep)
    assert.equal(result.provider, 'OpenAI')
  })

  it('falls back to service.name when provider is missing', () => {
    const svc = { ...baseService, provider: null }
    const ep = {
      method: 'GET',
      path: '/v1/data',
      payment: {
        amount: '5000',
        decimals: 6,
        method: 'tempo',
        currency: '0x20c000000000000000000000b9537d11c60e8b50',
      },
    }
    const result = normalizeMppEndpoint(svc, ep)
    assert.equal(result.provider, 'OpenAI')
  })

  it('preserves HTTP method', () => {
    const ep = {
      method: 'POST',
      path: '/v1/create',
      payment: {
        amount: '5000',
        decimals: 6,
        method: 'tempo',
        currency: '0x20c000000000000000000000b9537d11c60e8b50',
      },
    }
    const result = normalizeMppEndpoint(baseService, ep)
    assert.equal(result.http_method, 'POST')
  })

  it('sets probe_body for POST endpoints', () => {
    const ep = {
      method: 'POST',
      path: '/v1/create',
      payment: {
        amount: '5000',
        decimals: 6,
        method: 'tempo',
        currency: '0x20c000000000000000000000b9537d11c60e8b50',
      },
    }
    const result = normalizeMppEndpoint(baseService, ep)
    assert.equal(result.probe_body, '{}')
  })

  it('sets probe_body to null for GET endpoints', () => {
    const ep = {
      method: 'GET',
      path: '/v1/data',
      payment: {
        amount: '5000',
        decimals: 6,
        method: 'tempo',
        currency: '0x20c000000000000000000000b9537d11c60e8b50',
      },
    }
    const result = normalizeMppEndpoint(baseService, ep)
    assert.equal(result.probe_body, null)
  })

  it('uses endpoint.path as name fallback when description is missing', () => {
    const ep = {
      method: 'GET',
      path: '/v1/data',
      payment: {
        amount: '5000',
        decimals: 6,
        method: 'tempo',
        currency: '0x20c000000000000000000000b9537d11c60e8b50',
      },
    }
    const result = normalizeMppEndpoint(baseService, ep)
    assert.equal(result.name, 'OpenAI: /v1/data')
  })

  it('falls back to categorize() when no MPP categories', () => {
    const svc = { ...baseService, categories: [], description: 'Get bitcoin fee estimates' }
    const ep = {
      method: 'GET',
      path: '/v1/data',
      payment: {
        amount: '5000',
        decimals: 6,
        method: 'tempo',
        currency: '0x20c000000000000000000000b9537d11c60e8b50',
      },
    }
    const result = normalizeMppEndpoint(svc, ep)
    assert.equal(result.category, 'bitcoin')
  })
})
