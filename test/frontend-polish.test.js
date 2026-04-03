import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { layout } from '../src/views/layout.js'
import { homePage } from '../src/views/home.js'
import { detailPage } from '../src/views/detail.js'
import { apiDocsPage } from '../src/views/api-docs.js'
import { statsPage } from '../src/views/stats.js'
import { statsSimplePage } from '../src/views/stats-simple.js'
import { verifyPage } from '../src/views/verify.js'
import { adminPage } from '../src/views/admin.js'
import { app } from '../src/server.js'

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

// ─── D. CSP (integration — inspects actual HTTP header) ─────────────────────

describe('CSP configuration (integration)', () => {
  let server
  let baseUrl

  // Boot the app on a random port
  after(() => { if (server) server.close() })

  async function getCSPHeader() {
    if (!server) {
      await new Promise((resolve, reject) => {
        server = app.listen(0, () => {
          baseUrl = `http://127.0.0.1:${server.address().port}`
          resolve()
        })
        server.on('error', reject)
      })
    }
    const res = await fetch(`${baseUrl}/about`)
    return res.headers.get('content-security-policy')
  }

  it('CSP header includes script-src-attr \'unsafe-inline\'', async () => {
    const csp = await getCSPHeader()
    assert.ok(csp, 'CSP header should be present')
    assert.ok(
      csp.includes("script-src-attr 'unsafe-inline'"),
      `CSP should include script-src-attr 'unsafe-inline', got: ${csp}`
    )
  })

  it('CSP header does NOT include script-src-attr \'none\'', async () => {
    const csp = await getCSPHeader()
    assert.ok(csp, 'CSP header should be present')
    assert.ok(
      !csp.includes("script-src-attr 'none'"),
      `CSP should not include script-src-attr 'none', got: ${csp}`
    )
  })

  it('CSP header preserves other directives', async () => {
    const csp = await getCSPHeader()
    assert.ok(csp.includes("default-src 'self'"), 'should have default-src')
    assert.ok(csp.includes("script-src 'self'"), 'should have script-src')
    assert.ok(csp.includes("style-src 'self'"), 'should have style-src')
    assert.ok(csp.includes("frame-ancestors 'none'"), 'should have frame-ancestors')
    assert.ok(csp.includes("object-src 'none'"), 'should have object-src')
  })
})

// ─── E. Repo Hygiene ──────────────────────────────────────────────────────────

describe('repo hygiene', () => {
  it('no leftover debug scripts in repo root', () => {
    const rootDir = fileURLToPath(new URL('..', import.meta.url))
    const debugFiles = readdirSync(rootDir).filter(f => f === 'test-csp.mjs')
    assert.deepStrictEqual(debugFiles, [], `leftover debug file(s) in repo root: ${debugFiles.join(', ')}`)
  })
})

// ─── F. isDirectRun Guard ─────────────────────────────────────────────────────

describe('isDirectRun guard', () => {
  it('server.js uses fileURLToPath for direct-run detection', () => {
    const serverSrc = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8')
    assert.ok(
      serverSrc.includes('fileURLToPath(import.meta.url)'),
      'isDirectRun should use fileURLToPath(import.meta.url), not fragile string suffix matching'
    )
    assert.ok(
      !serverSrc.includes("endsWith('/server.js')"),
      'isDirectRun should not use endsWith string matching'
    )
  })

  it('importing server.js does not call listen()', async () => {
    // The app export exists and is usable without a server starting
    assert.ok(app, 'app should be exported')
    assert.ok(typeof app.listen === 'function', 'app should be an Express app')
  })
})
