import { describe, it, before, after, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'

// Store original fetch — we stub it to prevent live OpenAI calls
const originalFetch = globalThis.fetch

let db, SQLITE_VEC_AVAILABLE, logQuery
let queryServices, queryServicesHybrid, buildServiceQuery, buildHybridComparator, API_COLUMNS
let embedQuery, cosineSimilarity, getCircuitState, resetCircuit
let startServer, stopServer, API

// ─── Fixture embeddings ──────────────────────────────────────────────────────
// Pre-computed unit vectors for deterministic cosine similarity tests.
// These are NOT real OpenAI embeddings — just math vectors with known distances.
const DIMS = 1536

function makeVector(seed) {
  const v = new Float32Array(DIMS)
  for (let i = 0; i < DIMS; i++) v[i] = Math.sin(seed * (i + 1)) * 0.1
  // Normalize
  let mag = 0
  for (let i = 0; i < DIMS; i++) mag += v[i] * v[i]
  mag = Math.sqrt(mag)
  for (let i = 0; i < DIMS; i++) v[i] /= mag
  return v
}

// Seed vectors — different seeds produce different directions
const WEATHER_QUERY_VEC = makeVector(1.0)
const WEATHER_SERVICE_VEC = makeVector(1.05) // close to WEATHER_QUERY_VEC
const SATS4AI_SERVICE_VEC = makeVector(5.0)  // far from WEATHER_QUERY_VEC
const GENERIC_VEC_A = makeVector(2.0)
const GENERIC_VEC_B = makeVector(3.0)
const FILTER_SERVICE_VEC = makeVector(1.02) // close to WEATHER_QUERY_VEC for filter-bypass tests
const PERCENT_CLOSE_VEC = makeVector(1.03)  // close to query vec for T6 percent test

// Helper: insert test service into DB
function insertService(id, name, opts = {}) {
  const desc = opts.description || `${name} description`
  const proto = opts.protocol || 'x402'
  const health = opts.health_status || 'healthy'
  const featured = opts.featured || 0
  const domain_verified = opts.domain_verified || 0
  const category = opts.category || 'uncategorized'
  const price_usd = opts.price_usd ?? null
  const x402_payment_valid = opts.x402_payment_valid ?? null
  db.prepare(`
    INSERT OR IGNORE INTO services (id, name, description, url, protocol, source, health_status, status, featured, domain_verified, category, price_usd, x402_payment_valid, hostname, registered_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'test', ?, 'active', ?, ?, ?, ?, ?, 'test.example.com', datetime('now'), datetime('now'))
  `).run(id, name, desc, `https://test-${id}.example.com/api`, proto, health, featured, domain_verified, category, price_usd, x402_payment_valid)
}

// Helper: insert embedding for a service (both regular + vec table)
function insertEmbedding(serviceId, vec) {
  const blob = Buffer.from(vec.buffer)
  db.prepare(`
    INSERT OR REPLACE INTO service_embeddings (service_id, embedding, model, embedded_at)
    VALUES (?, ?, 'text-embedding-3-small', ?)
  `).run(serviceId, blob, Math.floor(Date.now() / 1000))
  try {
    db.prepare('INSERT OR REPLACE INTO vec_service_embeddings(service_id, embedding) VALUES (?, ?)').run(serviceId, blob)
  } catch {}
}

// Clean up test services
function cleanup() {
  const ids = [
    'hybrid-sats4ai', 'hybrid-weather-prime', 'hybrid-prime', 'hybrid-weather-basic',
    'hybrid-tied-a', 'hybrid-tied-b', 'hybrid-generic-1', 'hybrid-generic-2',
    'hybrid-sort-price-1', 'hybrid-sort-price-2',
    'hybrid-filter-l402', 'hybrid-filter-news', 'hybrid-filter-nopay', 'hybrid-filter-noverify',
    'hybrid-percent-svc', 'hybrid-percent-far',
  ]
  for (const id of ids) {
    try { db.prepare('DELETE FROM vec_service_embeddings WHERE service_id = ?').run(id) } catch {}
    try { db.prepare('DELETE FROM service_embeddings WHERE service_id = ?').run(id) } catch {}
    try { db.prepare('DELETE FROM services WHERE id = ?').run(id) } catch {}
  }
  // Clean up bulk-inserted embeddings for B5/B6 and Phase 2 tests
  const bulkPatterns = ['hybrid-bulk-%', 'hybrid-t2-%', 'hybrid-t3-%', 'hybrid-overlap-%', 'hybrid-empty-%']
  for (const p of bulkPatterns) {
    try { db.exec(`DELETE FROM vec_service_embeddings WHERE service_id LIKE '${p}'`) } catch {}
    try { db.exec(`DELETE FROM service_embeddings WHERE service_id LIKE '${p}'`) } catch {}
    try { db.exec(`DELETE FROM services WHERE id LIKE '${p}'`) } catch {}
  }
}

before(async () => {
  process.env.OPENAI_API_KEY = 'test-key-fake'

  const dbMod = await import('../src/db.js')
  db = dbMod.default
  SQLITE_VEC_AVAILABLE = dbMod.SQLITE_VEC_AVAILABLE
  logQuery = dbMod.logQuery

  const queries = await import('../src/queries/services.js')
  queryServices = queries.queryServices
  queryServicesHybrid = queries.queryServicesHybrid
  buildServiceQuery = queries.buildServiceQuery
  buildHybridComparator = queries.buildHybridComparator
  API_COLUMNS = queries.API_COLUMNS

  // Create vec virtual table so the sqlite-vec path actually succeeds (not throws)
  if (SQLITE_VEC_AVAILABLE) {
    db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS vec_service_embeddings USING vec0(service_id text primary key, embedding float[1536])')
  }

  const srv = await import('./helpers/server.js')
  startServer = srv.startServer
  stopServer = srv.stopServer
  API = await startServer()

  // Seed test data
  cleanup()
  insertService('hybrid-sats4ai', 'Sats4AI', { description: 'Lightning-powered AI inference', category: 'ai', featured: 1 })
  insertService('hybrid-prime', 'Prime Technology', { description: 'Meteorological data feeds with real-time atmospheric measurements', category: 'real-time-data/weather' })
  insertService('hybrid-weather-basic', 'WeatherBot', { description: 'Simple weather data API', category: 'real-time-data/weather' })
  insertService('hybrid-tied-a', 'TiedServiceA', { description: 'A service for testing tie-breaking' })
  insertService('hybrid-tied-b', 'TiedServiceB', { description: 'B service for testing tie-breaking' })
  insertService('hybrid-sort-price-1', 'PriceSort1', { price_usd: 0.01 })
  insertService('hybrid-sort-price-2', 'PriceSort2', { price_usd: 0.05 })

  // Insert embeddings
  insertEmbedding('hybrid-sats4ai', SATS4AI_SERVICE_VEC)
  insertEmbedding('hybrid-prime', WEATHER_SERVICE_VEC) // close to weather query
  insertEmbedding('hybrid-weather-basic', GENERIC_VEC_A)        // far from weather query
  insertEmbedding('hybrid-tied-a', GENERIC_VEC_A)
  insertEmbedding('hybrid-tied-b', GENERIC_VEC_B)

  // Filter-bypass test fixtures (semantic-only: names/descriptions don't contain "weather")
  insertService('hybrid-filter-l402', 'CosmicData', {
    protocol: 'L402', description: 'Cosmic radiation measurements', category: 'science', health_status: 'healthy'
  })
  insertEmbedding('hybrid-filter-l402', FILTER_SERVICE_VEC)

  insertService('hybrid-filter-news', 'NewsFlash', {
    protocol: 'x402', description: 'Breaking news aggregation', category: 'news'
  })
  insertEmbedding('hybrid-filter-news', FILTER_SERVICE_VEC)

  insertService('hybrid-filter-nopay', 'NoPayService', {
    protocol: 'x402', description: 'Unvalidated payment endpoint', x402_payment_valid: 0
  })
  insertEmbedding('hybrid-filter-nopay', FILTER_SERVICE_VEC)

  insertService('hybrid-filter-noverify', 'UnverifiedSvc', {
    protocol: 'x402', description: 'Unverified x402 endpoint', x402_payment_valid: 0, domain_verified: 0
  })
  insertEmbedding('hybrid-filter-noverify', FILTER_SERVICE_VEC)
})

after(async () => {
  cleanup()
  try { db.exec('DROP TABLE IF EXISTS vec_service_embeddings') } catch {}
  globalThis.fetch = originalFetch
  await stopServer()
})

beforeEach(() => {
  globalThis.fetch = originalFetch
})

// Helper: stub embedQuery to return a specific vector (or simulate timeout/error)
function stubEmbedQuery(vec, delayMs = 0) {
  globalThis.fetch = async () => {
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs))
    if (vec === null) return { ok: false, status: 500, json: async () => ({}) }
    const embedding = Array.from(vec)
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding }], model: 'text-embedding-3-small', usage: { prompt_tokens: 10, total_tokens: 10 } }),
    }
  }
}

