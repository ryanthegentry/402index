import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const SCRIPT_PATH = path.resolve('scripts/cc-dispatch.sh')

describe('test harness bash version (#214)', () => {

  // Test A — harness resolves bash 4+
  it('runBash helper resolves bash 4+ and exports from shared module', async () => {
    const { runBash } = await import('./helpers/run-bash.js')
    const output = runBash('echo ${BASH_VERSINFO[0]}')
    const majorVersion = parseInt(output, 10)
    assert.ok(Number.isInteger(majorVersion), `expected integer, got: ${output}`)
    assert.ok(majorVersion >= 4, `expected bash 4+, got ${majorVersion}`)
  })

  // Test B — cc-dispatch.sh contains version gate inside main-invocation block
  it('cc-dispatch.sh has BASH_VERSINFO version gate inside main-invocation block', () => {
    const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
    const lines = content.split('\n')

    // Find the main-invocation guard
    const guardIdx = lines.findIndex(l => l.includes('if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then'))
    assert.ok(guardIdx >= 0, 'main-invocation guard not found')

    // Extract body until matching fi (track nesting)
    let depth = 1
    const bodyLines = []
    for (let i = guardIdx + 1; i < lines.length && depth > 0; i++) {
      const trimmed = lines[i].trim()
      if (/^if\s/.test(trimmed) || /;\s*then\s*$/.test(trimmed)) depth++
      if (trimmed === 'fi') depth--
      if (depth > 0) bodyLines.push(lines[i])
    }
    const body = bodyLines.join('\n')

    assert.ok(body.includes('BASH_VERSINFO[0]'),
      'main-invocation block must contain BASH_VERSINFO version check')
    assert.ok(body.includes('exit 1'),
      'main-invocation block must exit 1 on version failure')
  })

  // Test C — both test files import runBash from shared helper, no local definition
  it('dispatch test files import runBash from shared helper (no local copy)', () => {
    const bookkeeping = fs.readFileSync(path.resolve('test/dispatch-bookkeeping.test.js'), 'utf-8')
    const timeout = fs.readFileSync(path.resolve('test/dispatch-timeout.test.js'), 'utf-8')

    // Must import from helpers
    assert.match(bookkeeping, /from\s+['"]\.\/helpers\/run-bash\.js['"]/,
      'dispatch-bookkeeping.test.js must import from ./helpers/run-bash.js')
    assert.match(timeout, /from\s+['"]\.\/helpers\/run-bash\.js['"]/,
      'dispatch-timeout.test.js must import from ./helpers/run-bash.js')

    // Must NOT have local function runBash definition
    assert.doesNotMatch(bookkeeping, /^function runBash/m,
      'dispatch-bookkeeping.test.js must not define local runBash')
    assert.doesNotMatch(timeout, /^function runBash/m,
      'dispatch-timeout.test.js must not define local runBash')
  })
})
