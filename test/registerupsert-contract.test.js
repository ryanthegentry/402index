import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Pins parity of params keys across the three registerUpsert().get(...)
// call sites and the @-params in the SQL template. If a future change
// adds a required @-param to service-registration.js without updating
// every call site (or vice-versa), better-sqlite3 throws at runtime —
// no static check catches it today. This test does.
//
// BRITTLENESS NOTE: this scans source text, not an AST. Each call site
// is described by (1) the file it lives in and (2) a unique opener
// substring for the params object literal preceding the .get(...) call.
// If the params object is restructured (e.g., spread from another
// object, or built field-by-field), the scan will surface the structural
// change as a test failure — at which point you update this file's
// `callsites` table (or replace the scan with an acorn AST walk).

const ROOT = join(import.meta.dirname, '..')

const callsites = [
  {
    file: 'src/routes/api/register.js',
    opener: 'const params = {',
  },
  {
    file: 'src/routes/api/register.js',
    opener: 'const bonusParams = {',
  },
  {
    file: 'src/routes/api/admin.js',
    opener: 'const bonusParams = {',
  },
]

// Matches both `key: value` and shorthand `key,` (no value expression).
// Shorthand lines look like `url,` or `protocol,` — common in JS object
// literals when the key name matches a local variable. Requires the key
// to be followed by `:` (explicit) or `,`/end-of-line (shorthand).
const TOP_LEVEL_KEY = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(?::|,\s*$|$)/

function extractKeysFromObjectLiteral(src, opener) {
  const start = src.indexOf(opener)
  assert.ok(start !== -1, `opener not found: ${opener}`)
  const openBrace = src.indexOf('{', start)
  assert.ok(openBrace !== -1, `no '{' after opener: ${opener}`)

  // State machine: track string mode so '{' and '}' inside string literals
  // (especially template-literal `${...}` interpolations) don't perturb
  // the brace-depth counter. We only count braces that are part of the
  // syntactic object structure.
  const keys = new Set()
  let depth = 0
  let lineStart = openBrace
  let inString = null // null | "'" | '"' | '`'
  let templateExprDepth = 0 // depth of `${...}` inside a backtick string

  for (let i = openBrace; i < src.length; i++) {
    const ch = src[i]
    const prev = src[i - 1]

    // Track string entry/exit (ignore escaped quotes via backslash check)
    if (!inString) {
      if (ch === "'" || ch === '"' || ch === '`') {
        inString = ch
      }
    } else if (inString === '`' && ch === '$' && src[i + 1] === '{') {
      // Enter template interpolation: braces inside this DO count toward
      // syntactic structure but should NOT affect our object-depth count.
      templateExprDepth++
      i++ // skip the '{'
      continue
    } else if (inString === '`' && templateExprDepth > 0 && ch === '}') {
      templateExprDepth--
      continue
    } else if (inString === '`' && templateExprDepth > 0 && ch === '{') {
      // Nested brace inside a template expression — treat as opaque
      templateExprDepth++
      continue
    } else if (ch === inString && prev !== '\\') {
      // Closing the current string
      inString = null
    }

    if (inString) {
      // Inside a string literal — never count braces or capture keys
      if (ch === '\n') {
        lineStart = i + 1
      }
      continue
    }

    if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) {
        const line = src.slice(lineStart, i)
        const m = line.match(TOP_LEVEL_KEY)
        if (m) keys.add(m[1])
        return keys
      }
    } else if (ch === '\n') {
      const line = src.slice(lineStart, i)
      lineStart = i + 1
      if (depth === 1) {
        const m = line.match(TOP_LEVEL_KEY)
        if (m) keys.add(m[1])
      }
    }
  }
  throw new Error(`unterminated object literal starting at: ${opener}`)
}

function symmetricDifference(a, b) {
  const diff = new Set()
  for (const x of a) if (!b.has(x)) diff.add(x)
  for (const x of b) if (!a.has(x)) diff.add(x)
  return diff
}

describe('registerUpsert callsite params parity', () => {
  it('all 3 callsites pass identical key sets', () => {
    const keySets = callsites.map(cs => {
      const src = readFileSync(join(ROOT, cs.file), 'utf8')
      return extractKeysFromObjectLiteral(src, cs.opener)
    })

    // Sanity: each callsite should yield a non-trivial key set
    keySets.forEach((ks, idx) => {
      assert.ok(ks.size >= 10,
        `callsite ${idx + 1} (${callsites[idx].file} ${callsites[idx].opener}) ` +
        `only extracted ${ks.size} keys — opener may be too narrow`)
    })

    const reference = keySets[0]
    for (let i = 1; i < keySets.length; i++) {
      const diff = symmetricDifference(reference, keySets[i])
      assert.equal(
        diff.size,
        0,
        `callsite #${i + 1} (${callsites[i].file} ${callsites[i].opener}) ` +
        `diverges from #1 (${callsites[0].file} ${callsites[0].opener}): ` +
        `keys not in both: [${[...diff].sort().join(', ')}]`,
      )
    }
  })

  it('callsite keys match the @-params in service-registration.js SQL template', () => {
    const callSrc = readFileSync(join(ROOT, callsites[0].file), 'utf8')
    const callsiteKeys = extractKeysFromObjectLiteral(callSrc, callsites[0].opener)

    const sqlSrc = readFileSync(join(ROOT, 'src/services/service-registration.js'), 'utf8')
    const atParams = new Set([...sqlSrc.matchAll(/@(\w+)/g)].map(m => m[1]))

    const diff = symmetricDifference(callsiteKeys, atParams)
    assert.equal(
      diff.size,
      0,
      `callsite key set ↔ SQL @-params divergence: [${[...diff].sort().join(', ')}]`,
    )
  })
})