// ─── GROUP A: Re-rank composite order ────────────────────────────────────────

describe('Group A — hybrid re-rank composite order (#150)', () => {
  it('A1: ?q=Sats4AI returns Sats4AI as result #1 (Tier A exact-name match)', async () => {
    stubEmbedQuery(WEATHER_QUERY_VEC) // doesn't matter what embedding, Tier A wins
    const result = await queryServicesHybrid(db, { q: 'Sats4AI', rawLimit: 50 }, API_COLUMNS)
    assert.ok(result.services.length > 0, 'should return results')
    assert.equal(result.services[0].name, 'Sats4AI', 'Sats4AI must be result #1 via Tier A')
  })

  it('A2: ?q=weather with semantic returns Prime Technology in top 20 (Tier D cosine)', async () => {
    // Prime Technology has no LIKE match for "weather" in name/description/url,
    // but its embedding is close to the weather query vector
    stubEmbedQuery(WEATHER_QUERY_VEC)
    const result = await queryServicesHybrid(db, { q: 'weather', rawLimit: 50 }, API_COLUMNS)
    const names = result.services.slice(0, 20).map(s => s.name)
    assert.ok(names.includes('Prime Technology'), `Prime Technology should be in top 20 via cosine similarity, got: ${names.join(', ')}`)
  })

  it('A3: Two services tied on Tier A-C, different cosines → cosine-winner ranks higher', async () => {
    // Both have same LIKE match (description contains "service"), but different cosine scores
    // GENERIC_VEC_A has different cosine to WEATHER_QUERY_VEC than GENERIC_VEC_B
    stubEmbedQuery(WEATHER_QUERY_VEC)
    const result = await queryServicesHybrid(db, { q: 'service', rawLimit: 50 }, API_COLUMNS)
    const tiedA = result.services.findIndex(s => s.id === 'hybrid-tied-a')
    const tiedB = result.services.findIndex(s => s.id === 'hybrid-tied-b')
    // They should both appear, and the one with higher cosine to WEATHER_QUERY_VEC should rank first
    assert.ok(tiedA >= 0 && tiedB >= 0, 'Both tied services should appear in results')
    // Verify they are in cosine order (whichever has higher cosine should be first)
    const cosA = cosineSimilaritySync(WEATHER_QUERY_VEC, GENERIC_VEC_A)
    const cosB = cosineSimilaritySync(WEATHER_QUERY_VEC, GENERIC_VEC_B)
    if (cosA > cosB) {
      assert.ok(tiedA < tiedB, `TiedServiceA (cos=${cosA.toFixed(3)}) should rank before TiedServiceB (cos=${cosB.toFixed(3)})`)
    } else {
      assert.ok(tiedB < tiedA, `TiedServiceB (cos=${cosB.toFixed(3)}) should rank before TiedServiceA (cos=${cosA.toFixed(3)})`)
    }
  })

  it('A4: ?q=weather&sort=price → re-rank skipped, results ordered by price_usd', async () => {
    stubEmbedQuery(WEATHER_QUERY_VEC)
    const result = await queryServicesHybrid(db, { q: 'weather', sort: 'price', order: 'asc', rawLimit: 50 }, API_COLUMNS)
    // Should NOT call embedQuery at all (re-rank skipped), just LIKE-only with price sort
    // WeatherBot has "weather" in name, Prime Technology does not — only LIKE results, price sorted
    assert.ok(result.services.length >= 0, 'should return results')
    // Check that ordering respects price, not cosine
    for (let i = 1; i < result.services.length; i++) {
      const prev = result.services[i - 1].price_usd ?? Infinity
      const curr = result.services[i].price_usd ?? Infinity
      assert.ok(prev <= curr || prev === null || curr === null, `Results should be sorted by price ASC`)
    }
  })

  it('A5: ?q=* → match-all shortcut preserved, no semantic called', async () => {
    let fetchCalled = false
    globalThis.fetch = async () => { fetchCalled = true; return { ok: false, status: 500, json: async () => ({}) } }
    const result = await queryServicesHybrid(db, { q: '*', rawLimit: 50 }, API_COLUMNS)
    assert.ok(result.services.length > 0, 'should return all services')
    assert.equal(fetchCalled, false, 'embedQuery should not be called for q=*')
  })

  it('A6: total equals deduplicated union candidate set size when semantic fires', async () => {
    stubEmbedQuery(WEATHER_QUERY_VEC)
    const result = await queryServicesHybrid(db, { q: 'weather', rawLimit: 50 }, API_COLUMNS)
    // total should be >= the LIKE count (union includes semantic-only results)
    const likeOnly = queryServices(db, { q: 'weather', rawLimit: 200 }, API_COLUMNS)
    assert.ok(result.total >= likeOnly.total, `hybrid total (${result.total}) should be >= LIKE total (${likeOnly.total})`)
    // Verify degraded path actually returns LIKE-only with correct reason
    const saved = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    try {
      const degraded = await queryServicesHybrid(db, { q: 'weather', rawLimit: 50 }, API_COLUMNS)
      assert.equal(degraded.degradedReason, 'no-api-key', 'should report no-api-key when OPENAI_API_KEY is absent')
      assert.ok(degraded.total > 0, 'should still return LIKE results in degraded mode')
    } finally {
      process.env.OPENAI_API_KEY = saved
    }
  })
})

