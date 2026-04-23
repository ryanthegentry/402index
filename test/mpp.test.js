import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import db from '../src/db.js'

// Mock fetch globally for poll tests
const originalFetch = globalThis.fetch

const MPP_FIXTURE = {
  version: 1,
  services: [
    {
      id: 'openai',
      name: 'OpenAI',
      url: 'https://openai.mpp.tempo.xyz',
      serviceUrl: 'https://openai.mpp.tempo.xyz',
      description: 'AI inference provider',
      categories: ['ai'],
      integration: 'first-party',
      status: 'active',
      methods: { tempo: { intents: ['charge'], assets: ['0x20c000000000000000000000b9537d11c60e8b50'] } },
      provider: { name: 'OpenAI', url: 'https://openai.com' },
      endpoints: [
        {
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
        },
        {
          method: 'GET',
          path: '/v1/models',
          description: 'List models',
          payment: null, // free endpoint — should be skipped
        },
      ],
    },
    {
      id: 'firecrawl',
      name: 'Firecrawl',
      url: 'https://firecrawl.mpp.tempo.xyz',
      description: 'Web scraping service',
      categories: ['web'],
      integration: 'third-party',
      status: 'active',
      methods: { tempo: { intents: ['charge'] } },
      provider: { name: 'Firecrawl', url: 'https://firecrawl.dev' },
      endpoints: [
        {
          method: 'POST',
          path: '/v1/scrape',
          description: 'Scrape a URL',
          payment: {
            intent: 'charge',
            method: 'tempo',
            currency: '0x20c000000000000000000000b9537d11c60e8b50',
            decimals: 6,
            amount: '50000',
          },
        },
        {
          method: 'POST',
          path: '/v1/crawl',
          description: 'Crawl a site',
          payment: {
            intent: 'session',
            method: 'tempo',
            currency: '0x20c000000000000000000000b9537d11c60e8b50',
            decimals: 6,
            amount: '100000',
            dynamic: true,
          },
        },
      ],
    },
    {
      id: 'stripe-climate',
      name: 'Stripe Climate',
      url: 'https://stripe-climate.mpp.tempo.xyz',
      description: 'Carbon removal credits',
      categories: ['blockchain'],
      integration: 'first-party',
      status: 'active',
      methods: { stripe: { intents: ['charge'] } },
      provider: { name: 'Stripe', url: 'https://stripe.com' },
      endpoints: [
        {
          method: 'POST',
          path: '/v1/purchase',
          description: 'Purchase carbon credits',
          payment: {
            intent: 'charge',
            method: 'stripe',
            currency: '0x20c000000000000000000000b9537d11c60e8b50',
            decimals: 6,
            amount: '1000000',
          },
        },
      ],
    },
    {
      id: 'free-only',
      name: 'Free Service',
      url: 'https://free.mpp.tempo.xyz',
      description: 'All free endpoints',
      categories: ['data'],
      status: 'active',
      provider: { name: 'Free Co' },
      endpoints: [
        { method: 'GET', path: '/health', payment: null },
        { method: 'GET', path: '/status', payment: null },
      ],
    },
  ],
}

function cleanupMppServices() {
  db.prepare("DELETE FROM health_checks WHERE service_id IN (SELECT id FROM services WHERE source LIKE '%mpp%')").run()
  db.prepare("DELETE FROM services WHERE source LIKE '%mpp%'").run()
}

