import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { layout } from '../src/views/layout.js'
import { aboutPage } from '../src/views/about.js'
import { apiDocsPage } from '../src/views/api-docs.js'
import { homePage } from '../src/views/home.js'
import { detailPage } from '../src/views/detail.js'
import { adminPage } from '../src/views/admin.js'
import { opportunitiesPage } from '../src/views/opportunities.js'

describe('layout', () => {
  it('renders valid HTML with title and content', () => {
    const html = layout('Test', '<p>Hello</p>')
    assert.ok(html.includes('<!DOCTYPE html>'))
    assert.ok(html.includes('<title>Test — 402 Index</title>'))
    assert.ok(html.includes('<p>Hello</p>'))
  })

  it('includes navigation links', () => {
    const html = layout('Test', '')
    assert.ok(html.includes('href="/"'))
    assert.ok(html.includes('href="/directory"'))
    assert.ok(html.includes('href="/about"'))
    assert.ok(html.includes('href="/api-docs"'))
  })

  it('does not include opportunities in nav', () => {
    const html = layout('Test', '')
    assert.ok(!html.includes('href="/opportunities"'), 'nav should not link to opportunities')
  })

  it('includes footer', () => {
    const html = layout('Test', '')
    assert.ok(html.includes('402 Index'))
    assert.ok(html.includes('</footer>'))
  })

  it('includes data sources in footer with links', () => {
    const html = layout('Test', '')
    assert.ok(html.includes('footer-sources'), 'footer should have data sources section')
    assert.ok(html.includes('href="https://satring.com"'), 'footer should link to Satring')
    assert.ok(html.includes('href="https://x402.org/bazaar"'), 'footer should link to x402 Bazaar')
  })

  it('includes CSS styles', () => {
    const html = layout('Test', '')
    assert.ok(html.includes('<style>'))
    assert.ok(html.includes('--bg:'))
  })

  it('escapes HTML in meta description to prevent XSS', () => {
    const xss = '"><script>alert(document.cookie)</script>'
    const html = layout('Test', '<p>Hello</p>', { description: xss })
    assert.ok(!html.includes('<script>alert('), 'description must be escaped in meta tags')
    assert.ok(html.includes('&lt;script&gt;'), 'angle brackets should be escaped')
    assert.ok(html.includes('&quot;'), 'quotes should be escaped')
  })

  it('escapes HTML in ogTitle to prevent XSS', () => {
    const xss = '"><img src=x onerror=alert(1)>'
    const html = layout('Test', '', { ogTitle: xss })
    assert.ok(!html.includes('<img src=x'), 'ogTitle must not contain unescaped HTML tags')
    assert.ok(html.includes('&lt;img'), 'angle brackets should be escaped in ogTitle')
  })

  it('escapes HTML in ogUrl to prevent XSS', () => {
    const xss = '"><script>alert(1)</script>'
    const html = layout('Test', '', { ogUrl: xss })
    assert.ok(!html.includes('<script>alert'), 'ogUrl must be escaped in meta tags')
  })

  it('escapes XSS payload in title tag', () => {
    const xss = '</title><script>alert(1)</script>'
    const html = layout(xss, '<p>content</p>')
    assert.ok(!html.includes('</title><script>'), 'title tag must not allow breakout')
    assert.ok(html.includes('&lt;/title&gt;'), 'title should have escaped angle brackets')
  })
})

describe('aboutPage', () => {
  it('renders about page with expected content', () => {
    const html = aboutPage()
    assert.ok(html.includes('What is 402 Index?'))
    assert.ok(html.includes('L402'))
    assert.ok(html.includes('x402'))
    assert.ok(html.includes('Bazaar'))
    assert.ok(html.includes('Satring'))
  })

  it('links to data source websites', () => {
    const html = aboutPage()
    assert.ok(html.includes('href="https://satring.com"'), 'should link to Satring')
    assert.ok(html.includes('href="https://x402.org/bazaar"'), 'should link to x402 Bazaar')
    assert.ok(html.includes('href="https://l402apps.com"'), 'should link to L402 Apps')
    assert.ok(html.includes('href="https://paysponge.com"'), 'should link to Sponge')
    assert.ok(html.includes('href="https://mpp.dev"'), 'should link to MPP/Tempo')
  })
})

