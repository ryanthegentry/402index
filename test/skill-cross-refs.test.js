import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const skillPath = join(ROOT, 'SKILL.md')

describe('skill-cross-refs', () => {
  it('all internal cross-references match a known heading', () => {
    const content = readFileSync(skillPath, 'utf8')
    const lines = content.split('\n')

    // Extract headings (lines matching ^#{1,6}\s+(.+)$)
    const headings = new Set()
    for (const line of lines) {
      const m = line.match(/^#{1,6}\s+(.+)$/)
      if (m) headings.add(m[1].trim().toLowerCase())
    }

    // Extract internal cross-references — phrases that name a specific section.
    // We look for "the <Name> section", "skip to <Name>", "from the <Name> section above"
    // and known multi-word heading references like "Quick Start" used in prose.
    const refPatterns = [
      /(?:skip to|use|from) the ([A-Z][A-Za-z ]+?) section/g,
      /skip to ([A-Z][A-Za-z ]+?)(?:\s+or\b|[.,]|\s*$)/g,
    ]

    // Also detect any "Tested Quick Start" — this was a known dangling reference
    const TESTED_QS = 'Tested Quick Start'

    const violations = []
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      for (const pat of refPatterns) {
        pat.lastIndex = 0
        let m
        while ((m = pat.exec(line)) !== null) {
          const ref = m[1].trim()
          if (!headings.has(ref.toLowerCase())) {
            violations.push(`SKILL.md:${i + 1}: reference "${ref}" does not match any heading`)
          }
        }
      }
      if (line.includes(TESTED_QS)) {
        violations.push(`SKILL.md:${i + 1}: contains "${TESTED_QS}" which is not a valid heading`)
      }
    }

    assert.equal(
      violations.length,
      0,
      `Found ${violations.length} dangling cross-reference(s):\n${violations.join('\n')}`
    )
  })
})
