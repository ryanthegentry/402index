import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { layout } from '../src/views/layout.js'
import { aboutPage } from '../src/views/about.js'
import { apiDocsPage } from '../src/views/api-docs.js'
import { homePage } from '../src/views/home.js'
import { detailPage } from '../src/views/detail.js'

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
    assert.ok(html.includes('href="/about"'))
    assert.ok(html.includes('href="/api-docs"'))
  })

  it('includes footer', () => {
    const html = layout('Test', '')
    assert.ok(html.includes('402 Index'))
    assert.ok(html.includes('</footer>'))
  })

  it('includes CSS styles', () => {
    const html = layout('Test', '')
    assert.ok(html.includes('<style>'))
    assert.ok(html.includes('--bg:'))
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

describe('homePage', () => {
  it('renders service list with stats', () => {
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
      stats: { total: 100, healthy: 80, degraded: 10, down: 5, unknown: 5 },
      categories: [{ category: 'tools', count: 10 }],
    })

    assert.ok(html.includes('Test Service'))
    assert.ok(html.includes('services indexed'))
    assert.ok(html.includes('>100<'))
  })

  it('renders empty state when no services', () => {
    const html = homePage({
      services: [],
      total: 0,
      limit: 50,
      offset: 0,
      filters: {},
      stats: { total: 0, healthy: 0, degraded: 0, down: 0, unknown: 0 },
      categories: [],
    })
    assert.ok(html.includes('services indexed'))
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
      stats: { total: 1, healthy: 1, degraded: 0, down: 0, unknown: 0 },
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
      source: 'exclusive',
      health_checks: [],
      consecutive_failures: 0,
    })

    assert.ok(html.includes('Test API'))
    assert.ok(html.includes('https://example.com/api'))
    assert.ok(html.includes('L402'))
    assert.ok(html.includes('TestCorp'))
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
})