function seedRow({ url, protocol = 'MPP', source = 'mpp', provider_deleted = 0, deleted_at = null, name = 'Test', source_id = null }) {
  const id = crypto.randomUUID()
  db.prepare(`
    INSERT INTO services (id, name, url, protocol, source, source_id, provider_deleted, deleted_at, hostname)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, url, protocol, source, source_id || `seed:${url}`, provider_deleted, deleted_at, 'test.example.com')
  return id
}

describe('pollMPP', () => {
  beforeEach(() => {
    cleanupMppServices()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    cleanupMppServices()
  })

  it('inserts paid endpoints and skips free ones', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => MPP_FIXTURE,
    })

    const { pollMPP } = await import('../src/aggregators/mpp.js')
    const result = await pollMPP()

    // 1 from openai (1 paid, 1 free skipped)
    // 2 from firecrawl (both paid)
    // 1 from stripe-climate
    // 0 from free-only (all free)
    assert.equal(result.new, 4)
    assert.equal(result.errors, 0)

    const mppServices = db.prepare("SELECT * FROM services WHERE source = 'mpp'").all()
    assert.equal(mppServices.length, 4)
  })

  it('produces updates not duplicates on re-poll', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => MPP_FIXTURE,
    })

    const { pollMPP } = await import('../src/aggregators/mpp.js')
    const first = await pollMPP()
    assert.equal(first.new, 4)

    const second = await pollMPP()
    assert.equal(second.updated, 4)
    assert.equal(second.new, 0)

    // Still only 4 rows, not 8
    const count = db.prepare("SELECT COUNT(*) as c FROM services WHERE source = 'mpp'").get().c
    assert.equal(count, 4)
  })

  it('sets correct protocol and source', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => MPP_FIXTURE,
    })

    const { pollMPP } = await import('../src/aggregators/mpp.js')
    await pollMPP()

    const services = db.prepare("SELECT protocol, source FROM services WHERE source = 'mpp'").all()
    for (const svc of services) {
      assert.equal(svc.protocol, 'MPP')
      assert.equal(svc.source, 'mpp')
    }
  })

  it('maps payment_network correctly for tempo vs stripe', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => MPP_FIXTURE,
    })

    const { pollMPP } = await import('../src/aggregators/mpp.js')
    await pollMPP()

    const stripeService = db.prepare("SELECT payment_network FROM services WHERE source = 'mpp' AND source_id = 'stripe-climate:/v1/purchase'").get()
    assert.equal(stripeService.payment_network, 'Stripe')

    const tempoService = db.prepare("SELECT payment_network FROM services WHERE source = 'mpp' AND source_id = 'openai:/v1/responses'").get()
    assert.equal(tempoService.payment_network, 'Tempo')
  })

  it('sets null price_usd for dynamic pricing', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => MPP_FIXTURE,
    })

    const { pollMPP } = await import('../src/aggregators/mpp.js')
    await pollMPP()

    const dynamic = db.prepare("SELECT price_usd FROM services WHERE source = 'mpp' AND source_id = 'firecrawl:/v1/crawl'").get()
    assert.equal(dynamic.price_usd, null)
  })

  it('handles API returning non-200', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 503,
    })

    const { pollMPP } = await import('../src/aggregators/mpp.js')
    const result = await pollMPP()
    assert.equal(result.new, 0)
    assert.equal(result.updated, 0)
    assert.equal(result.errors, 0)
  })

  it('handles fetch error (API down)', async () => {
    globalThis.fetch = async () => {
      throw new Error('ECONNREFUSED')
    }

    const { pollMPP } = await import('../src/aggregators/mpp.js')
    const result = await pollMPP()
    assert.equal(result.new, 0)
    assert.equal(result.updated, 0)
    assert.equal(result.errors, 0)
  })

  it('handles malformed JSON response', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => { throw new SyntaxError('Unexpected token') },
    })

    const { pollMPP } = await import('../src/aggregators/mpp.js')
    const result = await pollMPP()
    assert.equal(result.new, 0)
    assert.equal(result.errors, 0)
  })

  it('handles service with missing fields gracefully', async () => {
    const badFixture = {
      version: 1,
      services: [
        {
          id: 'broken',
          name: 'Broken Service',
          // missing url
          categories: ['ai'],
          endpoints: [
            {
              method: 'GET',
              path: '/v1/data',
              payment: {
                amount: '10000',
                decimals: 6,
                method: 'tempo',
                currency: '0x20c000000000000000000000b9537d11c60e8b50',
              },
            },
          ],
        },
      ],
    }

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => badFixture,
    })

    const { pollMPP } = await import('../src/aggregators/mpp.js')
    const result = await pollMPP()
    assert.equal(result.errors, 1)
    assert.equal(result.new, 0)
  })

  it('sets correct http_method and probe_body', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => MPP_FIXTURE,
    })

    const { pollMPP } = await import('../src/aggregators/mpp.js')
    await pollMPP()

    const postEndpoint = db.prepare("SELECT http_method, probe_body FROM services WHERE source = 'mpp' AND source_id = 'openai:/v1/responses'").get()
    assert.equal(postEndpoint.http_method, 'POST')
    assert.equal(postEndpoint.probe_body, '{}')

    // firecrawl scrape is also POST
    const scrapeEndpoint = db.prepare("SELECT http_method, probe_body FROM services WHERE source = 'mpp' AND source_id = 'firecrawl:/v1/scrape'").get()
    assert.equal(scrapeEndpoint.http_method, 'POST')
    assert.equal(scrapeEndpoint.probe_body, '{}')
  })

  it('maps categories correctly', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => MPP_FIXTURE,
    })

    const { pollMPP } = await import('../src/aggregators/mpp.js')
    await pollMPP()

    const openai = db.prepare("SELECT category FROM services WHERE source = 'mpp' AND source_id = 'openai:/v1/responses'").get()
    assert.equal(openai.category, 'ai/llm')

    const firecrawl = db.prepare("SELECT category FROM services WHERE source = 'mpp' AND source_id = 'firecrawl:/v1/scrape'").get()
    assert.equal(firecrawl.category, 'web-scraping')

    const stripe = db.prepare("SELECT category FROM services WHERE source = 'mpp' AND source_id = 'stripe-climate:/v1/purchase'").get()
    assert.equal(stripe.category, 'blockchain')
  })
})

describe('MPP health check classification', () => {
  it('classifies MPP 402 with Payment challenge as healthy', async () => {
    const { classifyHealthStatus } = await import('../src/health/checker.js')
    const result = classifyHealthStatus(402, null, 0, null, 200)
    assert.equal(result.healthStatus, 'healthy')
  })

  it('classifies MPP 200 as degraded', async () => {
    const { classifyHealthStatus } = await import('../src/health/checker.js')
    const result = classifyHealthStatus(200, null, 0, null, 200)
    assert.equal(result.healthStatus, 'degraded')
  })

  it('classifies MPP 500 as down after 3 failures', async () => {
    const { classifyHealthStatus } = await import('../src/health/checker.js')
    const result = classifyHealthStatus(500, null, 2, null, 200)
    assert.equal(result.healthStatus, 'down')
  })
})

describe('MPP POST auto-detection (unit)', () => {
  it('classifies 405 as method_not_allowed (triggers POST retry)', async () => {
    const { classifyHealthStatus } = await import('../src/health/checker.js')
    const result = classifyHealthStatus(405, null, 0, null, 200)
    assert.equal(result.checkStatus, 'method_not_allowed')
    assert.notEqual(result.healthStatus, 'healthy')
  })

  it('classifies 400 as unhealthy (triggers POST retry for MPP)', async () => {
    const { classifyHealthStatus } = await import('../src/health/checker.js')
    const result = classifyHealthStatus(400, null, 0, null, 200)
    assert.notEqual(result.healthStatus, 'healthy')
  })
})

describe('pollMPP sweep + reactivation', () => {
  beforeEach(() => {
    cleanupMppServices()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    cleanupMppServices()
  })

  it('reactivates a soft-deleted row when it reappears in the API', async () => {
    // Seed a soft-deleted row whose URL matches the fixture
    const url = 'https://openai.mpp.tempo.xyz/v1/responses'
    seedRow({ url, provider_deleted: 1, deleted_at: '2026-04-01 00:00:00' })

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => MPP_FIXTURE,
    })

    const { pollMPP } = await import('../src/aggregators/mpp.js')
    const result = await pollMPP()

    const row = db.prepare("SELECT provider_deleted, deleted_at FROM services WHERE url = ? AND protocol = 'MPP'").get(url)
    assert.equal(row.provider_deleted, 0, 'row should be reactivated')
    // The reappearing row should count as new (not updated), since findExisting excludes soft-deleted
    assert.ok(result.new >= 1, 'reactivated row should count as new')
  })

  it('sweeps stale rows not present in API response', async () => {
    // Seed a row that won't appear in the fixture
    seedRow({ url: 'https://stale.example.com/v1/old', source: 'mpp' })

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => MPP_FIXTURE,
    })

    const { pollMPP } = await import('../src/aggregators/mpp.js')
    const result = await pollMPP()

    assert.equal(typeof result.swept, 'number', 'result must include swept count')
    assert.ok(result.swept >= 1, 'stale row should be swept')

    const stale = db.prepare("SELECT provider_deleted, deleted_at FROM services WHERE url = 'https://stale.example.com/v1/old' AND protocol = 'MPP'").get()
    assert.equal(stale.provider_deleted, 1, 'stale row should be soft-deleted')
    assert.ok(stale.deleted_at, 'deleted_at must be set for purgeSoftDeleted()')
  })

  it('sweep is idempotent — second run sweeps 0', async () => {
    seedRow({ url: 'https://orphan.example.com/v1/dead', source: 'mpp' })

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => MPP_FIXTURE,
    })

    const { pollMPP } = await import('../src/aggregators/mpp.js')
    const first = await pollMPP()
    assert.ok(first.swept >= 1, 'first run should sweep orphans')

    const second = await pollMPP()
    assert.equal(second.swept, 0, 'second run should sweep 0')
  })

  it('does NOT sweep when API returns empty services array', async () => {
    seedRow({ url: 'https://keeper.example.com/v1/stay', source: 'mpp' })

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ services: [] }),
    })

    const { pollMPP } = await import('../src/aggregators/mpp.js')
    const result = await pollMPP()

    assert.equal(result.swept, 0, 'sweep must be skipped on empty response')

    const row = db.prepare("SELECT provider_deleted FROM services WHERE url = 'https://keeper.example.com/v1/stay' AND protocol = 'MPP'").get()
    assert.equal(row.provider_deleted, 0, 'existing row must not be soft-deleted')
  })

  it('sweep scope is exact source=mpp — does NOT touch mppscan or multi-source rows', async () => {
    seedRow({ url: 'https://multi.example.com/v1/a', source: 'mpp,bazaar' })
    seedRow({ url: 'https://multi.example.com/v1/b', source: 'bazaar,mpp' })
    seedRow({ url: 'https://scan.example.com/v1/c', source: 'mppscan' })
    seedRow({ url: 'https://only-mpp.example.com/v1/d', source: 'mpp' })

    // Fixture has none of these URLs
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => MPP_FIXTURE,
    })

    const { pollMPP } = await import('../src/aggregators/mpp.js')
    await pollMPP()

    // Multi-source and mppscan rows must NOT be swept
    const multi1 = db.prepare("SELECT provider_deleted FROM services WHERE url = 'https://multi.example.com/v1/a'").get()
    assert.equal(multi1.provider_deleted, 0, 'mpp,bazaar row must not be swept')

    const multi2 = db.prepare("SELECT provider_deleted FROM services WHERE url = 'https://multi.example.com/v1/b'").get()
    assert.equal(multi2.provider_deleted, 0, 'bazaar,mpp row must not be swept')

    const scan = db.prepare("SELECT provider_deleted FROM services WHERE url = 'https://scan.example.com/v1/c'").get()
    assert.equal(scan.provider_deleted, 0, 'mppscan row must not be swept')

    // Pure mpp row should be swept
    const pure = db.prepare("SELECT provider_deleted FROM services WHERE url = 'https://only-mpp.example.com/v1/d'").get()
    assert.equal(pure.provider_deleted, 1, 'source=mpp row should be swept')
  })

  it('deleted_at is set on swept rows for purgeSoftDeleted()', async () => {
    seedRow({ url: 'https://purgable.example.com/v1/x', source: 'mpp' })

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => MPP_FIXTURE,
    })

    const { pollMPP } = await import('../src/aggregators/mpp.js')
    await pollMPP()

    const row = db.prepare("SELECT deleted_at FROM services WHERE url = 'https://purgable.example.com/v1/x'").get()
    assert.ok(row.deleted_at, 'deleted_at must be set so purgeSoftDeleted() can fire')
  })

  it('skips sweep when most normalizations fail (amplification guard)', async () => {
    // Seed 20 rows that would be swept if guard fails
    for (let i = 0; i < 20; i++) {
      seedRow({ url: `https://real-service-${i}.example.com/v1/api`, source: 'mpp' })
    }

    // 100 services but all with broken URLs that normalize to null
    const brokenFixture = { version: 1, services: [] }
    for (let i = 0; i < 100; i++) {
      brokenFixture.services.push({
        id: `broken-${i}`,
        name: `Broken ${i}`,
        // missing url and serviceUrl — normalizeMppEndpoint returns null
        categories: ['ai'],
        provider: { name: `Provider ${i}` },
        endpoints: [{
          method: 'GET',
          path: '/v1/data',
          description: 'Data endpoint',
          payment: { amount: '1000', decimals: 6, method: 'tempo', currency: '0x20c000000000000000000000b9537d11c60e8b50' },
        }],
      })
    }

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => brokenFixture,
    })

    const { pollMPP } = await import('../src/aggregators/mpp.js')
    const result = await pollMPP()

    assert.equal(result.swept, 0, 'sweep must be skipped when most normalizations fail')

    // Verify existing rows were NOT swept
    const alive = db.prepare("SELECT COUNT(*) as c FROM services WHERE source = 'mpp' AND provider_deleted = 0").get()
    assert.ok(alive.c >= 20, 'existing rows must survive normalization-failure scenario')
  })

  it('handles 1500+ URLs without SQLITE_LIMIT_VARIABLE_NUMBER error', async () => {
    // Generate a fixture with 1500+ endpoints
    const bigFixture = { version: 1, services: [] }
    for (let i = 0; i < 1500; i++) {
      bigFixture.services.push({
        id: `svc-${i}`,
        name: `Service ${i}`,
        url: `https://big${i}.mpp.tempo.xyz`,
        serviceUrl: `https://big${i}.mpp.tempo.xyz`,
        categories: ['ai'],
        provider: { name: `Provider ${i}` },
        endpoints: [{
          method: 'GET',
          path: '/v1/data',
          description: 'Data endpoint',
          payment: { amount: '1000', decimals: 6, method: 'tempo', currency: '0x20c000000000000000000000b9537d11c60e8b50' },
        }],
      })
    }

    // Seed one orphan that should be swept
    seedRow({ url: 'https://big-orphan.example.com/v1/z', source: 'mpp' })

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => bigFixture,
    })

    const { pollMPP } = await import('../src/aggregators/mpp.js')
    // Must not throw SQLITE_ERROR: too many SQL variables
    const result = await pollMPP()
    assert.equal(typeof result.swept, 'number', 'sweep must complete without variable-limit error')
    assert.ok(result.swept >= 1, 'orphan should be swept')
  })
})

