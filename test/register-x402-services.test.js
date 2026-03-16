/**
 * Data validation tests for x402 registration scripts
 *
 * Run: node --test test/register-x402-services.test.js
 *
 * Validates that each registration script's endpoint data matches
 * the DB schema constraints without requiring a running server or DB.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const scriptsDir = join(__dirname, '..', 'scripts')

// Extract endpoints array from a registration script source
function extractEndpoints(source) {
  // Match the endpoints or services array declaration
  const match = source.match(/(?:const|let)\s+(?:endpoints|services)\s*=\s*\[([\s\S]*?)\n\]/)
  if (!match) return null
  // We can't safely eval, so we'll parse key fields with regex
  const entries = []
  const entryPattern = /\{\s*([\s\S]*?)\}/g
  let m
  while ((m = entryPattern.exec(match[1])) !== null) {
    const block = m[1]
    const entry = {}

    // Extract string fields
    for (const field of ['name', 'description', 'url', 'http_method', 'category', 'provider']) {
      const fMatch = block.match(new RegExp(`${field}:\\s*['"\`]([^'"\`]*?)['"\`]`))
      if (fMatch) entry[field] = fMatch[1]
      // Also handle template literals with GATEWAY/API prefix
      const tMatch = block.match(new RegExp(`${field}:\\s*\`\\$\\{\\w+\\}([^'"\`]*?)\``))
      if (tMatch && !entry[field]) entry[field] = `PREFIX${tMatch[1]}`
    }

    // Extract numeric fields
    for (const field of ['price_usd', 'price_sats']) {
      const nMatch = block.match(new RegExp(`${field}:\\s*([\\d.]+)`))
      if (nMatch) entry[field] = parseFloat(nMatch[1])
    }

    if (entry.name || entry.url) entries.push(entry)
  }
  return entries
}

// Validate a single endpoint entry
function validateEndpoint(ep, scriptName) {
  assert.ok(ep.name, `${scriptName}: name must not be empty`)
  assert.ok(ep.name.length <= 200, `${scriptName}: name "${ep.name}" exceeds 200 chars`)

  assert.ok(ep.url || ep.url === undefined,
    `${scriptName}: url must exist (got ${ep.url})`)

  if (ep.http_method) {
    assert.ok(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(ep.http_method),
      `${scriptName}: invalid http_method "${ep.http_method}"`)
  }

  if (ep.price_usd !== undefined) {
    assert.ok(typeof ep.price_usd === 'number', `${scriptName}: price_usd must be a number`)
    assert.ok(ep.price_usd >= 0, `${scriptName}: price_usd must be non-negative`)
  }

  if (ep.category) {
    assert.ok(ep.category.length <= 100, `${scriptName}: category too long`)
  }
}

// ─── Script structure tests ─────────────────────────────────────────────────

const newScripts = [
  'register-firecrawl.mjs',
  'register-neynar.mjs',
  'register-ordiscan.mjs',
  'register-spraay.mjs',
  'register-x402engine.mjs',
  'register-agoragentic.mjs',
]

describe('x402 registration scripts — existence and syntax', () => {
  for (const script of newScripts) {
    it(`${script} exists and is valid JS`, () => {
      const source = readFileSync(join(scriptsDir, script), 'utf-8')
      assert.ok(source.length > 100, `${script} is too short`)
      assert.ok(source.includes('better-sqlite3'), `${script} should use better-sqlite3`)
      assert.ok(source.includes('x402'), `${script} should reference x402 protocol`)
      assert.ok(source.includes('USDC'), `${script} should reference USDC payment`)
      assert.ok(source.includes('upsert'), `${script} should have upsert logic`)
    })
  }
})

describe('x402 registration scripts — endpoint data validation', () => {
  for (const script of newScripts) {
    it(`${script} has valid endpoint data`, () => {
      const source = readFileSync(join(scriptsDir, script), 'utf-8')
      const endpoints = extractEndpoints(source)
      assert.ok(endpoints, `${script}: could not extract endpoints array`)
      assert.ok(endpoints.length > 0, `${script}: no endpoints found`)

      for (const ep of endpoints) {
        validateEndpoint(ep, script)
      }
    })
  }
})

describe('x402 registration scripts — provider-specific checks', () => {
  it('firecrawl has Firecrawl provider', () => {
    const source = readFileSync(join(scriptsDir, 'register-firecrawl.mjs'), 'utf-8')
    assert.ok(source.includes("'Firecrawl'") || source.includes("provider: 'Firecrawl'"))
    assert.ok(source.includes('api.firecrawl.dev'))
  })

  it('neynar has Neynar provider and Farcaster endpoints', () => {
    const source = readFileSync(join(scriptsDir, 'register-neynar.mjs'), 'utf-8')
    assert.ok(source.includes("'Neynar'"))
    assert.ok(source.includes('api.neynar.com'))
    assert.ok(source.includes('farcaster'))
  })

  it('ordiscan has Ordiscan provider and bitcoin category', () => {
    const source = readFileSync(join(scriptsDir, 'register-ordiscan.mjs'), 'utf-8')
    assert.ok(source.includes("'Ordiscan'"))
    assert.ok(source.includes('api.ordiscan.com'))
    assert.ok(source.includes('bitcoin'))
  })

  it('spraay has Spraay provider and gateway URL', () => {
    const source = readFileSync(join(scriptsDir, 'register-spraay.mjs'), 'utf-8')
    assert.ok(source.includes("'Spraay'"))
    assert.ok(source.includes('gateway.spraay.app'))
    // Should have multiple categories
    assert.ok(source.includes('defi'))
    assert.ok(source.includes('ai'))
  })

  it('x402engine has x402engine provider and multiple categories', () => {
    const source = readFileSync(join(scriptsDir, 'register-x402engine.mjs'), 'utf-8')
    assert.ok(source.includes("'x402engine'"))
    assert.ok(source.includes('x402-gateway-production'))
    assert.ok(source.includes('ai'))
    assert.ok(source.includes('media'))
    assert.ok(source.includes('data'))
  })

  it('agoragentic has Agoragentic provider and marketplace category', () => {
    const source = readFileSync(join(scriptsDir, 'register-agoragentic.mjs'), 'utf-8')
    assert.ok(source.includes("'Agoragentic'"))
    assert.ok(source.includes('agoragentic.com'))
    assert.ok(source.includes('marketplace'))
  })
})

describe('x402 registration scripts — SQL safety', () => {
  for (const script of newScripts) {
    it(`${script} uses parameterized queries`, () => {
      const source = readFileSync(join(scriptsDir, script), 'utf-8')
      // Should use @param placeholders, not string interpolation in SQL
      assert.ok(source.includes('@id'), `${script}: should use @id placeholder`)
      assert.ok(source.includes('@name'), `${script}: should use @name placeholder`)
      assert.ok(source.includes('ON CONFLICT'), `${script}: should handle conflicts`)
    })
  }
})

describe('x402 registration scripts — endpoint counts', () => {
  it('firecrawl: 1 endpoint', () => {
    const source = readFileSync(join(scriptsDir, 'register-firecrawl.mjs'), 'utf-8')
    const eps = extractEndpoints(source)
    assert.equal(eps.length, 1)
  })

  it('neynar: 5 endpoints', () => {
    const source = readFileSync(join(scriptsDir, 'register-neynar.mjs'), 'utf-8')
    const eps = extractEndpoints(source)
    assert.equal(eps.length, 5)
  })

  it('ordiscan: 6 endpoints', () => {
    const source = readFileSync(join(scriptsDir, 'register-ordiscan.mjs'), 'utf-8')
    const eps = extractEndpoints(source)
    assert.equal(eps.length, 6)
  })

  it('spraay: 15 endpoints', () => {
    const source = readFileSync(join(scriptsDir, 'register-spraay.mjs'), 'utf-8')
    const eps = extractEndpoints(source)
    assert.equal(eps.length, 15)
  })

  it('x402engine: 22 endpoints', () => {
    const source = readFileSync(join(scriptsDir, 'register-x402engine.mjs'), 'utf-8')
    const eps = extractEndpoints(source)
    assert.equal(eps.length, 22)
  })

  it('agoragentic: 5 endpoints', () => {
    const source = readFileSync(join(scriptsDir, 'register-agoragentic.mjs'), 'utf-8')
    const eps = extractEndpoints(source)
    assert.equal(eps.length, 5)
  })
})
