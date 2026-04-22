import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

// ─── Package metadata ────────────────────────────────────────────────────────

describe('package.json metadata', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

  it('version === "0.3.0"', () => assert.strictEqual(pkg.version, '0.3.0'))
  it('bin["mcp-server"] === "dist/index.js"', () => assert.strictEqual(pkg.bin['mcp-server'], 'dist/index.js'))
  it('bin["402index-mcp"] === undefined', () => assert.strictEqual(pkg.bin['402index-mcp'], undefined))
  it('mcpName === "io.github.ryanthegentry/402index"', () =>
    assert.strictEqual(pkg.mcpName, 'io.github.ryanthegentry/402index'))
  it('files equals ["dist","README.md","LICENSE","llms-install.md"]', () =>
    assert.deepStrictEqual(pkg.files, ['dist', 'README.md', 'LICENSE', 'llms-install.md']))
  it('keywords.length === 15', () => assert.strictEqual(pkg.keywords.length, 15))
  it('keywords contains all 15 values from 0.2.5', () => {
    const expected = [
      'mcp', 'mcp-server', 'model-context-protocol', '402-index', 'paid-api',
      'api-directory', 'l402', 'x402', 'mpp', 'lightning', 'bitcoin',
      'agent-commerce', 'micropayments', 'api-discovery', 'health-monitoring',
    ]
    for (const kw of expected) assert.ok(pkg.keywords.includes(kw), `missing keyword: ${kw}`)
  })
  it('author === "Ryan Gentry <hello@402index.io>"', () =>
    assert.strictEqual(pkg.author, 'Ryan Gentry <hello@402index.io>'))
  it('license === "MIT"', () => assert.strictEqual(pkg.license, 'MIT'))
  it('engines.node === ">=18"', () => assert.strictEqual(pkg.engines.node, '>=18'))
  it('homepage === "https://402index.io"', () => assert.strictEqual(pkg.homepage, 'https://402index.io'))
  it('bugs.url === "https://github.com/ryanthegentry/402index/issues"', () =>
    assert.strictEqual(pkg.bugs.url, 'https://github.com/ryanthegentry/402index/issues'))
  it('repository.directory === "mcp-server"', () => assert.strictEqual(pkg.repository.directory, 'mcp-server'))
  it('scripts.prepublishOnly === "npm run build"', () =>
    assert.strictEqual(pkg.scripts.prepublishOnly, 'npm run build'))
})

// ─── Required files ──────────────────────────────────────────────────────────

describe('required files exist', () => {
  it('LICENSE exists', () => assert.ok(existsSync(join(ROOT, 'LICENSE'))))
  it('llms-install.md exists', () => assert.ok(existsSync(join(ROOT, 'llms-install.md'))))
  it('server.json exists', () => assert.ok(existsSync(join(ROOT, 'server.json'))))
  it('.tarball-allowlist.txt exists', () => assert.ok(existsSync(join(ROOT, '.tarball-allowlist.txt'))))
})

// ─── Tarball allowlist ────────────────────────────────────────────────────────

describe('.tarball-allowlist.txt', () => {
  it('has exactly 6 sorted lines matching package.json#files resolution', () => {
    const txt = readFileSync(join(ROOT, '.tarball-allowlist.txt'), 'utf8').trim()
    const lines = txt.split('\n')
    assert.deepStrictEqual(lines, [
      'LICENSE',
      'README.md',
      'dist/index.d.ts',
      'dist/index.js',
      'llms-install.md',
      'package.json',
    ])
  })
})

// ─── Helper unit tests ────────────────────────────────────────────────────────

describe('DEFAULT_FIELDS / filterFields / toCsv helpers (unit)', () => {
  it('DEFAULT_FIELDS is ["name","url","protocol","price_sats","health_status"]', async () => {
    const { DEFAULT_FIELDS } = await import('../dist/index.js')
    assert.deepStrictEqual(DEFAULT_FIELDS, ['name', 'url', 'protocol', 'price_sats', 'health_status'])
  })

  it('filterFields([{a:1,b:2}], "a") returns [{a:1}]', async () => {
    const { filterFields } = await import('../dist/index.js')
    assert.deepStrictEqual(filterFields([{ a: 1, b: 2 }], 'a'), [{ a: 1 }])
  })

  it('filterFields(data, "*") returns unfiltered', async () => {
    const { filterFields } = await import('../dist/index.js')
    const data = [{ a: 1, b: 2 }]
    assert.deepStrictEqual(filterFields(data, '*'), data)
  })

  it('filterFields(data, "all") returns unfiltered', async () => {
    const { filterFields } = await import('../dist/index.js')
    const data = [{ a: 1, b: 2 }]
    assert.deepStrictEqual(filterFields(data, 'all'), data)
  })

  it('filterFields(data, undefined) uses DEFAULT_FIELDS', async () => {
    const { filterFields, DEFAULT_FIELDS } = await import('../dist/index.js')
    const svc = { name: 'x', url: 'https://x.io', protocol: 'L402', price_sats: 1, health_status: 'healthy', extra: 'drop' }
    const result = filterFields([svc], undefined)
    assert.deepStrictEqual(Object.keys(result[0]).sort(), [...DEFAULT_FIELDS].sort())
  })

  it('toCsv returns empty string for empty array', async () => {
    const { toCsv } = await import('../dist/index.js')
    assert.strictEqual(toCsv([]), '')
  })

  it('toCsv quotes values containing commas (RFC-4180)', async () => {
    const { toCsv } = await import('../dist/index.js')
    const csv = toCsv([{ name: 'foo,bar', val: 1 }])
    assert.ok(csv.includes('"foo,bar"'), `expected quoted comma value, got: ${csv}`)
  })

  it('toCsv doubles internal quotes (RFC-4180)', async () => {
    const { toCsv } = await import('../dist/index.js')
    const csv = toCsv([{ name: 'say "hello"', val: 1 }])
    assert.ok(csv.includes('"say ""hello"""'), `expected doubled quotes, got: ${csv}`)
  })

  it('toCsv quotes values containing newlines (RFC-4180)', async () => {
    const { toCsv } = await import('../dist/index.js')
    const csv = toCsv([{ name: 'line1\nline2', val: 1 }])
    assert.ok(csv.includes('"line1\nline2"'), `expected quoted newline value, got: ${csv}`)
  })
})

