import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { demoPage } from '../src/views/demo.js'

// ─── Sample data for rendering tests ──────────────────────────────────────────

const sampleStats = {
  totalIndexed: 14250,
  verified: 858,
  distinctProviders: 169,
  healthy: 11899,
  degraded: 1938,
  down: 411,
  unknown: 2,
  lastHealthCheck: '2026-03-14T12:00:00Z',
  l402: { endpoints: 91, verified: 41, healthy: 41, providers: 24 },
  x402: { endpoints: 13700, verified: 761, healthy: 11858, providers: 311 },
}

const sampleProbeSample = {
  service: {
    name: 'Weather API',
    url: 'https://api.example.com/weather',
    protocol: 'L402',
    price_sats: 10,
    category: 'data/weather',
    provider: 'WeatherCorp',
  },
  healthCheck: {
    checked_at: '2026-03-14T12:00:00Z',
    status: 'healthy',
    response_time_ms: 145,
    http_status: 402,
  },
  flow: {
    request: 'GET https://api.example.com/weather',
    responseStatus: 402,
    protocolHeaders: {
      L402: 'WWW-Authenticate: L402 macaroon="AGIAJEem...", invoice="lnbc100n1..."',
    },
    retryHeader: 'Authorization: L402 <macaroon>:<preimage>',
    successStatus: 200,
  },
}

// ─── Panel structure tests ────────────────────────────────────────────────────

describe('demoPage', () => {
  it('renders valid HTML with all three panels', () => {
    const html = demoPage({ stats: sampleStats, probeSample: sampleProbeSample })
    assert.ok(html.includes('<!DOCTYPE html>'), 'should be a full HTML page')
    assert.ok(html.includes('demo-ecosystem'), 'should have ecosystem panel')
    assert.ok(html.includes('demo-search'), 'should have search panel')
    assert.ok(html.includes('demo-flow'), 'should have flow panel')
  })

  it('includes Demo in navigation', () => {
    const html = demoPage({ stats: sampleStats, probeSample: sampleProbeSample })
    assert.ok(html.includes('href="/demo"'), 'should have Demo nav link')
  })
})

// ─── Panel 1: Ecosystem Dashboard ────────────────────────────────────────────

describe('demoPage — Panel 1: Ecosystem Dashboard', () => {
  it('shows total endpoints and verified count', () => {
    const html = demoPage({ stats: sampleStats, probeSample: sampleProbeSample })
    assert.ok(html.includes('14,250') || html.includes('14250'), 'should show total endpoints')
    assert.ok(html.includes('858'), 'should show verified count')
  })

  it('shows protocol comparison section', () => {
    const html = demoPage({ stats: sampleStats, probeSample: sampleProbeSample })
    assert.ok(html.includes('L402'), 'should show L402 protocol')
    assert.ok(html.includes('x402'), 'should show x402 protocol')
    assert.ok(html.includes('41'), 'should show L402 verified count')
    assert.ok(html.includes('761'), 'should show x402 verified count')
  })

  it('shows health breakdown with color-coded indicators', () => {
    const html = demoPage({ stats: sampleStats, probeSample: sampleProbeSample })
    assert.ok(html.includes('healthy'), 'should show healthy status')
    assert.ok(html.includes('degraded'), 'should show degraded status')
    assert.ok(html.includes('down'), 'should show down status')
  })

  it('shows last health check timestamp', () => {
    const html = demoPage({ stats: sampleStats, probeSample: sampleProbeSample })
    assert.ok(html.includes('2026-03-14'), 'should show last check date')
  })

  it('escapes HTML in stats to prevent XSS', () => {
    const xssStats = {
      ...sampleStats,
      lastHealthCheck: '<script>alert("xss")</script>',
    }
    const html = demoPage({ stats: xssStats, probeSample: sampleProbeSample })
    assert.ok(!html.includes('<script>alert("xss")</script>'), 'should escape script tags')
    assert.ok(html.includes('&lt;script&gt;'), 'should have escaped script tag')
  })
})

// ─── Panel 2: Interactive MCP Search ──────────────────────────────────────────

