import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Part A: SEO Infrastructure ─────────────────────────────────────────────

// A1. robots.txt — source verification
describe('robots.txt', async () => {
  const pagesSource = readFileSync(join(__dirname, '../src/routes/pages.js'), 'utf-8')

  it('route exists in pages.js', () => {
    assert.ok(pagesSource.includes("'/robots.txt'") || pagesSource.includes('"/robots.txt"'))
  })

  it('contains Disallow: /admin', () => {
    assert.ok(pagesSource.includes('Disallow: /admin'))
  })

  it('contains Sitemap: https://402index.io/sitemap.xml', () => {
    assert.ok(pagesSource.includes('Sitemap: https://402index.io/sitemap.xml'))
  })

  it('sets Content-Type text/plain', () => {
    assert.ok(pagesSource.includes('text/plain'))
  })

  it('contains Disallow: /stats-dev', () => {
    assert.ok(pagesSource.includes('Disallow: /stats-dev'))
  })

  it('references llms.txt and openapi.json', () => {
    assert.ok(pagesSource.includes('llms.txt'))
    assert.ok(pagesSource.includes('openapi.json'))
  })
})

// A2. sitemap.xml — source verification
describe('sitemap.xml', async () => {
  const pagesSource = readFileSync(join(__dirname, '../src/routes/pages.js'), 'utf-8')

  it('route exists in pages.js', () => {
    assert.ok(pagesSource.includes("'/sitemap.xml'") || pagesSource.includes('"/sitemap.xml"'))
  })

  it('sets Content-Type application/xml', () => {
    assert.ok(pagesSource.includes('application/xml'))
  })

  it('includes urlset root element', () => {
    assert.ok(pagesSource.includes('<urlset'))
  })

  it('includes static pages', () => {
    assert.ok(pagesSource.includes('https://402index.io/'))
    assert.ok(pagesSource.includes('https://402index.io/stats'))
    assert.ok(pagesSource.includes('https://402index.io/directory'))
    assert.ok(pagesSource.includes('https://402index.io/about'))
    assert.ok(pagesSource.includes('https://402index.io/api-docs'))
  })

  it('includes /service/ URL pattern for dynamic pages', () => {
    assert.ok(pagesSource.includes('https://402index.io/service/'))
  })

  it('includes lastmod tags', () => {
    assert.ok(pagesSource.includes('<lastmod>'))
  })

  it('sets cache-control with max-age=3600', () => {
    assert.ok(pagesSource.includes('3600'))
  })
})

// A3. Canonical URLs
describe('layout — canonical URLs', async () => {
  const { layout } = await import('../src/views/layout.js')

  it('renders canonical link tag when canonical is provided', () => {
    const html = layout('Test', '<p>content</p>', { canonical: '/stats' })
    assert.ok(html.includes('<link rel="canonical" href="https://402index.io/stats"'))
  })

  it('canonical URL does not contain query parameters', () => {
    const html = layout('Test', '<p>content</p>', { canonical: '/directory' })
    assert.ok(!html.includes('?'), 'Canonical should not have query params')
    assert.ok(html.includes('href="https://402index.io/directory"'))
  })

  it('renders canonical for homepage as /', () => {
    const html = layout('Test', '<p>content</p>', { canonical: '/' })
    assert.ok(html.includes('href="https://402index.io/"'))
  })
})

// A4. JSON-LD Structured Data
describe('layout — JSON-LD structured data', async () => {
  const { layout } = await import('../src/views/layout.js')

  it('renders application/ld+json script tag when jsonLd is provided', () => {
    const jsonLd = { '@context': 'https://schema.org', '@type': 'WebApplication', name: '402 Index' }
    const html = layout('Test', '<p>content</p>', { jsonLd })
    assert.ok(html.includes('application/ld+json'))
  })

  it('renders the JSON-LD content', () => {
    const jsonLd = { '@context': 'https://schema.org', '@type': 'WebApplication', name: '402 Index' }
    const html = layout('Test', '<p>content</p>', { jsonLd })
    assert.ok(html.includes('"@type":"WebApplication"') || html.includes('"@type": "WebApplication"'))
  })

  it('does not render ld+json when jsonLd is not provided', () => {
    const html = layout('Test', '<p>content</p>')
    assert.ok(!html.includes('application/ld+json'))
  })
})

// A4 continued — homepage JSON-LD
describe('homepage — JSON-LD', async () => {
  const pagesSource = readFileSync(join(__dirname, '../src/routes/pages.js'), 'utf-8')

  it('homepage route passes jsonLd with WebApplication type', () => {
    assert.ok(pagesSource.includes('WebApplication'))
  })

  it('homepage route passes canonical: "/"', () => {
    // Check that the homepage route sets canonical
    assert.ok(pagesSource.includes("canonical: '/'") || pagesSource.includes('canonical: "/"'))
  })
})