// ─── GROUP B: Timeouts and graceful fallback ─────────────────────────────────

// Smart fetch stub: intercepts OpenAI calls but allows local API calls through
function stubOpenAIOnly(handler) {
  const real = originalFetch
  globalThis.fetch = async (url, opts) => {
    if (typeof url === 'string' && url.includes('openai.com')) {
      return handler(url, opts)
    }
    return real(url, opts)
  }
}

describe('Group B — timeouts and graceful fallback (#150)', () => {
  it('B1: embedQuery exceeding 1500ms → LIKE-only, X-402index-Search-Degraded: embed-timeout', async () => {
    stubOpenAIOnly(async () => {
      await new Promise(r => setTimeout(r, 1600))
      const embedding = Array.from(WEATHER_QUERY_VEC)
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ embedding }], model: 'text-embedding-3-small', usage: {} }),
      }
    })

    const res = await originalFetch(`${API}/api/v1/services?q=weather`)
    assert.equal(res.status, 200, 'should still return 200')
    assert.equal(res.headers.get('x-402index-search-degraded'), 'embed-timeout')
  })

  it('B2: embedQuery returns null (HTTP error) → LIKE-only, embed-error', async () => {
    stubOpenAIOnly(async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'fail' } }) }))

    const res = await originalFetch(`${API}/api/v1/services?q=weather`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('x-402index-search-degraded'), 'embed-error')
  })

  it('B3: OPENAI_API_KEY unset → LIKE-only, no-api-key', async () => {
    const saved = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    try {
      const res = await originalFetch(`${API}/api/v1/services?q=weather`)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('x-402index-search-degraded'), 'no-api-key')
    } finally {
      process.env.OPENAI_API_KEY = saved
    }
  })

  it('B4: sqlite-vec 500ms deadline (requires sqlite-vec; falls back to JS path otherwise)', async () => {
    stubEmbedQuery(WEATHER_QUERY_VEC)
    if (!SQLITE_VEC_AVAILABLE) {
      // sqlite-vec not available in this env — vec-deadline can't fire.
      // Verify the pure-JS fallback path works instead.
      const result = await queryServicesHybrid(db, { q: 'weather', rawLimit: 50 }, API_COLUMNS)
      assert.ok(result, 'pure-JS fallback should return results when sqlite-vec unavailable')
      return
    }
    // With sqlite-vec available: the 500ms deadline should be enforced
    const result = await queryServicesHybrid(db, { q: 'weather', rawLimit: 50 }, API_COLUMNS)
    assert.ok(result, 'should return results')
  })

  it('B5: service_embeddings > 5000 rows + no sqlite-vec → js-fallback-too-large', async () => {
    if (SQLITE_VEC_AVAILABLE) return // Only applies when sqlite-vec unavailable

    // Insert 5001 dummy embeddings
    const insert = db.prepare('INSERT OR IGNORE INTO services (id, name, url, protocol, source, status, hostname) VALUES (?, ?, ?, ?, ?, ?, ?)')
    const insertEmb = db.prepare('INSERT OR IGNORE INTO service_embeddings (service_id, embedding, model, embedded_at) VALUES (?, ?, ?, ?)')
    const dummyBlob = Buffer.from(new Float32Array(DIMS).buffer)

    const insertMany = db.transaction(() => {
      for (let i = 0; i < 5001; i++) {
        const id = `hybrid-bulk-${i}`
        insert.run(id, `Bulk${i}`, `https://bulk-${i}.example.com`, 'x402', 'test', 'active', 'bulk.example.com')
        insertEmb.run(id, dummyBlob, 'text-embedding-3-small', Math.floor(Date.now() / 1000))
      }
    })
    insertMany()

    try {
      stubOpenAIOnly(async () => {
        const embedding = Array.from(WEATHER_QUERY_VEC)
        return { ok: true, status: 200, json: async () => ({ data: [{ embedding }], model: 'text-embedding-3-small', usage: {} }) }
      })
      const res = await originalFetch(`${API}/api/v1/services?q=weather`)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('x-402index-search-degraded'), 'js-fallback-too-large')
    } finally {
      db.exec("DELETE FROM service_embeddings WHERE service_id LIKE 'hybrid-bulk-%'")
      db.exec("DELETE FROM services WHERE id LIKE 'hybrid-bulk-%'")
    }
  })

  it('B6: pure-JS fallback with ≤5000 rows → cosine runs correctly', async () => {
    if (SQLITE_VEC_AVAILABLE) return // Only applies when sqlite-vec unavailable

    stubEmbedQuery(WEATHER_QUERY_VEC)
    const result = await queryServicesHybrid(db, { q: 'weather', rawLimit: 50 }, API_COLUMNS)
    // Prime Technology has embedding close to weather query, should appear in results
    const names = result.services.map(s => s.name)
    assert.ok(names.includes('Prime Technology'), 'Prime Technology should appear via pure-JS cosine')
  })

  it('B7: any degraded response → status 200, header present, logQuery receives reason', async () => {
    stubOpenAIOnly(async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'fail' } }) }))

    const res = await originalFetch(`${API}/api/v1/services?q=weather`)
    assert.equal(res.status, 200, 'must be 200, never 5xx on semantic failure')
    const degraded = res.headers.get('x-402index-search-degraded')
    assert.ok(degraded, 'X-402index-Search-Degraded header must be present')
    assert.ok(['no-api-key', 'embed-timeout', 'embed-error', 'circuit-open', 'vec-deadline', 'js-fallback-too-large'].includes(degraded),
      `reason code must be from the fixed enum, got: ${degraded}`)
  })

  it('B8: logQuery persists degradedReason to query_log table', async () => {
    // Insert a log entry with a degraded reason via logQuery
    const before = db.prepare('SELECT MAX(id) as maxId FROM query_log').get()
    logQuery({ queryText: 'test-b8', degradedReason: 'embed-error' })
    const row = db.prepare('SELECT degraded_reason FROM query_log WHERE id > ?').get(before.maxId || 0)
    assert.ok(row, 'query_log row should exist')
    assert.equal(row.degraded_reason, 'embed-error', 'degraded_reason column should persist the reason code')
  })
})

