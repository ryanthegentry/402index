import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildServiceQuery, PAGE_COLUMNS } from '../src/queries/services.js'

describe('buildServiceQuery', () => {
  it('returns defaults when called with no options', () => {
    const result = buildServiceQuery()
    assert.ok(result.where.includes("status = 'active' OR status IS NULL"))
    assert.deepEqual(result.params, {})
    assert.equal(result.limit, 50)
    assert.equal(result.offset, 0)
    assert.ok(result.orderBy.includes('featured DESC'))
  })

  it('handles limit=0 correctly (clamps to 1, not default 50)', () => {
    const result = buildServiceQuery({ rawLimit: '0' })
    assert.equal(result.limit, 1)
  })

  it('clamps limit to range [1, 200]', () => {
    assert.equal(buildServiceQuery({ rawLimit: '-5' }).limit, 1)
    assert.equal(buildServiceQuery({ rawLimit: '500' }).limit, 200)
    assert.equal(buildServiceQuery({ rawLimit: '100' }).limit, 100)
  })

  it('defaults limit to 50 for non-numeric input', () => {
    assert.equal(buildServiceQuery({ rawLimit: 'abc' }).limit, 50)
    assert.equal(buildServiceQuery({ rawLimit: '' }).limit, 50)
  })

  it('floors offset to 0', () => {
    assert.equal(buildServiceQuery({ rawOffset: '-10' }).offset, 0)
    assert.equal(buildServiceQuery({ rawOffset: 'abc' }).offset, 0)
    assert.equal(buildServiceQuery({ rawOffset: '5' }).offset, 5)
  })

  it('builds protocol filter with COLLATE NOCASE', () => {
    const result = buildServiceQuery({ protocol: 'L402' })
    assert.ok(result.where.includes('protocol = @protocol COLLATE NOCASE'))
    assert.equal(result.params.protocol, 'L402')
  })

  it('builds category filter with prefix match', () => {
    const result = buildServiceQuery({ category: 'crypto' })
    assert.ok(result.where.includes('@category'))
    assert.ok(result.where.includes('@categoryPrefix'))
    assert.equal(result.params.category, 'crypto')
    assert.equal(result.params.categoryPrefix, 'crypto/%')
  })

  it('builds health filter for valid values', () => {
    for (const v of ['healthy', 'degraded', 'down', 'unknown']) {
      const result = buildServiceQuery({ health: v })
      assert.ok(result.where.includes('health_status = @health'))
      assert.equal(result.params.health, v)
    }
  })

  it('ignores invalid health filter values', () => {
    const result = buildServiceQuery({ health: 'bogus' })
    assert.ok(!result.where.includes('health_status'))
    assert.equal(result.params.health, undefined)
  })

  it('ignores invalid source filter values', () => {
    const result = buildServiceQuery({ source: 'invalid' })
    assert.ok(!result.where.includes('source'))
    assert.equal(result.params.source, undefined)
  })

  it('ignores max_price_usd when NaN', () => {
    const result = buildServiceQuery({ max_price_usd: 'abc' })
    assert.ok(!result.where.includes('price_usd'))
    assert.equal(result.params.max_price_usd, undefined)
  })

  it('parses valid max_price_usd', () => {
    const result = buildServiceQuery({ max_price_usd: '0.01' })
    assert.ok(result.where.includes('price_usd <= @max_price_usd'))
    assert.equal(result.params.max_price_usd, 0.01)
  })

  it('treats q=* as match-all (no text search condition)', () => {
    const result = buildServiceQuery({ q: '*', protocol: 'L402', health: 'healthy' })
    // Wildcard * should NOT add a LIKE condition — it means "give me everything"
    assert.ok(!result.where.includes('LIKE @q'), 'q=* should not add LIKE filter')
    assert.equal(result.params.q, undefined, 'q=* should not set @q param')
    // But protocol and health filters should still be present
    assert.ok(result.where.includes('protocol = @protocol'))
    assert.ok(result.where.includes('health_status = @health'))
  })

  it('builds q filter as LIKE across name, description, and url', () => {
    const result = buildServiceQuery({ q: 'weather' })
    assert.ok(result.where.includes('name LIKE @q'))
    assert.ok(result.where.includes('description LIKE @q'))
    assert.ok(result.where.includes('url LIKE @q'))
    assert.equal(result.params.q, '%weather%')
  })

  it('q filter matches URL patterns (domain search)', () => {
    const result = buildServiceQuery({ q: 'sats4ai.com' })
    assert.ok(result.where.includes('url LIKE @q'), 'WHERE should include url LIKE')
    assert.equal(result.params.q, '%sats4ai.com%')
  })

  it('q filter matches URL path fragments', () => {
    const result = buildServiceQuery({ q: '/api/l402/' })
    assert.ok(result.where.includes('url LIKE @q'), 'WHERE should include url LIKE')
    assert.equal(result.params.q, '%/api/l402/%')
  })

  it('q filter uses OR across all three fields', () => {
    const result = buildServiceQuery({ q: 'lightningenable' })
    // Should be a single OR group matching name, description, and url
    assert.ok(result.where.includes('name LIKE @q OR description LIKE @q OR url LIKE @q'),
      'WHERE should OR across name, description, and url')
  })

  it('escapes LIKE metacharacters % and _ in q parameter', () => {
    const r1 = buildServiceQuery({ q: '100%' })
    // % inside the search term must be escaped so it doesn't act as a wildcard
    assert.equal(r1.params.q, '%100\\%%')
    assert.ok(r1.where.includes("ESCAPE '\\\\'"), 'WHERE should include ESCAPE clause')

    const r2 = buildServiceQuery({ q: 'test_value' })
    assert.equal(r2.params.q, '%test\\_value%')
    assert.ok(r2.where.includes("ESCAPE '\\\\'"), 'WHERE should include ESCAPE clause')

    const r3 = buildServiceQuery({ q: '%_combo_%' })
    assert.equal(r3.params.q, '%\\%\\_combo\\_\\%%')
  })

  it('builds featured filter for "true" and "1"', () => {
    const r1 = buildServiceQuery({ featured: 'true' })
    assert.ok(r1.where.includes('featured = 1'))
    const r2 = buildServiceQuery({ featured: '1' })
    assert.ok(r2.where.includes('featured = 1'))
    const r3 = buildServiceQuery({ featured: 'false' })
    assert.ok(!r3.where.includes('featured'))
  })

  it('uses custom sort column when provided', () => {
    const result = buildServiceQuery({ sort: 'price', order: 'desc' })
    assert.ok(result.orderBy.includes('price_usd DESC'))
  })

  it('falls back to default order for invalid sort', () => {
    const result = buildServiceQuery({ sort: 'bogus' })
    assert.ok(result.orderBy.includes('health_status'))
  })

  it('combines multiple filters with AND', () => {
    const result = buildServiceQuery({ protocol: 'x402', health: 'healthy', source: 'bazaar' })
    assert.ok(result.where.includes('AND'))
    assert.equal(result.params.protocol, 'x402')
    assert.equal(result.params.health, 'healthy')
    assert.equal(result.params.source, 'bazaar')
  })

  it('builds payment_asset filter', () => {
    const result = buildServiceQuery({ payment_asset: 'BTC' })
    assert.ok(result.where.includes('payment_asset = @payment_asset'))
    assert.equal(result.params.payment_asset, 'BTC')
  })

  it('PAGE_COLUMNS includes payment_network', () => {
    assert.ok(PAGE_COLUMNS.includes('payment_network'), 'PAGE_COLUMNS should include payment_network')
  })
})