describe('apiDocsPage', () => {
  it('renders API docs with endpoints', () => {
    const html = apiDocsPage()
    assert.ok(html.includes('402 Index API'))
    assert.ok(html.includes('/api/v1/services'))
    assert.ok(html.includes('/api/v1/categories'))
    assert.ok(html.includes('/api/v1/health'))
  })

  it('includes parameter documentation', () => {
    const html = apiDocsPage()
    assert.ok(html.includes('protocol'))
    assert.ok(html.includes('category'))
    assert.ok(html.includes('limit'))
    assert.ok(html.includes('offset'))
  })

  it('includes rate limit information', () => {
    const html = apiDocsPage()
    assert.ok(html.includes('100 req/min'))
    assert.ok(html.includes('1,000 req/min'))
    assert.ok(html.includes('L402'))
  })
})

describe('homePage (directory page)', () => {
  it('renders service list', () => {
    const html = homePage({
      services: [{
        id: '1',
        name: 'Test Service',
        url: 'https://example.com/api',
        protocol: 'x402',
        price_usd: 0.01,
        category: 'tools',
        health_status: 'healthy',
        latency_p50_ms: 100,
        source: 'bazaar',
      }],
      total: 1,
      limit: 50,
      offset: 0,
      filters: {},
      stats: { verified: 100, totalIndexed: 500, healthy: 80, degraded: 10, down: 5, unknown: 5 },
      categories: [{ category: 'tools', count: 10 }],
    })

    assert.ok(html.includes('Test Service'))
    assert.ok(html.includes('services-table'), 'should have services table')
  })

  it('renders empty state when no services', () => {
    const html = homePage({
      services: [],
      total: 0,
      limit: 50,
      offset: 0,
      filters: {},
      stats: { verified: 0, totalIndexed: 0, healthy: 0, degraded: 0, down: 0, unknown: 0 },
      categories: [],
    })
    assert.ok(html.includes('No services found'))
  })

  it('does not render stats-bar or protocol-bar (moved to homepage)', () => {
    const html = homePage({
      services: [],
      total: 0,
      limit: 50,
      offset: 0,
      filters: {},
      stats: { verified: 100, totalIndexed: 500, healthy: 80, degraded: 10, down: 5, unknown: 5 },
      categories: [],
    })
    assert.ok(!html.includes('class="stats-bar"'), 'should not have stats-bar')
    assert.ok(!html.includes('class="protocol-bar"'), 'should not have protocol-bar')
  })

  it('renders source as hyperlink for known sources', () => {
    const html = homePage({
      services: [{
        id: '1', name: 'Test', url: 'https://example.com',
        protocol: 'x402', health_status: 'healthy',
        source: 'satring',
      }],
      total: 1, limit: 50, offset: 0, filters: {},
      stats: { verified: 1, totalIndexed: 1, healthy: 1, degraded: 0, down: 0, unknown: 0 },
      categories: [],
    })
    assert.ok(html.includes('href="https://satring.com"'), 'source tag should link to satring.com')
  })

  it('renders source as plain text for non-linked sources', () => {
    const html = homePage({
      services: [{
        id: '1', name: 'Test', url: 'https://example.com',
        protocol: 'x402', health_status: 'healthy',
        source: 'exclusive',
      }],
      total: 1, limit: 50, offset: 0, filters: {},
      stats: { verified: 1, totalIndexed: 1, healthy: 1, degraded: 0, down: 0, unknown: 0 },
      categories: [],
    })
    // The source filter dropdown will have href= in its form, so check specifically in the source-tag
    assert.ok(html.includes('<span class="source-tag">exclusive</span>'), 'exclusive source should be plain text')
  })

  it('escapes HTML in service names', () => {
    const html = homePage({
      services: [{
        id: '1',
        name: '<script>alert("xss")</script>',
        url: 'https://example.com',
        protocol: 'x402',
        health_status: 'healthy',
        source: 'bazaar',
      }],
      total: 1,
      limit: 50,
      offset: 0,
      filters: {},
      stats: { verified: 1, totalIndexed: 1, healthy: 1, degraded: 0, down: 0, unknown: 0 },
      categories: [],
    })
    assert.ok(!html.includes('<script>alert("xss")</script>'))
    assert.ok(html.includes('&lt;script&gt;'))
  })
})