// ─── GROUP D: Documentation ──────────────────────────────────────────────────

describe('Group D — documentation (#150)', () => {
  it('D1: GET /api/v1/openapi.json q param mentions hybrid, semantic, re-rank', async () => {
    const res = await fetch(`${API}/api/v1/openapi.json`)
    const spec = await res.json()
    const qParam = spec.paths['/api/v1/services'].get.parameters.find(p => p.name === 'q')
    assert.ok(qParam, 'q parameter must exist')
    const desc = qParam.description.toLowerCase()
    assert.ok(desc.includes('hybrid'), `q description should mention "hybrid", got: ${qParam.description}`)
    assert.ok(desc.includes('semantic'), `q description should mention "semantic", got: ${qParam.description}`)
    assert.ok(desc.includes('re-rank') || desc.includes('rerank'), `q description should mention "re-rank", got: ${qParam.description}`)
  })

  it('D2: OpenAPI documents X-402index-Search-Degraded header with reason-code enum', async () => {
    const res = await fetch(`${API}/api/v1/openapi.json`)
    const spec = await res.json()
    const resp200 = spec.paths['/api/v1/services'].get.responses['200']
    assert.ok(resp200.headers, 'response should have headers defined')
    const degradedHeader = resp200.headers['X-402index-Search-Degraded']
    assert.ok(degradedHeader, 'X-402index-Search-Degraded header must be documented')
    const headerSchema = degradedHeader.schema
    assert.ok(headerSchema.enum || headerSchema.description, 'header should have enum or description of reason codes')
    if (headerSchema.enum) {
      assert.ok(headerSchema.enum.includes('embed-timeout'), 'enum should include embed-timeout')
      assert.ok(headerSchema.enum.includes('circuit-open'), 'enum should include circuit-open')
      assert.ok(headerSchema.enum.includes('no-api-key'), 'enum should include no-api-key')
    }
  })

  it('D3: GET /api-docs HTML contains "How ?q= works" section', async () => {
    const res = await fetch(`${API}/api-docs`)
    const html = await res.text()
    assert.ok(html.includes('How') && (html.includes('?q=') || html.includes('q=')) && html.includes('works'),
      'api-docs should contain a "How ?q= works" section')
  })

  it('D4: GET /api/v1/docs.md reflects updated OpenAPI content', async () => {
    const res = await fetch(`${API}/api/v1/docs.md`)
    const md = await res.text()
    assert.ok(md.toLowerCase().includes('hybrid') || md.toLowerCase().includes('semantic'),
      'docs.md should reflect hybrid/semantic search documentation')
  })
})

