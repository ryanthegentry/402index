import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import db from '../src/db.js'
import { demoPage } from '../src/views/demo.js'

function cleanupMppServices() {
  db.prepare("DELETE FROM health_checks WHERE service_id IN (SELECT id FROM services WHERE protocol = 'MPP')").run()
  db.prepare("DELETE FROM services WHERE protocol = 'MPP'").run()
}

function seedMppService({ url, hostname, health_status = 'unknown', provider_deleted = 0 }) {
  const id = crypto.randomUUID()
  db.prepare(`
    INSERT INTO services (id, name, url, protocol, source, source_id, hostname, health_status, provider_deleted)
    VALUES (?, 'Test MPP', ?, 'MPP', 'mpp', ?, ?, ?, ?)
  `).run(id, url, `seed:${url}`, hostname, health_status, provider_deleted)
  return id
}

describe('MPP gateway classification for homepage stats', () => {
  beforeEach(() => {
    cleanupMppServices()
  })

  afterEach(() => {
    cleanupMppServices()
  })

  it('gateway queries count only tempo + paywithlocus hosts and homepage exposes gatewayEndpoints', () => {
    // Gateway rows (should be counted)
    seedMppService({ url: 'https://openai.mpp.tempo.xyz/v1/responses', hostname: 'openai.mpp.tempo.xyz' })
    seedMppService({ url: 'https://alphavantage.mpp.paywithlocus.com/v1/data', hostname: 'alphavantage.mpp.paywithlocus.com' })
    // Non-gateway (upstream-direct) row (should NOT be counted)
    seedMppService({ url: 'https://api.anthropic.com/v1/messages', hostname: 'api.anthropic.com' })

    const ACTIVE_FILTER = "WHERE (status = 'active' OR status IS NULL) AND (provider_deleted = 0 OR provider_deleted IS NULL)"

    const mppTotal = db.prepare(`SELECT COUNT(*) as c FROM services ${ACTIVE_FILTER} AND protocol = 'MPP'`).get().c
    const mppGatewayTotal = db.prepare(
      `SELECT COUNT(*) as c FROM services ${ACTIVE_FILTER} AND protocol = 'MPP' AND (hostname LIKE '%.mpp.tempo.xyz' OR hostname LIKE '%.mpp.paywithlocus.com')`
    ).get().c

    assert.equal(mppTotal, 3, 'total MPP endpoints should be 3')
    assert.equal(mppGatewayTotal, 2, 'gateway endpoints should count only tempo + paywithlocus hosts')

    // Verify the demo page renders the gateway-backed verified row
    const stats = {
      totalIndexed: 3, verified: 0, distinctProviders: 1, verifiedProviders: 0,
      lastHealthCheck: null, healthy: 0, degraded: 0, down: 0, unknown: 3,
      l402: { endpoints: 0, verified: 0, healthy: 0, providers: 0, allProviders: 0 },
      x402: { endpoints: 0, verified: 0, healthy: 0, providers: 0, allProviders: 0 },
      mpp: {
        endpoints: mppTotal,
        verified: 0,
        healthy: 0,
        providers: 1,
        allProviders: 1,
        gatewayEndpoints: mppGatewayTotal,
        gatewayVerified: 0,
      },
    }

    const probeSample = {
      service: { name: 'Test', protocol: 'MPP', url: 'https://test.com', category: 'ai' },
      flow: {
        request: 'GET /v1/test',
        protocolHeaders: { MPP: 'Payment ...' },
        paymentStep: 'Pay via MPP',
        successResponse: '200 OK',
      },
    }
    const html = demoPage({ stats, probeSample, featuredServices: [] })
    assert.ok(html.includes('Verified (gateway-backed)'),
      'demo page must render "Verified (gateway-backed)" row')
  })

  it('gateway verified counts only healthy gateway rows, excludes soft-deleted', () => {
    // Gateway healthy
    seedMppService({ url: 'https://openai.mpp.tempo.xyz/v1/responses', hostname: 'openai.mpp.tempo.xyz', health_status: 'healthy' })
    // Gateway degraded
    seedMppService({ url: 'https://firecrawl.mpp.tempo.xyz/v1/scrape', hostname: 'firecrawl.mpp.tempo.xyz', health_status: 'degraded' })
    // Non-gateway healthy (should NOT count as gateway verified)
    seedMppService({ url: 'https://api.anthropic.com/v1/messages', hostname: 'api.anthropic.com', health_status: 'healthy' })
    // Soft-deleted gateway healthy (should NOT count)
    seedMppService({ url: 'https://deleted.mpp.tempo.xyz/v1/api', hostname: 'deleted.mpp.tempo.xyz', health_status: 'healthy', provider_deleted: 1 })

    const ACTIVE_FILTER = "WHERE (status = 'active' OR status IS NULL) AND (provider_deleted = 0 OR provider_deleted IS NULL)"

    const mppGatewayHealthy = db.prepare(
      `SELECT COUNT(*) as c FROM services ${ACTIVE_FILTER} AND protocol = 'MPP' AND health_status = 'healthy' AND (hostname LIKE '%.mpp.tempo.xyz' OR hostname LIKE '%.mpp.paywithlocus.com')`
    ).get().c

    assert.equal(mppGatewayHealthy, 1, 'gateway verified should count only healthy, non-deleted gateway rows')
  })
})