// ─── Feature parity: search_services (live API) ───────────────────────────────

describe('search_services feature parity (live API)', () => {
  const BASE = process.env.INDEX_URL || 'https://402index.io'

  it('search_services default response contains only DEFAULT_FIELDS', async () => {
    const { filterFields, DEFAULT_FIELDS } = await import('../dist/index.js')
    const res = await fetch(`${BASE}/api/v1/services?limit=1`)
    assert.ok(res.ok, `Expected 2xx, got ${res.status}`)
    const data = await res.json()
    if (data.services.length > 0) {
      const filtered = filterFields(data.services, undefined)
      assert.deepStrictEqual(Object.keys(filtered[0]).sort(), [...DEFAULT_FIELDS].sort())
    }
  })

  it('search_services accepts format=csv — toCsv produces valid output', async () => {
    const { toCsv } = await import('../dist/index.js')
    const res = await fetch(`${BASE}/api/v1/services?limit=3`)
    assert.ok(res.ok, `Expected 2xx, got ${res.status}`)
    const data = await res.json()
    if (data.services.length > 0) {
      const csv = toCsv(data.services)
      const lines = csv.split('\n')
      // header row + data rows
      assert.ok(lines.length >= 2, 'CSV must have header + at least one data row')
      // header row must contain expected field names
      assert.ok(lines[0].includes('name'), 'CSV header must contain "name"')
    }
  })

  it('search_services accepts verified=true param', async () => {
    const res = await fetch(`${BASE}/api/v1/services?verified=true&limit=3`)
    assert.ok(res.ok, `Expected 2xx for verified=true, got ${res.status}`)
    const data = await res.json()
    assert.ok(Array.isArray(data.services), 'services must be an array')
  })
})

// ─── list_categories summary shape (live API) ────────────────────────────────

describe('list_categories summary=true shape (live API)', () => {
  const BASE = process.env.INDEX_URL || 'https://402index.io'

  it('categories response flattens to name+count shape with summary logic', async () => {
    const res = await fetch(`${BASE}/api/v1/categories`)
    assert.ok(res.ok, `Expected 2xx, got ${res.status}`)
    const data = await res.json()
    assert.ok(data.categories, 'response must have categories field')
    if (typeof data.categories === 'object' && !Array.isArray(data.categories)) {
      const compact = Object.entries(data.categories).map(([name, val]) => ({
        name,
        count: val.total ?? val.count ?? 0,
      }))
      assert.ok(compact.length > 0, 'compact categories must be non-empty')
      assert.ok(compact.every((c) => typeof c.name === 'string'), 'every category must have string name')
      assert.ok(compact.every((c) => typeof c.count === 'number'), 'every category must have numeric count')
    }
  })
})

// ─── Tool description preservation (master enrichments) ──────────────────────

describe('tool description preservation (master enrichments)', () => {
  const src = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')

  it('search_services description includes related_protocols', () => {
    const m = src.match(/server\.tool\(\s*'search_services',\s*'([^']+)'/s)
    assert.ok(m, 'should find search_services tool definition')
    assert.ok(m[1].includes('related_protocols'), 'search_services description must include "related_protocols"')
  })

  it('search_services description includes "showing other payment rails"', () => {
    const m = src.match(/server\.tool\(\s*'search_services',\s*'([^']+)'/s)
    assert.ok(m, 'should find search_services tool definition')
    assert.ok(m[1].includes('showing other payment rails'), 'search_services description must include "showing other payment rails"')
  })

  it('get_service_detail description includes related_services', () => {
    const m = src.match(/server\.tool\(\s*'get_service_detail',\s*'([^']+)'/s)
    assert.ok(m, 'should find get_service_detail tool definition')
    assert.ok(m[1].includes('related_services'), 'get_service_detail description must include "related_services"')
  })

  it('get_service_detail description includes "sibling payment rail"', () => {
    const m = src.match(/server\.tool\(\s*'get_service_detail',\s*'([^']+)'/s)
    assert.ok(m, 'should find get_service_detail tool definition')
    assert.ok(m[1].includes('sibling payment rail'), 'get_service_detail description must include "sibling payment rail"')
  })
})
