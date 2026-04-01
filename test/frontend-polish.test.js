import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { layout } from '../src/views/layout.js'
import { homePage } from '../src/views/home.js'
import { detailPage } from '../src/views/detail.js'
import { apiDocsPage } from '../src/views/api-docs.js'
import { statsPage } from '../src/views/stats.js'
import { statsSimplePage } from '../src/views/stats-simple.js'
import { verifyPage } from '../src/views/verify.js'
import { adminPage } from '../src/views/admin.js'

// ─── A. OG Image ────────────────────────────────────────────────────────────

describe('OG image optimization', () => {
  const imgPath = new URL('../public/og-image.png', import.meta.url).pathname

  it('og-image.png is ≤120 KB', () => {
    const stat = readFileSync(imgPath)
    assert.ok(stat.length <= 120 * 1024, `og-image.png is ${(stat.length / 1024).toFixed(0)} KB, expected ≤120 KB`)
  })

  it('og-image.png is exactly 1200x630', () => {
    const info = execSync(`sips -g pixelWidth -g pixelHeight "${imgPath}"`).toString()
    const width = info.match(/pixelWidth:\s*(\d+)/)?.[1]
    const height = info.match(/pixelHeight:\s*(\d+)/)?.[1]
    assert.equal(width, '1200', `width should be 1200, got ${width}`)
    assert.equal(height, '630', `height should be 630, got ${height}`)
  })

  it('no leftover og-image build artifacts in public/', () => {
    const publicDir = new URL('../public/', import.meta.url).pathname
    const ogArtifacts = readdirSync(publicDir).filter(f => f.startsWith('og-image') && f !== 'og-image.png')
    assert.deepStrictEqual(ogArtifacts, [], `unexpected og-image artifacts: ${ogArtifacts.join(', ')}`)
  })

  it('meta tags declare correct dimensions matching actual image', () => {
    const html = layout('Test', '<p>content</p>')
    assert.ok(html.includes('content="1200"'), 'og:image:width should be 1200')
    assert.ok(html.includes('content="630"'), 'og:image:height should be 630')
  })
})

// ─── B. Main Landmark ───────────────────────────────────────────────────────

describe('main landmark', () => {
  it('layout wraps content in <main> tag', () => {
    const html = layout('Test', '<p>Hello</p>')
    assert.ok(html.includes('<main>'), 'should have <main> tag')
    assert.ok(html.includes('</main>'), 'should have </main> tag')
  })

  it('<main> wraps only content, not header or footer', () => {
    const html = layout('Test', '<p>Hello</p>')
    const mainStart = html.indexOf('<main>')
    const mainEnd = html.indexOf('</main>')
    const headerEnd = html.indexOf('</header>')
    const footerStart = html.indexOf('<footer>')

    assert.ok(mainStart > headerEnd, '<main> should come after </header>')
    assert.ok(mainEnd < footerStart, '</main> should come before <footer>')
    assert.ok(html.includes('<main>\n  <p>Hello</p>\n  </main>') || html.includes('<main><p>Hello</p></main>') || (html.indexOf('<p>Hello</p>') > mainStart && html.indexOf('<p>Hello</p>') < mainEnd), 'content should be inside <main>')
  })
})

// ─── C. Table Header Scope ──────────────────────────────────────────────────

