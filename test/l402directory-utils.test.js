import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mapCategory, normalizeEndpoint, normalizeServices } from '../src/aggregators/l402directory-utils.js'

describe('l402directory mapCategory', () => {
  it('maps known l402.directory categories to internal categories', () => {
    assert.equal(mapCategory(['data']), 'real-time-data')
    assert.equal(mapCategory(['finance']), 'crypto/prices')
    assert.equal(mapCategory(['video']), 'media/video')
    assert.equal(mapCategory(['streaming']), 'media/streaming')
    assert.equal(mapCategory(['developer-tools']), 'tools')
    assert.equal(mapCategory(['ai']), 'ai/ml')
    assert.equal(mapCategory(['analytics']), 'data/analytics')
    assert.equal(mapCategory(['content']), 'media')
    assert.equal(mapCategory(['search']), 'tools/search')
    assert.equal(mapCategory(['social']), 'social')
  })

  it('uses the first category when multiple provided', () => {
    assert.equal(mapCategory(['finance', 'analytics', 'data']), 'crypto/prices')
  })

  it('passes through unknown categories', () => {
    assert.equal(mapCategory(['some-new-category']), 'some-new-category')
  })

  it('returns uncategorized for null/undefined/empty', () => {
    assert.equal(mapCategory(null), 'uncategorized')
    assert.equal(mapCategory(undefined), 'uncategorized')
    assert.equal(mapCategory([]), 'uncategorized')
  })
})

describe('l402directory normalizeEndpoint', () => {
  const baseService = {
    service_id: 'abc123',
    name: 'Test Service',
    description: 'A test service',
    provider: { name: 'TestProvider', url: 'https://test.com' },
    categories: ['data', 'analytics'],
    status: 'live',
  }

  it('normalizes a paid endpoint', () => {
    const ep = {
      url: 'https://example.com/api/data',
      method: 'GET',
      description: 'Get data',
      pricing: { amount: 10, currency: 'sats' },
    }
    const result = normalizeEndpoint(baseService, ep)
    assert.ok(result)
    assert.ok(result.id)
    assert.equal(result.name, 'Test Service: Get data')
    assert.equal(result.url, 'https://example.com/api/data')
    assert.equal(result.price_sats, 10)
    assert.equal(result.category, 'real-time-data')
    assert.equal(result.provider, 'TestProvider')
    assert.equal(result.source_id, 'abc123')
    assert.equal(result.http_method, 'GET')
  })

  it('skips free endpoints (0 sats)', () => {
    const ep = {
      url: 'https://example.com/api/free',
      pricing: { amount: 0, currency: 'sats' },
    }
    const result = normalizeEndpoint(baseService, ep)
    assert.equal(result, null)
  })

  it('skips endpoints with no pricing', () => {
    const ep = { url: 'https://example.com/api/free' }
    const result = normalizeEndpoint(baseService, ep)
    assert.equal(result, null)
  })

  it('skips .onion URLs', () => {
    const ep = {
      url: 'http://abcdef.onion/api/data',
      pricing: { amount: 10 },
    }
    const result = normalizeEndpoint(baseService, ep)
    assert.equal(result, null)
  })

  it('skips template URLs with unresolved params', () => {
    const ep = {
      url: 'https://example.com/api/{id}/data',
      pricing: { amount: 10 },
    }
    const result = normalizeEndpoint(baseService, ep)
    assert.equal(result, null)
  })

  it('throws when URL is missing', () => {
    const ep = { pricing: { amount: 10 } }
    assert.throws(() => normalizeEndpoint(baseService, ep), /missing URL/)
  })

  it('falls back to service name when provider.name is missing', () => {
    const svc = { ...baseService, provider: null }
    const ep = {
      url: 'https://example.com/api/data',
      pricing: { amount: 10 },
    }
    const result = normalizeEndpoint(svc, ep)
    assert.equal(result.provider, 'Test Service')
  })

  it('uppercases HTTP method', () => {
    const ep = {
      url: 'https://example.com/api/data',
      method: 'post',
      pricing: { amount: 50 },
    }
    const result = normalizeEndpoint(baseService, ep)
    assert.equal(result.http_method, 'POST')
  })
})

describe('l402directory normalizeServices', () => {
  it('extracts paid endpoints from live services', () => {
    const services = [{
      service_id: 's1',
      name: 'Svc One',
      provider: { name: 'P1' },
      categories: ['data'],
      status: 'live',
      endpoints: [
        { url: 'https://example.com/free', pricing: { amount: 0 } },
        { url: 'https://example.com/paid', description: 'Paid data', pricing: { amount: 10 } },
      ],
    }]
    const results = normalizeServices(services)
    assert.equal(results.length, 1)
    assert.equal(results[0].price_sats, 10)
  })

  it('skips offline services', () => {
    const services = [{
      service_id: 's1',
      name: 'Offline',
      categories: [],
      status: 'offline',
      endpoints: [
        { url: 'https://example.com/paid', pricing: { amount: 10 } },
      ],
    }]
    const results = normalizeServices(services)
    assert.equal(results.length, 0)
  })

  it('includes degraded services', () => {
    const services = [{
      service_id: 's1',
      name: 'Degraded',
      provider: { name: 'P1' },
      categories: ['finance'],
      status: 'degraded',
      endpoints: [
        { url: 'https://example.com/paid', pricing: { amount: 5 } },
      ],
    }]
    const results = normalizeServices(services)
    assert.equal(results.length, 1)
  })

  it('handles services with no endpoints', () => {
    const services = [{
      service_id: 's1',
      name: 'Empty',
      categories: [],
      status: 'live',
      endpoints: [],
    }]
    const results = normalizeServices(services)
    assert.equal(results.length, 0)
  })

  it('filters out .onion and template URLs', () => {
    const services = [{
      service_id: 's1',
      name: 'Mixed',
      provider: { name: 'P1' },
      categories: ['data'],
      status: 'live',
      endpoints: [
        { url: 'http://abc.onion/api', pricing: { amount: 100 } },
        { url: 'https://example.com/{id}', pricing: { amount: 10 } },
        { url: 'https://example.com/real', description: 'Real', pricing: { amount: 10 } },
      ],
    }]
    const results = normalizeServices(services)
    assert.equal(results.length, 1)
    assert.ok(results[0].url.includes('example.com/real'))
  })
})
