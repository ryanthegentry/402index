import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')

// Vars that are runtime-only, framework-injected, or test-only — not expected in .env.example
const ALLOWLIST = new Set([
  'NODE_ENV',
  'CI',
  'PORT',
  'npm_package_version',
  'RUN_TIMING_TESTS',
  'PRIVATE_NETWORK_SUFFIXES',
  'DISABLE_SQLITE_VEC',       // test-only: force-skip sqlite-vec loading
  'FORCE_SQLITE_VEC_FAIL',    // test-only: simulate sqlite-vec load failure
])

const ENV_REF_PATTERN = /process\.env\.([A-Z_][A-Z0-9_]*)/g

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

describe('env-example-drift', () => {
  it('every process.env.VAR in src/ appears in .env.example or allowlist', () => {
    // Collect all env var references from src/**/*.js
    const srcFiles = walkDir('src', '.js')
    const referencedVars = new Set()
    for (const rel of srcFiles) {
      const content = readFileSync(join(ROOT, rel), 'utf8')
      let m
      const pat = new RegExp(ENV_REF_PATTERN.source, 'g')
      while ((m = pat.exec(content)) !== null) {
        referencedVars.add(m[1])
      }
    }

    // Parse .env.example for declared var names
    const envExample = readFileSync(join(ROOT, '.env.example'), 'utf8')
    const declaredVars = new Set()
    for (const line of envExample.split('\n')) {
      // Match both `VAR=value` and `# VAR=value` (commented-out vars)
      const m = line.match(/^#?\s*([A-Z_][A-Z0-9_]*)=/)
      if (m) declaredVars.add(m[1])
    }

    const missing = []
    for (const v of referencedVars) {
      if (!declaredVars.has(v) && !ALLOWLIST.has(v)) {
        missing.push(v)
      }
    }

    missing.sort()
    assert.equal(
      missing.length,
      0,
      `${missing.length} env var(s) referenced in src/ but missing from .env.example:\n${missing.join('\n')}`
    )
  })
})
