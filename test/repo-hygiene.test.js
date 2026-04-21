import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import path from 'node:path'

describe('repo hygiene', () => {
  it('FTS5 test files must not be re-added (retired per issue #135)', () => {
    const testDir = path.dirname(new URL(import.meta.url).pathname)
    const found = readdirSync(testDir).filter(f => f.toLowerCase().startsWith('fts5'))
    assert.equal(found.length, 0, `FTS5 was retired. Found: ${found.join(', ')}`)
  })
})