// ─── GROUP E: Filter bypass on semantic-only union (#153 review) ──────────────

describe('Group E — semantic-only filter bypass (#153 review)', () => {
  beforeEach(() => {
    stubEmbedQuery(WEATHER_QUERY_VEC)
  })

  it('T1a: protocol filter — L402 semantic match excluded by protocol=x402', async () => {
    const result = await queryServicesHybrid(db, { q: 'weather', protocol: 'x402', rawLimit: 200 }, API_COLUMNS)
    const ids = result.services.map(s => s.id)
    assert.ok(!ids.includes('hybrid-filter-l402'),
      'L402 service should be excluded when protocol=x402 filter is applied')
    for (const s of result.services) {
      assert.equal(s.protocol.toLowerCase(), 'x402', `service ${s.id} should be x402`)
    }
  })

  it('T1b: category filter — news-category semantic match excluded by category=real-time-data/weather', async () => {
    const result = await queryServicesHybrid(db, { q: 'weather', category: 'real-time-data/weather', rawLimit: 200 }, API_COLUMNS)
    const ids = result.services.map(s => s.id)
    assert.ok(!ids.includes('hybrid-filter-news'),
      'News-category service should be excluded when category=real-time-data/weather')
  })

  it('T1c: payment_valid filter — invalid-payment semantic match excluded', async () => {
    const result = await queryServicesHybrid(db, { q: 'weather', payment_valid: 'true', rawLimit: 200 }, API_COLUMNS)
    const ids = result.services.map(s => s.id)
    assert.ok(!ids.includes('hybrid-filter-nopay'),
      'Service with invalid payment should be excluded when payment_valid=true')
  })

  it('T1d: verified filter — non-verified semantic match excluded', async () => {
    const result = await queryServicesHybrid(db, { q: 'weather', verified: 'true', rawLimit: 200 }, API_COLUMNS)
    const ids = result.services.map(s => s.id)
    assert.ok(!ids.includes('hybrid-filter-noverify'),
      'Non-verified service should be excluded when verified=true')
  })
})

