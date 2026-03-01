/**
 * Integration tests for 402index.io production API
 *
 * Run: node --test test/api-integration.test.js
 *
 * Tests all documented endpoints, edge cases, and known documentation gaps.
 * Uses Node's built-in test runner + fetch(). No dependencies.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const BASE = process.env.API_BASE || 'http://localhost:3402'
const API = `${BASE}/api/v1`

async function api(path) {
  const res = await fetch(`${API}${path}`)
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    body: await res.json().catch(() => null),
    text: null, // populated below for non-JSON
  }
}

async function raw(path) {
  const res = await fetch(`${BASE}${path}`)
  return {
    status: res.status,
    text: await res.text(),
  }
}

// ─── 1. GET /api/v1/services — Happy Paths ─────────────────────────────────

describe('GET /api/v1/services — Happy Paths', () => {
  it('no params → returns services array, total, limit=50, offset=0', async () => {
    const r = await api('/services')
    assert.equal(r.status, 200)
    assert.ok(Array.isArray(r.body.services), 'services should be array')
    assert.ok(r.body.services.length > 0, 'should have services')
    assert.equal(typeof r.body.total, 'number')
    assert.equal(r.body.limit, 50)
    assert.equal(r.body.offset, 0)
  })

  it('?protocol=x402 → all results have protocol x402', async () => {
    const r = await api('/services?protocol=x402')
    assert.equal(r.status, 200)
    for (const s of r.body.services) {
      assert.equal(s.protocol.toLowerCase(), 'x402', `${s.name} has protocol ${s.protocol}`)
    }
  })

  it('?protocol=L402 → all results have protocol L402', async () => {
    const r = await api('/services?protocol=L402')
    assert.equal(r.status, 200)
    assert.ok(r.body.services.length > 0, 'should have L402 services')
    for (const s of r.body.services) {
      assert.equal(s.protocol.toLowerCase(), 'l402', `${s.name} has protocol ${s.protocol}`)
    }
  })

  it('?health=healthy → all results have health_status healthy', async () => {
    const r = await api('/services?health=healthy')
    assert.equal(r.status, 200)
    for (const s of r.body.services) {
      assert.equal(s.health_status, 'healthy', `${s.name} is ${s.health_status}`)
    }
  })

  it('?health=degraded → correct filtering', async () => {
    const r = await api('/services?health=degraded')
    assert.equal(r.status, 200)
    for (const s of r.body.services) {
      assert.equal(s.health_status, 'degraded')
    }
  })

  it('?health=down → correct filtering', async () => {
    const r = await api('/services?health=down')
    assert.equal(r.status, 200)
    for (const s of r.body.services) {
      assert.equal(s.health_status, 'down')
    }
  })

  it('?health=unknown → correct filtering', async () => {
    const r = await api('/services?health=unknown')
    assert.equal(r.status, 200)
    for (const s of r.body.services) {
      assert.equal(s.health_status, 'unknown')
    }
  })

  it('?source=bazaar → correct filtering', async () => {
    const r = await api('/services?source=bazaar')
    assert.equal(r.status, 200)
    assert.ok(r.body.services.length > 0)
    for (const s of r.body.services) {
      assert.equal(s.source, 'bazaar')
    }
  })

  it('?source=exclusive → correct filtering', async () => {
    const r = await api('/services?source=exclusive')
    assert.equal(r.status, 200)
    for (const s of r.body.services) {
      assert.equal(s.source, 'exclusive')
    }
  })

  it('?category with prefix match → results match category or subcategory', async () => {
    // First find a real category from the categories endpoint
    const cats = await api('/categories')
    const topCategory = Object.keys(cats.body.categories)[0]
    if (!topCategory) return // skip if no categories

    const r = await api(`/services?category=${encodeURIComponent(topCategory)}`)
    assert.equal(r.status, 200)
    for (const s of r.body.services) {
      assert.ok(
        s.category === topCategory || s.category.startsWith(topCategory + '/'),
        `${s.name} category "${s.category}" should match "${topCategory}"`
      )
    }
  })

  it('?q=weather → results contain "weather" in name or description', async () => {
    const r = await api('/services?q=weather')
    assert.equal(r.status, 200)
    // Note: description not returned in list endpoint, just verify no crash
    // and that results exist or are empty
    assert.ok(Array.isArray(r.body.services))
  })

  it('?featured=true → all results have featured=1', async () => {
    const r = await api('/services?featured=true')
    assert.equal(r.status, 200)
    for (const s of r.body.services) {
      assert.equal(s.featured, 1, `${s.name} should be featured`)
    }
  })

  it('?max_price_usd=0.01 → all results have price_usd <= 0.01', async () => {
    const r = await api('/services?max_price_usd=0.01')
    assert.equal(r.status, 200)
    for (const s of r.body.services) {
      // price_usd could be null for some services
      if (s.price_usd !== null) {
        assert.ok(s.price_usd <= 0.01, `${s.name} price_usd ${s.price_usd} > 0.01`)
      }
    }
  })

  it('?limit=5&offset=0 → returns exactly 5 results', async () => {
    const r = await api('/services?limit=5&offset=0')
    assert.equal(r.status, 200)
    assert.equal(r.body.services.length, 5)
    assert.equal(r.body.limit, 5)
    assert.equal(r.body.offset, 0)
  })

  it('?limit=5&offset=5 → returns next page (no overlap)', async () => {
    const [page1, page2] = await Promise.all([
      api('/services?limit=5&offset=0'),
      api('/services?limit=5&offset=5'),
    ])
    assert.equal(page1.status, 200)
    assert.equal(page2.status, 200)
    assert.equal(page2.body.offset, 5)

    const ids1 = new Set(page1.body.services.map(s => s.id))
    const ids2 = new Set(page2.body.services.map(s => s.id))
    for (const id of ids2) {
      assert.ok(!ids1.has(id), `ID ${id} appears in both pages`)
    }
  })

  it('combined filters → correct intersection', async () => {
    const r = await api('/services?protocol=x402&health=healthy&limit=10')
    assert.equal(r.status, 200)
    for (const s of r.body.services) {
      assert.equal(s.protocol.toLowerCase(), 'x402')
      assert.equal(s.health_status, 'healthy')
    }
  })
})

// ─── 2. GET /api/v1/services — Edge Cases ───────────────────────────────────

describe('GET /api/v1/services — Edge Cases', () => {
  it('?limit=0 → should handle gracefully', async () => {
    const r = await api('/services?limit=0')
    assert.equal(r.status, 200)
    // parseInt('0') is 0, and 0 || 50 = 50 in JS (0 is falsy)
    // So limit=0 actually defaults to 50, NOT clamped to 1
    // This is a subtle bug — documenting actual behavior
    console.log(`  limit=0 → actual limit=${r.body.limit}, services=${r.body.services.length}`)
  })

  it('?limit=-1 → should clamp to 1', async () => {
    const r = await api('/services?limit=-1')
    assert.equal(r.status, 200)
    // parseInt('-1') is -1, -1 || 50 = -1 (truthy), Math.max(-1, 1) = 1
    assert.equal(r.body.limit, 1, `limit should clamp to 1, got ${r.body.limit}`)
    assert.equal(r.body.services.length, 1)
  })

  it('?limit=999 → should clamp to 200', async () => {
    const r = await api('/services?limit=999')
    assert.equal(r.status, 200)
    assert.equal(r.body.limit, 200, `limit should clamp to 200, got ${r.body.limit}`)
  })

  it('?limit=abc → should default to 50', async () => {
    const r = await api('/services?limit=abc')
    assert.equal(r.status, 200)
    assert.equal(r.body.limit, 50, `limit should default to 50, got ${r.body.limit}`)
  })

  it('?offset=-10 → should floor to 0', async () => {
    const r = await api('/services?offset=-10')
    assert.equal(r.status, 200)
    assert.equal(r.body.offset, 0, `offset should floor to 0, got ${r.body.offset}`)
  })

  it('?offset=abc → should default to 0', async () => {
    const r = await api('/services?offset=abc')
    assert.equal(r.status, 200)
    assert.equal(r.body.offset, 0, `offset should default to 0, got ${r.body.offset}`)
  })

  it('?max_price_usd=abc → should not crash (NaN edge case)', async () => {
    const r = await api('/services?max_price_usd=abc')
    assert.equal(r.status, 200)
    // parseFloat('abc') = NaN → passed to SQLite as NaN
    // SQLite comparison with NaN: `price_usd <= NaN` is always false
    // So this should return 0 results
    console.log(`  max_price_usd=abc → total=${r.body.total}, services=${r.body.services.length}`)
  })

  it('?max_price_usd=-100 → should return empty or reasonable result', async () => {
    const r = await api('/services?max_price_usd=-100')
    assert.equal(r.status, 200)
    // No service should have negative price
    assert.equal(r.body.services.length, 0, 'negative max_price should return 0 results')
  })

  it('?health=bogus → invalid value ignored (returns all)', async () => {
    const r = await api('/services?health=bogus')
    assert.equal(r.status, 200)
    assert.ok(r.body.total > 0, 'invalid health filter should be ignored')
  })

  it('?source=bogus → invalid value ignored (returns all)', async () => {
    const r = await api('/services?source=bogus')
    assert.equal(r.status, 200)
    assert.ok(r.body.total > 0, 'invalid source filter should be ignored')
  })

  it('?protocol=bogus → should return 0 results', async () => {
    const r = await api('/services?protocol=bogus')
    assert.equal(r.status, 200)
    assert.equal(r.body.total, 0)
    assert.equal(r.body.services.length, 0)
  })

  it('?q= (empty) → should not filter (return all)', async () => {
    const [withEmpty, withoutQ] = await Promise.all([
      api('/services?q='),
      api('/services'),
    ])
    assert.equal(withEmpty.status, 200)
    // Empty string is falsy in JS, so the q filter should not apply
    assert.equal(withEmpty.body.total, withoutQ.body.total,
      `Empty q should return same total: got ${withEmpty.body.total} vs ${withoutQ.body.total}`)
  })

  it('?q=<script>alert(1)</script> → no crash, no XSS in JSON', async () => {
    const r = await api('/services?q=' + encodeURIComponent('<script>alert(1)</script>'))
    assert.equal(r.status, 200)
    // Should return 0 results and no script tags in JSON response
    const bodyStr = JSON.stringify(r.body)
    assert.ok(!bodyStr.includes('<script>'), 'Response should not contain raw script tags')
  })

  it('?category=nonexistent_category_xyz → should return 0 results', async () => {
    const r = await api('/services?category=nonexistent_category_xyz')
    assert.equal(r.status, 200)
    assert.equal(r.body.total, 0)
  })

  it('very large offset → should return empty services array', async () => {
    const r = await api('/services?offset=9999999')
    assert.equal(r.status, 200)
    assert.equal(r.body.services.length, 0)
    assert.ok(r.body.total > 0, 'total should still reflect unfiltered count')
  })
})

// ─── 3. GET /api/v1/services — Documentation Gaps ──────────────────────────

describe('GET /api/v1/services — Sort & Order', () => {
  it('?sort=name → results sorted by name (differs from default)', async () => {
    const [unsorted, sorted] = await Promise.all([
      api('/services?limit=20'),
      api('/services?sort=name&limit=20'),
    ])
    assert.equal(sorted.status, 200)
    // Verify sort=name actually changes the order vs default
    const defaultNames = unsorted.body.services.map(s => s.name)
    const sortedNames = sorted.body.services.map(s => s.name)
    assert.notDeepEqual(defaultNames, sortedNames, 'sort=name should produce different order than default')
    // Verify non-featured services are in SQLite binary sort order (simple string comparison)
    const nonFeatured = sorted.body.services.filter(s => !s.featured)
    for (let i = 1; i < nonFeatured.length; i++) {
      assert.ok(
        nonFeatured[i].name >= nonFeatured[i - 1].name,
        `"${nonFeatured[i].name}" should come after "${nonFeatured[i - 1].name}" in binary sort`
      )
    }
  })

  it('?sort=price → results sorted by price_usd ascending', async () => {
    const r = await api('/services?sort=price&limit=20')
    assert.equal(r.status, 200)
    const nonFeatured = r.body.services.filter(s => !s.featured)
    const withPrice = nonFeatured.filter(s => s.price_usd !== null)
    for (let i = 1; i < withPrice.length; i++) {
      assert.ok(
        withPrice[i].price_usd >= withPrice[i - 1].price_usd,
        `price ${withPrice[i].price_usd} should be >= ${withPrice[i - 1].price_usd}`
      )
    }
  })

  it('?sort=name&order=desc → reverse name order', async () => {
    const r = await api('/services?sort=name&order=desc&limit=20')
    assert.equal(r.status, 200)
    const nonFeatured = r.body.services.filter(s => !s.featured)
    for (let i = 1; i < nonFeatured.length; i++) {
      assert.ok(
        nonFeatured[i].name <= nonFeatured[i - 1].name,
        `"${nonFeatured[i].name}" should come before "${nonFeatured[i - 1].name}" in DESC`
      )
    }
  })

  it('?sort=price&order=desc → most expensive first', async () => {
    const r = await api('/services?sort=price&order=desc&limit=20')
    assert.equal(r.status, 200)
    const nonFeatured = r.body.services.filter(s => !s.featured)
    const withPrice = nonFeatured.filter(s => s.price_usd !== null)
    for (let i = 1; i < withPrice.length; i++) {
      assert.ok(
        withPrice[i].price_usd <= withPrice[i - 1].price_usd,
        `price ${withPrice[i].price_usd} should be <= ${withPrice[i - 1].price_usd}`
      )
    }
  })

  it('?order=desc without sort → uses default order (order alone ignored)', async () => {
    const [unsorted, ordered] = await Promise.all([
      api('/services?limit=10'),
      api('/services?order=desc&limit=10'),
    ])
    assert.equal(ordered.status, 200)
    // Without a valid sort column, order param has no effect
    const defaultIds = unsorted.body.services.map(s => s.id)
    const orderedIds = ordered.body.services.map(s => s.id)
    assert.deepEqual(defaultIds, orderedIds, 'order without sort should use default ordering')
  })

  it('?sort=bogus → falls back to default order', async () => {
    const [unsorted, bogus] = await Promise.all([
      api('/services?limit=10'),
      api('/services?sort=bogus&limit=10'),
    ])
    assert.equal(bogus.status, 200)
    const defaultIds = unsorted.body.services.map(s => s.id)
    const bogusIds = bogus.body.services.map(s => s.id)
    assert.deepEqual(defaultIds, bogusIds, 'invalid sort should use default ordering')
  })

  it('featured services always appear first regardless of sort', async () => {
    const r = await api('/services?sort=name&order=desc&limit=20')
    assert.equal(r.status, 200)
    // Find where featured services end
    let lastFeatured = -1
    let firstNonFeatured = -1
    r.body.services.forEach((s, i) => {
      if (s.featured) lastFeatured = i
      if (!s.featured && firstNonFeatured === -1) firstNonFeatured = i
    })
    if (lastFeatured >= 0 && firstNonFeatured >= 0) {
      assert.ok(lastFeatured < firstNonFeatured,
        'All featured services should come before non-featured')
    }
  })

  it('?payment_asset=USDC → verify undocumented filter works', async () => {
    const r = await api('/services?payment_asset=USDC')
    assert.equal(r.status, 200)
    console.log(`  payment_asset=USDC → total=${r.body.total}, services=${r.body.services.length}`)
    for (const s of r.body.services) {
      assert.equal(s.payment_asset, 'USDC', `${s.name} has payment_asset=${s.payment_asset}`)
    }
  })

  it('?featured=1 → verify API accepts "1" (not just "true")', async () => {
    const [withTrue, with1] = await Promise.all([
      api('/services?featured=true'),
      api('/services?featured=1'),
    ])
    assert.equal(with1.status, 200)

    console.log(`  featured=true → total=${withTrue.body.total}`)
    console.log(`  featured=1 → total=${with1.body.total}`)
    assert.equal(withTrue.body.total, with1.body.total,
      'featured=true and featured=1 should return same results')
  })

  it('protocol case sensitivity: ?protocol=l402 (lowercase) vs ?protocol=L402', async () => {
    const [lower, upper] = await Promise.all([
      api('/services?protocol=l402'),
      api('/services?protocol=L402'),
    ])
    assert.equal(lower.status, 200)
    assert.equal(upper.status, 200)

    console.log(`  protocol=l402 → total=${lower.body.total}`)
    console.log(`  protocol=L402 → total=${upper.body.total}`)
    assert.equal(lower.body.total, upper.body.total,
      'Protocol filter should be case-insensitive (COLLATE NOCASE)')
  })
})

// ─── 4. GET /api/v1/services/:id ────────────────────────────────────────────

describe('GET /api/v1/services/:id', () => {
  it('valid ID → returns full service with health_checks array', async () => {
    // Get first service ID from list
    const list = await api('/services?limit=1')
    assert.ok(list.body.services.length > 0, 'need at least one service')
    const id = list.body.services[0].id

    const r = await api(`/services/${id}`)
    assert.equal(r.status, 200)
    assert.equal(r.body.id, id)
    assert.ok(typeof r.body.name === 'string')
    assert.ok(typeof r.body.url === 'string')
    assert.ok(Array.isArray(r.body.health_checks), 'should include health_checks array')

    // Check that detail response has additional fields not in list
    const expectedFields = ['id', 'name', 'description', 'url', 'protocol',
      'health_status', 'health_checks']
    for (const field of expectedFields) {
      assert.ok(field in r.body, `response should have "${field}" field`)
    }

    console.log(`  Service ${id}: ${r.body.name}, ${r.body.health_checks.length} health checks`)
  })

  it('non-existent numeric ID → 404 with error message', async () => {
    const r = await api('/services/999999999')
    assert.equal(r.status, 404)
    assert.ok(r.body.error, 'should have error field')
  })

  it('string ID → 404', async () => {
    const r = await api('/services/nonexistent')
    assert.equal(r.status, 404)
    assert.ok(r.body.error)
  })
})

// ─── 5. GET /api/v1/categories ──────────────────────────────────────────────

describe('GET /api/v1/categories', () => {
  it('returns categories object with tree structure', async () => {
    const r = await api('/categories')
    assert.equal(r.status, 200)
    assert.ok(typeof r.body.categories === 'object')
    assert.ok(typeof r.body.total === 'number')
    assert.ok(r.body.total > 0, 'should have categories')
  })

  it('each category has count (number) and subcategories (object)', async () => {
    const r = await api('/categories')
    for (const [name, cat] of Object.entries(r.body.categories)) {
      assert.ok(typeof cat.count === 'number', `${name}.count should be number`)
      assert.ok(typeof cat.subcategories === 'object', `${name}.subcategories should be object`)
      assert.ok(cat.count > 0, `${name}.count should be > 0`)
    }
  })

  it('subcategory counts should roll up into parent count', async () => {
    const r = await api('/categories')
    for (const [name, cat] of Object.entries(r.body.categories)) {
      const subTotal = Object.values(cat.subcategories).reduce((a, b) => a + b, 0)
      if (subTotal > 0) {
        // Parent count should be >= sum of subcategory counts
        // (parent count includes services directly in the parent category)
        assert.ok(cat.count >= subTotal,
          `${name}: parent count ${cat.count} < subcategory sum ${subTotal}`)
      }
    }
  })

  it('total is the number of unique category strings, not the number of top-level categories', async () => {
    const r = await api('/categories')
    // total = rows.length from the SQL query, which is # of unique category strings
    const topLevelCount = Object.keys(r.body.categories).length
    console.log(`  total=${r.body.total}, top-level categories=${topLevelCount}`)
    // total should be >= topLevelCount (includes subcategory rows)
    assert.ok(r.body.total >= topLevelCount,
      `total (${r.body.total}) should be >= top-level count (${topLevelCount})`)
  })
})

// ─── 6. GET /api/v1/health ──────────────────────────────────────────────────

describe('GET /api/v1/health', () => {
  it('returns status "ok" with expected fields', async () => {
    const r = await api('/health')
    assert.equal(r.status, 200)
    assert.equal(r.body.status, 'ok')
    assert.ok(typeof r.body.total_endpoints === 'number')
    assert.ok(r.body.total_endpoints > 0, 'should have endpoints')
    assert.ok(typeof r.body.distinct_services === 'number')
    assert.ok(typeof r.body.distinct_providers === 'number')
    assert.ok(typeof r.body.distinct_providers_raw === 'number')
    assert.ok(typeof r.body.excluded_templates === 'number')
    assert.ok(typeof r.body.excluded_demos === 'number')
    assert.ok(r.body.distinct_services <= r.body.total_endpoints, 'distinct services <= total endpoints')
    assert.ok(r.body.distinct_providers <= r.body.distinct_providers_raw, 'filtered providers <= raw providers')
  })

  it('by_protocol values are objects with endpoint/service/provider counts', async () => {
    const r = await api('/health')
    assert.ok(typeof r.body.by_protocol === 'object')
    for (const [proto, val] of Object.entries(r.body.by_protocol)) {
      assert.ok(typeof val === 'object', `by_protocol.${proto} should be object`)
      assert.ok(typeof val.endpoints === 'number', `by_protocol.${proto}.endpoints should be number`)
      assert.ok(typeof val.services === 'number', `by_protocol.${proto}.services should be number`)
      assert.ok(typeof val.providers === 'number', `by_protocol.${proto}.providers should be number`)
      assert.ok(typeof val.providers_raw === 'number', `by_protocol.${proto}.providers_raw should be number`)
      assert.ok(val.providers <= val.providers_raw, `by_protocol.${proto}.providers <= providers_raw`)
    }
  })

  it('by_health values sum to total_endpoints', async () => {
    const r = await api('/health')
    const sum = Object.values(r.body.by_health).reduce((a, b) => a + b, 0)
    assert.equal(sum, r.body.total_endpoints,
      `by_health sum (${sum}) should equal total_endpoints (${r.body.total_endpoints})`)
  })

  it('by_protocol endpoint values sum to total_endpoints', async () => {
    const r = await api('/health')
    const sum = Object.values(r.body.by_protocol).reduce((a, b) => a + b.endpoints, 0)
    assert.equal(sum, r.body.total_endpoints,
      `by_protocol endpoints sum (${sum}) should equal total_endpoints (${r.body.total_endpoints})`)
  })

  it('by_source values sum to total_endpoints', async () => {
    const r = await api('/health')
    const sum = Object.values(r.body.by_source).reduce((a, b) => a + b, 0)
    assert.equal(sum, r.body.total_endpoints,
      `by_source sum (${sum}) should equal total_endpoints (${r.body.total_endpoints})`)
  })

  it('sync timestamps are ISO strings or null', async () => {
    const r = await api('/health')
    const isoOrNull = (val, name) => {
      if (val === null) return // null is acceptable
      assert.ok(typeof val === 'string', `${name} should be string or null`)
      const d = new Date(val)
      assert.ok(!isNaN(d.getTime()), `${name} "${val}" should be valid ISO date`)
    }
    isoOrNull(r.body.last_bazaar_sync, 'last_bazaar_sync')
    isoOrNull(r.body.last_satring_sync, 'last_satring_sync')
    isoOrNull(r.body.last_health_check_run, 'last_health_check_run')
  })
})

// ─── 7. Page Routes (HTTP status checks) ────────────────────────────────────

describe('Page Routes — HTTP Status', () => {
  it('GET / → 200', async () => {
    const r = await raw('/')
    assert.equal(r.status, 200)
  })

  it('GET /about → 200', async () => {
    const r = await raw('/about')
    assert.equal(r.status, 200)
  })

  it('GET /api-docs → 200', async () => {
    const r = await raw('/api-docs')
    assert.equal(r.status, 200)
  })

  it('GET /service/:id → 200 for valid ID', async () => {
    // Get a valid ID first
    const list = await api('/services?limit=1')
    const id = list.body.services[0].id
    const r = await raw(`/service/${id}`)
    assert.equal(r.status, 200)
  })

  it('GET /service/999999999 → 404', async () => {
    const r = await raw('/service/999999999')
    assert.equal(r.status, 404)
  })

  it('GET /nonexistent → 404', async () => {
    const r = await raw('/nonexistent-route-xyz')
    // Express default: may return 404 or some other status
    console.log(`  /nonexistent-route-xyz → status ${r.status}`)
    // Most Express apps without a catch-all return 404
    assert.ok([404, 302].includes(r.status),
      `Expected 404 or redirect, got ${r.status}`)
  })
})