describe('table header scope attributes', () => {
  const homeHtml = homePage({
    services: [{ id: '1', name: 'Test', url: 'https://example.com', protocol: 'x402', health_status: 'healthy', source: 'bazaar' }],
    total: 1, limit: 50, offset: 0, filters: {},
    stats: { verified: 1, totalIndexed: 1, healthy: 1, degraded: 0, down: 0, unknown: 0 },
    categories: [],
  })

  it('home.js table headers have scope="col"', () => {
    // Match <th ...> but not <thead ...>
    const thTags = homeHtml.match(/<th\b(?!ead)[^>]*>/g) || []
    assert.ok(thTags.length > 0, 'should have <th> tags')
    for (const th of thTags) {
      assert.ok(th.includes('scope="col"'), `missing scope="col" in: ${th}`)
    }
  })

  it('stats.js table headers have scope="col"', () => {
    const html = statsPage({
      scoreboard: { providers: [], endpoints: [] },
      latency: { median: 100, fastestProtocol: 'L402', fastestMedian: 80, under500: 90, protocolSummary: { L402: { median: 80, p90: 200, under500: 90 }, x402: { median: 120, p90: 300, under500: 85 }, MPP: { median: 100, p90: 250, under500: 88 } } },
      categoryGap: { grid: [{ category: 'test', L402: 1, x402: 2, MPP: 0, total: 3 }], opportunities: [] },
    })
    const thTags = html.match(/<th\b(?!ead)[^>]*>/g) || []
    assert.ok(thTags.length > 0, 'should have <th> tags')
    for (const th of thTags) {
      assert.ok(th.includes('scope="col"'), `missing scope="col" in: ${th}`)
    }
  })

  it('stats-simple.js table headers have scope="col"', () => {
    const html = statsSimplePage({
      latency: { protocolSummary: { L402: { median: 80, p90: 200, under500: 90 } } },
      categoryGap: { grid: [{ category: 'test', L402: 1, x402: 2, MPP: 0, total: 3 }], opportunities: [] },
    })
    const thTags = html.match(/<th\b(?!ead)[^>]*>/g) || []
    assert.ok(thTags.length > 0, 'should have <th> tags')
    for (const th of thTags) {
      assert.ok(th.includes('scope="col"'), `missing scope="col" in: ${th}`)
    }
  })

  it('detail.js health history table headers have scope="col"', () => {
    const html = detailPage({
      name: 'Test', url: 'https://example.com', protocol: 'L402',
      health_status: 'healthy', source: 'bazaar', consecutive_failures: 0,
      health_checks: [{ checked_at: '2025-01-01', status: 'healthy', http_status: 402, response_time_ms: 100 }],
    })
    const thTags = html.match(/<th\b(?!ead)[^>]*>/g) || []
    assert.ok(thTags.length > 0, 'should have <th> tags')
    for (const th of thTags) {
      assert.ok(th.includes('scope="col"'), `missing scope="col" in: ${th}`)
    }
  })

  it('verify.js table headers have scope="col"', () => {
    const html = verifyPage()
    const thTags = html.match(/<th\b(?!ead)[^>]*>/g) || []
    assert.ok(thTags.length > 0, 'should have <th> tags')
    for (const th of thTags) {
      assert.ok(th.includes('scope="col"'), `missing scope="col" in: ${th}`)
    }
  })

  it('api-docs.js table headers have scope="col"', () => {
    const html = apiDocsPage()
    const thTags = html.match(/<th\b(?!ead)[^>]*>/g) || []
    assert.ok(thTags.length > 0, 'should have <th> tags in api-docs')
    for (const th of thTags) {
      assert.ok(th.includes('scope="col"'), `missing scope="col" in: ${th}`)
    }
  })

  it('admin.js table headers have scope="col"', () => {
    const html = adminPage()
    const thTags = html.match(/<th\b(?!ead)[^>]*>/g) || []
    assert.ok(thTags.length > 0, 'should have <th> tags in admin')
    for (const th of thTags) {
      assert.ok(th.includes('scope="col"'), `missing scope="col" in: ${th}`)
    }
  })
})

// ─── D. CSP ─────────────────────────────────────────────────────────────────

describe('CSP configuration', () => {
  it('server.js does not disable CSP', () => {
    const serverSrc = readFileSync(new URL('../src/server.js', import.meta.url).pathname, 'utf8')
    assert.ok(!serverSrc.includes('contentSecurityPolicy: false'), 'CSP should not be disabled')
  })

  it('server.js configures CSP directives', () => {
    const serverSrc = readFileSync(new URL('../src/server.js', import.meta.url).pathname, 'utf8')
    assert.ok(serverSrc.includes('contentSecurityPolicy'), 'should have contentSecurityPolicy config')
    assert.ok(serverSrc.includes('directives'), 'should have directives object')
    assert.ok(serverSrc.includes('defaultSrc'), 'should have defaultSrc directive')
    assert.ok(serverSrc.includes('scriptSrc'), 'should have scriptSrc directive')
    assert.ok(serverSrc.includes('styleSrc'), 'should have styleSrc directive')
    assert.ok(serverSrc.includes('frameAncestors'), 'should have frameAncestors directive')
    assert.ok(serverSrc.includes("objectSrc"), 'should have objectSrc directive')
  })
})
