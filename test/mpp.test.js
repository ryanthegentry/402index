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
  db.prepare("DELETE FROM health_checks WHERE service_id IN (SELECT id FROM services WHERE source = 'mpp')").run()
  db.prepare("DELETE FROM services WHERE source = 'mpp'").run()
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

describe('detectProtocol used by health checker', () => {
  it('detects valid MPP challenge via detectProtocol', async () => {
    const { detectProtocol } = await import('../src/services/detect-protocol.js')
    const result = detectProtocol({
      wwwAuthenticate: 'Payment id="x", realm="r", method="tempo", intent="charge", request="eyJ0ZXN0IjoxfQ"',
    })
    assert.equal(result.protocol, 'MPP')
    assert.equal(result.valid, true)
  })

  it('detects invalid MPP challenge (missing field) via detectProtocol', async () => {
    const { detectProtocol } = await import('../src/services/detect-protocol.js')
    const result = detectProtocol({
      wwwAuthenticate: 'Payment id="x", realm="r", method="tempo"',
    })
    assert.equal(result.protocol, 'MPP')
    assert.equal(result.valid, false)
    assert.ok(result.degradeReason.includes('missing'))
  })
})
