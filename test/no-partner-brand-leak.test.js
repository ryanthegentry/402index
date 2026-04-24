import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')

const EXCLUDED = new Set([
  'src/services/partner-gateway-aliases.js',
  'test/partner-gateway-deprecation.test.js',
])

// Build deny pattern without the literal brand string (so this file doesn't match itself)
const BRAND = ['g', 'o', 'l', 'e', 'm'].join('')
const DENY_PATTERN = new RegExp(`\\b${BRAND}\\b`, 'i')

function walkDir(dir, ext) {
  const results = []
  let entries
  try { entries = readdirSync(join(ROOT, dir), { withFileTypes: true }) } catch { return results }
  for (const entry of entries) {
    const rel = join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...walkDir(rel, ext))
    } else if (entry.name.endsWith(ext)) {
      results.push(rel)
    }
  }
  return results
}

const filesToScan = [
  ...walkDir('src', '.js'),
  ...walkDir('test', '.js'),
  '.env.example',
  'SKILL.md',
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
].filter(f => !EXCLUDED.has(f) && existsSync(join(ROOT, f)))

describe('no-partner-brand-leak', () => {
  it(`no source or test file contains "${BRAND}" (case-insensitive)`, () => {
    const violations = []
    for (const rel of filesToScan) {
      const content = readFileSync(join(ROOT, rel), 'utf8')
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (DENY_PATTERN.test(lines[i])) {
          violations.push(`${rel}:${i + 1}: ${lines[i].trim()}`)
        }
      }
    }
    assert.equal(
      violations.length,
      0,
      `Found "${BRAND}" brand leak in ${violations.length} location(s):\n${violations.join('\n')}`
    )
  })
})
