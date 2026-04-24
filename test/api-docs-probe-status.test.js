import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { apiDocsPage } from '../src/views/api-docs.js'
import { demoPage } from '../src/views/demo.js'

describe('api-docs probe_status documentation', () => {
  const html = apiDocsPage()

  it('params table includes probe_status filter', () => {
    assert.ok(html.includes('probe_status'), 'params table should include probe_status filter')
  })

  it('documents admin probe-status endpoint', () => {
    assert.ok(html.includes('/admin/services/:id/probe-status'), 'should document admin probe-status endpoint')
  })

  it('CSV column list includes probe_status', () => {
    // probe_status should appear in the CSV columns line, between health_status and uptime_30d
    assert.ok(html.includes('health_status, probe_status, uptime_30d'), 'CSV columns should include probe_status between health_status and uptime_30d')
  })

  it('response sample JSON includes probe_status', () => {
    assert.ok(html.includes('"probe_status"'), 'response sample should include probe_status field')
  })
})

describe('demo.js healthDotHtml probe_status handling', () => {
  // Build minimal data to render the demo page
  const stats = {
    totalIndexed: 0, verified: 0, distinctProviders: 0, verifiedProviders: 0,
    healthy: 0, degraded: 0, down: 0, unknown: 0, lastHealthCheck: null,
    l402: { verified: 0, endpoints: 0, providers: 0, allProviders: 0, healthy: 0 },
    x402: { verified: 0, endpoints: 0, providers: 0, allProviders: 0, healthy: 0 },
    mpp: { verified: 0, endpoints: 0, providers: 0, allProviders: 0, healthy: 0, gatewayVerified: 0, gatewayEndpoints: 0 },
  }
  const probeSample = {
    service: { price_sats: 5 },
    flow: {
      request: 'GET /api HTTP/1.1',
      protocolHeaders: { L402: 'WWW-Authenticate: L402 ...' },
      retryHeader: 'Authorization: L402 ...',
    },
  }
  const html = demoPage({ stats, probeSample, featuredServices: [], meta: {} })

  it('healthDotHtml checks probe_status for unprobeable', () => {
    assert.ok(html.includes("probe_status === 'unprobeable'"), 'demo healthDotHtml should check probe_status')
  })

  it('healthDotHtml passes full svc object, not just health_status', () => {
    assert.ok(!html.includes('healthDotHtml(svc.health_status)'), 'should pass full svc object, not just health_status')
  })
})