describe('pollMPP source-merge fix', () => {
  beforeEach(() => {
    cleanupMppServices()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    cleanupMppServices()
  })

  it('appends ,mpp to mppscan-only rows (source-merge exact match)', async () => {
    // Seed a row with source='mppscan' that has the same URL as a fixture endpoint
    const url = 'https://openai.mpp.tempo.xyz/v1/responses'
    seedRow({ url, source: 'mppscan', source_id: 'openai:/v1/responses' })

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => MPP_FIXTURE,
    })

    const { pollMPP } = await import('../src/aggregators/mpp.js')
    await pollMPP()

    const row = db.prepare("SELECT source FROM services WHERE url = ? AND protocol = 'MPP'").get(url)
    assert.ok(row.source.includes('mppscan'), 'must retain mppscan')
    assert.ok(row.source.includes('mpp'), 'must include mpp')
    // The old LIKE '%mpp%' bug would match 'mppscan' and skip appending ',mpp'
    assert.match(row.source, /mppscan,mpp|mpp,mppscan/, 'source must contain both tokens')
  })
})

describe('detectProtocol used by health checker', () => {
  it('detects valid MPP challenge via detectProtocol', async () => {
    const { detectProtocol } = await import('../src/services/detect-protocol.js')
    const result = detectProtocol({
      wwwAuthenticate: 'Payment id="x", realm="r", method="tempo", intent="charge", request="eyJ0ZXN0IjoxfQ"',
    })
    assert.equal(result[0].protocol, 'MPP')
    assert.equal(result[0].valid, true)
  })

  it('detects invalid MPP challenge (missing field) via detectProtocol', async () => {
    const { detectProtocol } = await import('../src/services/detect-protocol.js')
    const result = detectProtocol({
      wwwAuthenticate: 'Payment id="x", realm="r", method="tempo"',
    })
    assert.equal(result[0].protocol, 'MPP')
    assert.equal(result[0].valid, false)
    assert.ok(result[0].degradeReason.includes('missing'))
  })
})