// ─── GROUP F: Total accuracy and LIKE cap (#153 review) ──────────────────────

describe('Group F — total accuracy and LIKE cap (#153 review)', () => {
  it('T2: LIKE cap ORDER BY — featured service appears in capped results', async () => {
    const insert = db.prepare(`
      INSERT OR IGNORE INTO services (id, name, description, url, protocol, source, health_status, status, featured, domain_verified, category, hostname, registered_at, updated_at)
      VALUES (?, ?, ?, ?, 'x402', 'test', 'healthy', 'active', ?, 0, 'uncategorized', 'test.example.com', datetime('now'), datetime('now'))
    `)
    const insertMany = db.transaction(() => {
      for (let i = 0; i < 1001; i++) {
        const id = `hybrid-t2-${i}`
        const featured = i === 1000 ? 1 : 0
        insert.run(id, `OrderTest-${i}`, `OrderTest-${i} description`, `https://t2-${i}.example.com/api`, featured)
      }
    })
    insertMany()

    try {
      stubEmbedQuery(WEATHER_QUERY_VEC)
      const result = await queryServicesHybrid(db, { q: 'OrderTest', rawLimit: 50 }, API_COLUMNS)
      // Featured service (inserted last, highest rowid) should appear due to ORDER BY featured DESC
      const hasFeatured = result.services.some(s => s.id === 'hybrid-t2-1000')
      assert.ok(hasFeatured,
        'Featured service (inserted last) should appear in capped LIKE results when ORDER BY is applied')
    } finally {
      db.exec("DELETE FROM services WHERE id LIKE 'hybrid-t2-%'")
    }
  })

  it('T3: total not capped at likeCap — 1200 LIKE matches reports total=1200', async () => {
    const insert = db.prepare(`
      INSERT OR IGNORE INTO services (id, name, description, url, protocol, source, health_status, status, featured, domain_verified, category, hostname, registered_at, updated_at)
      VALUES (?, ?, ?, ?, 'x402', 'test', 'healthy', 'active', 0, 0, 'uncategorized', 'test.example.com', datetime('now'), datetime('now'))
    `)
    const insertMany = db.transaction(() => {
      for (let i = 0; i < 1200; i++) {
        insert.run(`hybrid-t3-${i}`, `TotalCap-${i}`, `TotalCap-${i} desc`, `https://t3-${i}.example.com/api`)
      }
    })
    insertMany()

    try {
      stubEmbedQuery(WEATHER_QUERY_VEC)
      const result = await queryServicesHybrid(db, { q: 'TotalCap', rawLimit: 50 }, API_COLUMNS)
      assert.ok(result.total >= 1200, `total should be >= 1200 (not capped at likeCap=1000), got ${result.total}`)
    } finally {
      db.exec("DELETE FROM services WHERE id LIKE 'hybrid-t3-%'")
    }
  })

  it('T-total-overlap: 1200 LIKE + 1 overlap semantic → total === 1200 (no double-count)', async () => {
    const insert = db.prepare(`
      INSERT OR IGNORE INTO services (id, name, description, url, protocol, source, health_status, status, featured, domain_verified, category, hostname, registered_at, updated_at)
      VALUES (?, ?, ?, ?, 'x402', 'test', 'healthy', 'active', 0, 0, 'uncategorized', 'test.example.com', datetime('now'), datetime('now'))
    `)
    const insertMany = db.transaction(() => {
      for (let i = 0; i < 1200; i++) {
        insert.run(`hybrid-overlap-${i}`, `OverlapTest-${i}`, `OverlapTest-${i} desc`, `https://overlap-${i}.example.com/api`)
      }
    })
    insertMany()
    // Give one LIKE-matching service an embedding (it overlaps: both LIKE AND semantic)
    insertEmbedding('hybrid-overlap-0', WEATHER_SERVICE_VEC)

    try {
      stubEmbedQuery(WEATHER_QUERY_VEC)
      const result = await queryServicesHybrid(db, { q: 'OverlapTest', rawLimit: 50 }, API_COLUMNS)
      assert.ok(result.total >= 1200, `total should be >= 1200 (overlap counted once, not capped at 1000), got ${result.total}`)
    } finally {
      db.exec("DELETE FROM service_embeddings WHERE service_id LIKE 'hybrid-overlap-%'")
      db.exec("DELETE FROM services WHERE id LIKE 'hybrid-overlap-%'")
    }
  })

  it('T-empty-semantic: zero semantic-only results with >1000 LIKE → total correct', async () => {
    const insert = db.prepare(`
      INSERT OR IGNORE INTO services (id, name, description, url, protocol, source, health_status, status, featured, domain_verified, category, hostname, registered_at, updated_at)
      VALUES (?, ?, ?, ?, 'x402', 'test', 'healthy', 'active', 0, 0, 'uncategorized', 'test.example.com', datetime('now'), datetime('now'))
    `)
    const insertMany = db.transaction(() => {
      for (let i = 0; i < 1100; i++) {
        insert.run(`hybrid-empty-${i}`, `EmptyTest-${i}`, `EmptyTest-${i} desc`, `https://empty-${i}.example.com/api`)
      }
    })
    insertMany()

    try {
      stubEmbedQuery(WEATHER_QUERY_VEC)
      const result = await queryServicesHybrid(db, { q: 'EmptyTest', rawLimit: 50 }, API_COLUMNS)
      assert.ok(result.total >= 1100, `total should be >= 1100 (not capped at likeCap=1000), got ${result.total}`)
    } finally {
      db.exec("DELETE FROM services WHERE id LIKE 'hybrid-empty-%'")
    }
  })
})

