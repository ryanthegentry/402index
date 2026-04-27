import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { styles } from '../src/views/styles.js'
import { layout } from '../src/views/layout.js'
import { demoPage } from '../src/views/demo.js'

const sampleStats = {
  totalIndexed: 100, verified: 10, distinctProviders: 5,
  healthy: 80, degraded: 10, down: 5, unknown: 5,
  lastHealthCheck: '2026-03-14',
  l402: { endpoints: 50, verified: 10, healthy: 10, providers: 5, allProviders: 10 },
  x402: { endpoints: 50, verified: 5, healthy: 70, providers: 10, allProviders: 20 },
  mpp: { endpoints: 10, verified: 3, healthy: 3, providers: 2, allProviders: 5 },
}

const sampleProbe = {
  service: { name: 'Test', url: 'https://test.com', protocol: 'L402', price_sats: 10, category: 'test', provider: 'T' },
  healthCheck: { checked_at: '2026-03-14', status: 'healthy', response_time_ms: 100, http_status: 402 },
  flow: {
    request: 'GET https://test.com',
    responseStatus: 402,
    protocolHeaders: { L402: 'WWW-Authenticate: L402 macaroon="abc", invoice="lnbc..."' },
    retryHeader: 'Authorization: L402 tok:pre',
    successStatus: 200,
  },
}

// ─── Mobile responsive CSS ───────────────────────────────────────────────────

describe('demo responsive — mobile CSS (max-width: 768px)', () => {
  it('scales down header typography', () => {
    assert.ok(styles.includes('.demo-header h1'), 'should have mobile h1 rule')
    // The mobile media query should override the default 28px
    assert.ok(styles.includes('20px'), 'should have 20px font size somewhere for mobile')
  })

  it('scales down stat numbers', () => {
    assert.ok(styles.includes('.demo-stat-number'), 'should have stat number rule')
  })

  it('adjusts flow step layout for mobile', () => {
    assert.ok(styles.includes('.demo-flow-step-number'), 'should have flow step number responsive rules')
    assert.ok(styles.includes('.demo-flow-step-content'), 'should have flow step content responsive rules')
  })

  it('adds flex-wrap to result meta for overflow', () => {
    assert.ok(styles.includes('.demo-result-meta'), 'should have result meta rule')
    assert.ok(styles.includes('flex-wrap'), 'should include flex-wrap for wrapping')
  })

  it('adds flex-wrap to flow toggle buttons', () => {
    assert.ok(styles.includes('.demo-flow-toggle'), 'should have flow toggle rule')
  })

  it('makes healthcheck button full width on mobile', () => {
    // Check the responsive section includes healthcheck button
    assert.ok(styles.includes('.demo-healthcheck-btn'), 'should have healthcheck button rule')
  })

  it('adjusts filter group selects for touch targets', () => {
    assert.ok(styles.includes('.demo-filter-group'), 'should have filter group responsive rules')
  })
})

// ─── Filter chips wrapping ──────────────────────────────────────────────────

describe('demo responsive — filter chips wrapping', () => {
  it('uses flex-wrap: wrap on the base .demo-filter-chips rule (allows filter row wrapping at narrow desktop widths)', () => {
    const startIdx = styles.indexOf('.demo-filter-chips {')
    assert.ok(startIdx !== -1, 'should have .demo-filter-chips rule')
    const endIdx = styles.indexOf('}', startIdx)
    const ruleBody = styles.slice(startIdx, endIdx)
    assert.ok(ruleBody.includes('flex-wrap: wrap'), 'base rule should declare flex-wrap: wrap')
    assert.ok(!ruleBody.includes('flex-wrap: nowrap'), 'base rule must not declare flex-wrap: nowrap')
  })
})

// ─── Desktop CSS ─────────────────────────────────────────────────────────────

describe('demo responsive — desktop CSS (min-width: 1200px)', () => {
  it('has a desktop media query for large screens', () => {
    assert.ok(styles.includes('min-width: 1200px') || styles.includes('min-width:1200px'), 'should have desktop breakpoint')
  })

  it('constrains flow steps max-width on wide screens', () => {
    assert.ok(styles.includes('max-width') && styles.includes('.demo-flow'), 'should constrain flow width on desktop')
  })

  it('increases panel padding on desktop', () => {
    // Desktop should have larger padding than default
    assert.ok(styles.includes('32px'), 'should have 32px padding for desktop panels')
  })
})

// ─── Layout meta tags ────────────────────────────────────────────────────────

describe('demo responsive — meta tags', () => {
  it('layout includes viewport meta tag', () => {
    const html = layout('Test', '')
    assert.ok(html.includes('viewport'), 'should have viewport meta')
    assert.ok(html.includes('width=device-width'), 'should set width=device-width')
  })

  it('layout includes theme-color meta tag', () => {
    const html = layout('Test', '')
    assert.ok(html.includes('theme-color'), 'should have theme-color meta')
    assert.ok(html.includes('#0f1117'), 'should set theme-color to bg color')
  })
})

// ─── Demo page markup is responsive-friendly ─────────────────────────────────

describe('demo responsive — markup', () => {
  it('demo page has no fixed-width inline styles on content elements', () => {
    const html = demoPage({ stats: sampleStats, probeSample: sampleProbe })
    // Flow step content and search results should not have fixed pixel widths
    // The only inline style widths should be on health bar fills (percentage-based)
    const fixedWidthPattern = /style="[^"]*width:\s*\d+px/g
    const matches = html.match(fixedWidthPattern) || []
    // Should have zero fixed-pixel-width inline styles
    assert.equal(matches.length, 0, 'should have no fixed-pixel-width inline styles (only percentage widths)')
  })

  it('health bar fills use percentage widths', () => {
    const html = demoPage({ stats: sampleStats, probeSample: sampleProbe })
    assert.ok(html.includes('width:') && html.includes('%'), 'health bars should use percentage widths')
  })

  it('search input has no hardcoded width in markup', () => {
    const html = demoPage({ stats: sampleStats, probeSample: sampleProbe })
    // The search input should rely on CSS width:100%, not inline style
    assert.ok(!html.includes('demo-search-input" style='), 'search input should not have inline style')
  })
})