describe('detailPage', () => {
  it('renders service detail page', () => {
    const html = detailPage({
      name: 'Test API',
      url: 'https://example.com/api',
      protocol: 'L402',
      price_sats: 500,
      health_status: 'healthy',
      category: 'tools',
      provider: 'TestCorp',
      payment_asset: 'BTC',
      payment_network: 'Lightning',
      source: 'exclusive',
      health_checks: [],
      consecutive_failures: 0,
    })

    assert.ok(html.includes('Test API'))
    assert.ok(html.includes('https://example.com/api'))
    assert.ok(html.includes('L402'))
    assert.ok(html.includes('TestCorp'))
    assert.ok(html.includes('BTC'))
    assert.ok(html.includes('Lightning'))
  })

  it('renders payment fields as dashes when missing', () => {
    const html = detailPage({
      name: 'Bare Service',
      url: 'https://example.com',
      protocol: 'x402',
      health_status: 'unknown',
      source: 'bazaar',
      consecutive_failures: 0,
      health_checks: [],
    })
    // Payment Asset and Payment Network rows should show dash
    assert.ok(html.includes('Payment Asset'))
    assert.ok(html.includes('Payment Network'))
  })

  it('renders health check history', () => {
    const html = detailPage({
      name: 'Test',
      url: 'https://example.com',
      protocol: 'x402',
      health_status: 'healthy',
      source: 'bazaar',
      consecutive_failures: 0,
      health_checks: [{
        checked_at: '2025-02-28T12:00:00Z',
        status: 'healthy',
        http_status: 402,
        response_time_ms: 150,
      }],
    })

    assert.ok(html.includes('2025-02-28T12:00:00Z'))
    assert.ok(html.includes('402'))
    assert.ok(html.includes('150ms'))
  })

  it('renders schemas when present', () => {
    const html = detailPage({
      name: 'Test',
      url: 'https://example.com',
      protocol: 'x402',
      health_status: 'healthy',
      source: 'bazaar',
      consecutive_failures: 0,
      health_checks: [],
      input_schema: '{"type":"string"}',
      output_schema: '{"type":"number"}',
    })

    assert.ok(html.includes('Input Schema'))
    assert.ok(html.includes('Output Schema'))
  })
  it('renders source as hyperlink on detail page', () => {
    const html = detailPage({
      name: 'Test', url: 'https://example.com', protocol: 'L402',
      health_status: 'healthy', source: 'satring',
      consecutive_failures: 0, health_checks: [],
    })
    assert.ok(html.includes('href="https://satring.com"'), 'detail source should link to satring.com')
  })

  it('escapes consecutive_failures to prevent XSS', () => {
    const html = detailPage({
      name: 'Test', url: 'https://example.com', protocol: 'L402',
      health_status: 'healthy', source: 'satring',
      consecutive_failures: '<img src=x onerror=alert(1)>', health_checks: [],
    })
    assert.ok(!html.includes('<img src=x'), 'consecutive_failures must be escaped')
    assert.ok(html.includes('&lt;img'), 'angle brackets should be entity-encoded')
  })
})

describe('adminPage', () => {
  it('renders admin page with password form', () => {
    const html = adminPage()
    assert.ok(html.includes('402index Admin'))
    assert.ok(html.includes('type="password"'))
    assert.ok(html.includes('admin secret'))
    assert.ok(html.includes('id="auth-form"'))
  })

  it('uses event delegation instead of inline onclick for admin actions', () => {
    const html = adminPage()
    assert.ok(!html.includes('onclick="approve'), 'no inline approve handler')
    assert.ok(!html.includes('onclick="reject'), 'no inline reject handler')
    assert.ok(!html.includes('onclick="delete'), 'no inline delete handler')
    assert.ok(html.includes('data-id'), 'approve/reject buttons should use data-id')
    assert.ok(html.includes('data-name'), 'reject button should use data-name')
    assert.ok(html.includes('pending-list'), 'should have pending-list container for delegation')
  })

  it('renders payment_asset and payment_network fields in admin card', () => {
    const html = adminPage()
    assert.ok(html.includes('payment_asset'), 'admin card should reference payment_asset')
    assert.ok(html.includes('payment_network'), 'admin card should reference payment_network')
  })
})

describe('opportunitiesPage — XSS', () => {
  it('escapes unknown type key that falls through TYPE_LABELS', () => {
    const html = opportunitiesPage({
      opportunities: [{
        type: '<script>alert(1)</script>',
        category: 'test',
        healthy_endpoints: 1,
        total_endpoints: 2,
        protocol_coverage: { L402: 1, x402: 1 },
        provider_count: 1,
        suggestion: 'test',
      }],
      protocol: null,
    })
    assert.ok(!html.includes('<script>alert(1)</script>'), 'type fallback must be escaped')
    assert.ok(html.includes('&lt;script&gt;'), 'type should be entity-encoded')
  })
})
