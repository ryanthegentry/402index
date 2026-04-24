import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '..', 'fixtures')

function loadFixture(name) {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))
}

const ROUTE_MAP = [
  { pathname: '/api/v1/health', fixture: 'health.json' },
  { pathname: '/api/v1/categories', fixture: 'categories.json' },
  {
    pathname: '/api/v1/services',
    match: (url) => {
      const p = url.searchParams
      if (p.get('verified') === 'true' && p.get('limit') === '3') return 'services-verified-limit-3.json'
      if (p.get('protocol') === 'x402' && p.get('limit') === '3') return 'services-protocol-x402-limit-3.json'
      if (p.get('limit') === '1') return 'services-limit-1.json'
      if (p.get('limit') === '3') return 'services-limit-3.json'
      if (p.get('limit') === '5') return 'services-limit-5.json'
      return null
    },
  },
]

function resolveFixture(urlStr) {
  const url = new URL(urlStr)
  const pathname = url.pathname

  // Service detail: /api/v1/services/:id
  if (/^\/api\/v1\/services\/[^/]+$/.test(pathname)) {
    return 'services-detail.json'
  }

  for (const route of ROUTE_MAP) {
    if (route.pathname === pathname) {
      const fixture = typeof route.match === 'function' ? route.match(url) : route.fixture
      if (!fixture) {
        throw new Error(`[mock-fetch] No fixture for services query: ${url.search} — add a fixture and update the match() function in mock-fetch.js`)
      }
      return fixture
    }
  }

  return null
}

let _originalFetch

export function installMockFetch() {
  _originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const urlStr = typeof input === 'string' ? input : input.url
    const fixtureName = resolveFixture(urlStr)
    if (!fixtureName) {
      throw new Error(`[mock-fetch] No fixture for URL: ${urlStr} — add a fixture or update mock-fetch.js`)
    }
    const data = loadFixture(fixtureName)
    return {
      ok: true,
      status: 200,
      json: async () => data,
      text: async () => JSON.stringify(data),
    }
  }
}

export function restoreFetch() {
  if (_originalFetch) {
    globalThis.fetch = _originalFetch
    _originalFetch = undefined
  }
}
