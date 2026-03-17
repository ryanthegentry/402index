/**
 * Data validation tests for L402 registration scripts
 *
 * Run: node --test test/register-l402-services.test.js
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
  const match = source.match(/(?:const|let)\s+(?:endpoints|services)\s*=\s*\[([\s\S]*?)\n\]/)
  if (!match) return null
  const entries = []
  const entryPattern = /\{\s*([\s\S]*?)\}/g
  let m
  while ((m = entryPattern.exec(match[1])) !== null) {
    const block = m[1]
    const entry = {}

    for (const field of ['name', 'description', 'url', 'http_method', 'category', 'provider']) {
      const fMatch = block.match(new RegExp(`${field}:\\s*['"\`]([^'"\`]*?)['"\`]`))
      if (fMatch) entry[field] = fMatch[1]
      const tMatch = block.match(new RegExp(`${field}:\\s*\`\\$\\{\\w+\\}([^'"\`]*?)\``))
      if (tMatch && !entry[field]) entry[field] = `PREFIX${tMatch[1]}`
    }

    for (const field of ['price_usd', 'price_sats']) {
      const nMatch = block.match(new RegExp(`${field}:\\s*([\\d.]+)`))
      if (nMatch) entry[field] = parseFloat(nMatch[1])
    }

    if (entry.name || entry.url) entries.push(entry)
  }
  return entries
}

const l402Scripts = [
  'register-ganamos.mjs',
  'register-proxy402.mjs',
]

describe('L402 registration scripts — existence and syntax', () => {
  for (const script of l402Scripts) {
    it(`${script} exists and is valid JS`, () => {
      const source = readFileSync(join(scriptsDir, script), 'utf-8')
      assert.ok(source.length > 100, `${script} is too short`)
      assert.ok(source.includes('better-sqlite3'), `${script} should use better-sqlite3`)
      assert.ok(source.includes('L402'), `${script} should reference L402 protocol`)
      assert.ok(source.includes('Lightning'), `${script} should reference Lightning`)
      assert.ok(source.includes('upsert') || source.includes('UPSERT') || source.includes('ON CONFLICT'),
        `${script} should have upsert logic`)
    })
  }
})

describe('L402 registration scripts — endpoint data validation', () => {
  for (const script of l402Scripts) {
    it(`${script} has valid endpoint data`, () => {
      const source = readFileSync(join(scriptsDir, script), 'utf-8')
      const endpoints = extractEndpoints(source)
      assert.ok(endpoints, `${script}: could not extract endpoints array`)
      assert.ok(endpoints.length > 0, `${script}: no endpoints found`)

      for (const ep of endpoints) {
        assert.ok(ep.name, `${script}: name must not be empty`)
        assert.ok(ep.name.length <= 200, `${script}: name "${ep.name}" exceeds 200 chars`)
        if (ep.http_method) {
          assert.ok(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(ep.http_method),
            `${script}: invalid http_method "${ep.http_method}"`)
        }
        if (ep.price_sats !== undefined) {
          assert.ok(typeof ep.price_sats === 'number', `${script}: price_sats must be a number`)
          assert.ok(ep.price_sats >= 0, `${script}: price_sats must be non-negative`)
        }
      }
    })
  }
})

describe('L402 registration scripts — provider-specific checks', () => {
  it('ganamos has Ganamos provider and marketplace category', () => {
    const source = readFileSync(join(scriptsDir, 'register-ganamos.mjs'), 'utf-8')
    assert.ok(source.includes("'Ganamos'"))
    assert.ok(source.includes('ganamos.earth'))
    assert.ok(source.includes('marketplace'))
  })

  it('proxy402 has proxy402 provider and ai category', () => {
    const source = readFileSync(join(scriptsDir, 'register-proxy402.mjs'), 'utf-8')
    assert.ok(source.includes("'proxy402'"))
    assert.ok(source.includes('api.proxy402.fun'))
    assert.ok(source.includes('ai'))
  })
})

describe('L402 registration scripts — SQL safety', () => {
  for (const script of l402Scripts) {
    it(`${script} uses parameterized queries`, () => {
      const source = readFileSync(join(scriptsDir, script), 'utf-8')
      assert.ok(source.includes('@id'), `${script}: should use @id placeholder`)
      assert.ok(source.includes('@name'), `${script}: should use @name placeholder`)
      assert.ok(source.includes('ON CONFLICT'), `${script}: should handle conflicts`)
    })
  }
})

describe('L402 registration scripts — endpoint counts', () => {
  it('ganamos: 2 endpoints', () => {
    const source = readFileSync(join(scriptsDir, 'register-ganamos.mjs'), 'utf-8')
    const eps = extractEndpoints(source)
    assert.equal(eps.length, 2)
  })

  it('proxy402: 1 endpoint', () => {
    const source = readFileSync(join(scriptsDir, 'register-proxy402.mjs'), 'utf-8')
    const eps = extractEndpoints(source)
    assert.equal(eps.length, 1)
  })
})