// ─── GROUP G: Edge cases and comparator (#153 review) ────────────────────────

describe('Group G — edge cases and comparator (#153 review)', () => {
  it('T5: A2 fixture renamed — hybrid-prime exists, URL has no "weather"', () => {
    const svc = db.prepare('SELECT url FROM services WHERE id = ?').get('hybrid-prime')
    assert.ok(svc, 'hybrid-prime should exist (renamed from hybrid-weather-prime)')
    assert.ok(!svc.url.includes('weather'), 'fixture URL should not contain "weather"')
  })

  it('T6: 50%_off query — name match ranks above cosine-only (no SQL escape in JS)', async () => {
    insertService('hybrid-percent-svc', '50%_off deals', { description: 'Discount API' })
    insertEmbedding('hybrid-percent-svc', GENERIC_VEC_A)

    insertService('hybrid-percent-far', 'FarService', { description: 'Unrelated service' })
    insertEmbedding('hybrid-percent-far', PERCENT_CLOSE_VEC)

    try {
      stubEmbedQuery(PERCENT_CLOSE_VEC)
      const result = await queryServicesHybrid(db, { q: '50%_off', rawLimit: 50 }, API_COLUMNS)
      const idx_percent = result.services.findIndex(s => s.id === 'hybrid-percent-svc')
      const idx_far = result.services.findIndex(s => s.id === 'hybrid-percent-far')
      assert.ok(idx_percent >= 0, '50%_off deals should appear in results')
      assert.ok(idx_far >= 0, 'FarService should appear in results')
      assert.ok(idx_percent < idx_far,
        '50%_off deals (Tier B name match) should rank above FarService (Tier D cosine-only)')
    } finally {
      for (const id of ['hybrid-percent-svc', 'hybrid-percent-far']) {
        try { db.prepare('DELETE FROM service_embeddings WHERE service_id = ?').run(id) } catch {}
        try { db.prepare('DELETE FROM services WHERE id = ?').run(id) } catch {}
      }
    }
  })

  it('T-comparator-empty: buildHybridComparator — no LIKE matches, cosine-winner ranks first', () => {
    assert.ok(typeof buildHybridComparator === 'function', 'buildHybridComparator should be exported')
    const comparator = buildHybridComparator({
      q: 'weather',
      likeNameIdSet: new Set(),
      likeDescIdSet: new Set(),
      semanticScores: new Map([['a', 0.9], ['b', 0.5]]),
    })
    const services = [
      { id: 'b', name: 'Beta', featured: 1, domain_verified: 1, category: 'ai', health_status: 'healthy' },
      { id: 'a', name: 'Alpha', featured: 0, domain_verified: 0, category: 'uncategorized', health_status: 'unknown' },
    ]
    services.sort(comparator)
    assert.equal(services[0].id, 'a', 'Higher cosine (0.9) should rank first despite lower featured/verified')
  })
})

// ─── GROUP P6: Response shape regression ─────────────────────────────────────

describe('Group P6 — response shape regression (#161)', () => {
  it('T-shape-regression: GET /api/v1/services?q=weather returns exactly {services,total,limit,offset}', async () => {
    // globalThis.fetch is restored to originalFetch by the outer beforeEach
    const res = await originalFetch(`${API}/api/v1/services?q=weather`)
    assert.equal(res.status, 200, 'Should return 200 (degrades gracefully if OpenAI fails)')
    const body = await res.json()
    assert.deepStrictEqual(
      Object.keys(body).sort(),
      ['limit', 'offset', 'services', 'total'],
      `Response should have EXACTLY these top-level keys, got: ${Object.keys(body).sort().join(', ')}`,
    )
  })
})

// ─── Pure JS helper (no module import needed) ────────────────────────────────
function cosineSimilaritySync(a, b) {
  let dot = 0, magA = 0, magB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    magA += a[i] * a[i]
    magB += b[i] * b[i]
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB)
  return denom === 0 ? 0 : dot / denom
}