describe('demoPage — Panel 2: Interactive MCP Search', () => {
  it('contains search input', () => {
    const html = demoPage({ stats: sampleStats, probeSample: sampleProbeSample })
    assert.ok(html.includes('demo-search-input') || html.includes('type="text"'), 'should have search input')
  })

  it('contains protocol toggle (L402 / x402 / Both)', () => {
    const html = demoPage({ stats: sampleStats, probeSample: sampleProbeSample })
    // Check for radio buttons or toggle options
    assert.ok(html.includes('L402'), 'should have L402 option')
    assert.ok(html.includes('x402'), 'should have x402 option')
  })

  it('contains filter dropdowns for category and health', () => {
    const html = demoPage({ stats: sampleStats, probeSample: sampleProbeSample })
    assert.ok(html.includes('category') || html.includes('Category'), 'should have category filter')
    assert.ok(html.includes('health') || html.includes('Health'), 'should have health filter')
  })

  it('contains results container', () => {
    const html = demoPage({ stats: sampleStats, probeSample: sampleProbeSample })
    assert.ok(html.includes('demo-search-results'), 'should have results container')
  })

  it('contains MCP query display section', () => {
    const html = demoPage({ stats: sampleStats, probeSample: sampleProbeSample })
    assert.ok(html.includes('search_services') || html.includes('mcp') || html.includes('MCP'), 'should reference MCP')
  })

  it('contains disabled Check Endpoint Health button', () => {
    const html = demoPage({ stats: sampleStats, probeSample: sampleProbeSample })
    assert.ok(html.includes('demo-healthcheck-btn'), 'should have healthcheck button')
    assert.ok(html.includes('disabled'), 'button should be disabled')
    assert.ok(html.includes('Coming soon'), 'should show coming soon text')
  })
})

// ─── Panel 3: Payment Flow Visualization ──────────────────────────────────────

describe('demoPage — Panel 3: Payment Flow Visualization', () => {
  it('contains all five flow steps', () => {
    const html = demoPage({ stats: sampleStats, probeSample: sampleProbeSample })
    // Check for step indicators or step content
    assert.ok(html.includes('demo-flow-step'), 'should have flow step elements')
    assert.ok(html.includes('402'), 'should show 402 status code')
    assert.ok(html.includes('200'), 'should show 200 success status')
  })

  it('shows L402 protocol headers by default', () => {
    const html = demoPage({ stats: sampleStats, probeSample: sampleProbeSample })
    assert.ok(html.includes('WWW-Authenticate'), 'should show WWW-Authenticate header')
    assert.ok(html.includes('macaroon'), 'should show macaroon in header')
    assert.ok(html.includes('invoice'), 'should show invoice in header')
  })

  it('shows the request URL from probe sample', () => {
    const html = demoPage({ stats: sampleStats, probeSample: sampleProbeSample })
    assert.ok(html.includes('api.example.com/weather'), 'should show the probe sample URL')
  })

  it('contains protocol toggle for L402/x402', () => {
    const html = demoPage({ stats: sampleStats, probeSample: sampleProbeSample })
    assert.ok(html.includes('demo-flow-toggle') || html.includes('flow-toggle'), 'should have flow protocol toggle')
  })

  it('shows authorization header for retry step', () => {
    const html = demoPage({ stats: sampleStats, probeSample: sampleProbeSample })
    assert.ok(
      html.includes('Authorization: L402') || html.includes('Authorization'),
      'should show authorization header in retry step'
    )
  })
})

// ─── CSS and responsive ───────────────────────────────────────────────────────

describe('demoPage — CSS and structure', () => {
  it('includes demo-specific CSS classes', () => {
    const html = demoPage({ stats: sampleStats, probeSample: sampleProbeSample })
    assert.ok(html.includes('demo-panel'), 'should use demo-panel class')
    assert.ok(html.includes('demo-page'), 'should use demo-page class')
  })

  it('includes client-side JavaScript for search interactivity', () => {
    const html = demoPage({ stats: sampleStats, probeSample: sampleProbeSample })
    assert.ok(html.includes('<script>') || html.includes('script'), 'should include script for interactivity')
    assert.ok(html.includes('fetch') || html.includes('/api/v1/services'), 'should fetch from services API')
  })
})