// A5. Service detail page meta
describe('service detail page — meta', async () => {
  const { detailPage } = await import('../src/views/detail.js')

  const mockService = {
    id: 'test-123',
    name: 'Test Weather API',
    description: 'Real-time weather data',
    url: 'https://api.example.com/weather',
    protocol: 'L402',
    health_status: 'healthy',
    provider: 'Test Corp',
    source: 'exclusive',
    category: 'data',
    price_sats: 5,
    health_checks: [],
  }

  it('meta title includes service name', () => {
    const html = detailPage(mockService)
    assert.ok(html.includes('Test Weather API'))
    assert.ok(html.includes('<title>'))
  })

  it('contains application/ld+json with WebAPI type', () => {
    const html = detailPage(mockService)
    assert.ok(html.includes('application/ld+json'))
    assert.ok(html.includes('"@type":"WebAPI"') || html.includes('"@type": "WebAPI"'))
  })

  it('JSON-LD includes service name', () => {
    const html = detailPage(mockService)
    assert.ok(html.includes('Test Weather API'))
  })

  it('meta description includes protocol and health status', () => {
    const html = detailPage(mockService)
    assert.ok(html.includes('L402'))
    assert.ok(html.includes('healthy'))
  })

  it('has canonical URL with service id', () => {
    const html = detailPage(mockService)
    assert.ok(html.includes('canonical'))
    assert.ok(html.includes('/service/test-123'))
  })
})

// A6. Google Search Console verification
describe('layout — Google Search Console verification', async () => {
  const { layout } = await import('../src/views/layout.js')

  it('renders google-site-verification meta when env var is set', () => {
    const original = process.env.GOOGLE_SITE_VERIFICATION
    process.env.GOOGLE_SITE_VERIFICATION = 'abc123test'
    const html = layout('Test', '<p>content</p>')
    assert.ok(html.includes('google-site-verification'))
    assert.ok(html.includes('abc123test'))
    if (original === undefined) delete process.env.GOOGLE_SITE_VERIFICATION
    else process.env.GOOGLE_SITE_VERIFICATION = original
  })

  it('does not render google-site-verification when env var is absent', () => {
    const original = process.env.GOOGLE_SITE_VERIFICATION
    delete process.env.GOOGLE_SITE_VERIFICATION
    const html = layout('Test', '<p>content</p>')
    assert.ok(!html.includes('google-site-verification'))
    if (original !== undefined) process.env.GOOGLE_SITE_VERIFICATION = original
  })
})

// A7. Analytics script placeholder
describe('layout — Plausible analytics', async () => {
  const { layout } = await import('../src/views/layout.js')

  it('renders Plausible script when PLAUSIBLE_DOMAIN is set', () => {
    const original = process.env.PLAUSIBLE_DOMAIN
    process.env.PLAUSIBLE_DOMAIN = '402index.io'
    const html = layout('Test', '<p>content</p>')
    assert.ok(html.includes('plausible.io'))
    assert.ok(html.includes('402index.io'))
    if (original === undefined) delete process.env.PLAUSIBLE_DOMAIN
    else process.env.PLAUSIBLE_DOMAIN = original
  })

  it('does not render Plausible script when env var is absent', () => {
    const original = process.env.PLAUSIBLE_DOMAIN
    delete process.env.PLAUSIBLE_DOMAIN
    const html = layout('Test', '<p>content</p>')
    assert.ok(!html.includes('plausible.io'))
    if (original !== undefined) process.env.PLAUSIBLE_DOMAIN = original
  })
})

// ─── Part B: Admin Traffic Dashboard ────────────────────────────────────────

describe('admin page — Traffic tab', async () => {
  const { adminPage } = await import('../src/views/admin.js')
  const html = adminPage()

  it('has Traffic tab button', () => {
    assert.ok(html.includes('data-tab="traffic"'))
  })

  it('has traffic panel', () => {
    assert.ok(html.includes('panel-traffic'))
  })

  it('tab bar includes Traffic alongside existing tabs', () => {
    assert.ok(html.includes('Pending'))
    assert.ok(html.includes('Recent'))
    assert.ok(html.includes('Search'))
    assert.ok(html.includes('Traffic'))
  })
})

describe('admin traffic API routes', async () => {
  const apiSource = readFileSync(join(__dirname, '../src/routes/api.js'), 'utf-8')

  it('has /admin/traffic route', () => {
    assert.ok(apiSource.includes("'/admin/traffic'") || apiSource.includes('"/admin/traffic"'))
  })
})
