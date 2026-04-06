import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execSync } from 'node:child_process'

const SCRIPT_PATH = path.resolve('scripts/cc-dispatch.sh')

// Helper: write a bash script to a temp file and execute it
function runBash(script, { timeout = 10000 } = {}) {
  const tmpfile = path.join(os.tmpdir(), `dispatch-dedup-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`)
  fs.writeFileSync(tmpfile, script)
  try {
    return execSync(`bash "${tmpfile}"`, { encoding: 'utf-8', timeout }).trim()
  } catch (e) {
    // Return combined output so tests can inspect it
    const out = [e.stdout, e.stderr].filter(Boolean).join('\n').trim()
    if (out) return out
    throw e
  } finally {
    fs.unlinkSync(tmpfile)
  }
}

describe('dispatch dedup and subshell trap (#82)', () => {
  // ── Structural test: entry point guard ─────────────────────────

  describe('entry point guard', () => {
    it('script can be sourced without running ensure_deps/ensure_labels/run_once', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      // The entry point section must be guarded with BASH_SOURCE check
      // so that sourcing the script for tests doesn't trigger side effects
      const entrySection = content.slice(content.indexOf('# ── Entry point'))
      assert.ok(
        entrySection.includes('BASH_SOURCE'),
        'Entry point must be guarded with BASH_SOURCE check for testability'
      )
    })
  })

  // ── Structural test: dispatched_this_cycle dedup ───────────────

  describe('intra-cycle dedup', () => {
    it('run_once initializes dispatched_this_cycle', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('run_once()')
      const fnEnd = content.indexOf('\n}', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)
      assert.ok(
        fnBody.includes('dispatched_this_cycle'),
        'run_once must initialize dispatched_this_cycle for intra-cycle dedup'
      )
    })

    it('dispatch_issue checks dispatched_this_cycle before proceeding', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_issue()')
      const fnEnd = content.indexOf('\n}', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)
      assert.ok(
        fnBody.includes('dispatched_this_cycle'),
        'dispatch_issue must check dispatched_this_cycle to prevent double-dispatch'
      )
    })

    it('same issue under two labels is dispatched only once per cycle', () => {
      // Functional test: mock gh to return issue #42 under two different labels,
      // run real dispatch_issue in DRY_RUN mode, count "Dispatching" log lines
      const output = runBash(`
#!/usr/bin/env bash
set -euo pipefail

# Source the script functions (entry point guarded by BASH_SOURCE)
source "${SCRIPT_PATH}"

# Override globals
REPO="test/repo"
REPO_DIR="/tmp"
LOG_DIR="/tmp"
DEFAULT_BRANCH="master"
DRY_RUN=true
WATCH=false
DISPATCH_LABELS=(ready-for-impl ready-for-security)

# Mock gh: return issue #42 for both labels
gh() {
  case "\$1" in
    issue)
      case "\$2" in
        list)
          echo -e "42\\tTest issue"
          ;;
        view)
          # Return empty labels (no in-progress) so the real check passes
          echo '""'
          ;;
      esac
      ;;
  esac
}
export -f gh

run_once 2>&1
`)
      // Count "Dispatching #42" lines — should be exactly 1 (dedup prevents the second)
      const dispatchLines = (output.match(/Dispatching #42/g) || []).length
      const skipLines = (output.match(/Skipping #42.*already dispatched this cycle/g) || []).length
      assert.equal(dispatchLines, 1, `Issue #42 should be dispatched exactly once, but was dispatched ${dispatchLines} time(s). Output:\n${output}`)
      assert.equal(skipLines, 1, `Issue #42 should be skipped once (dedup), but was skipped ${skipLines} time(s). Output:\n${output}`)
    })
  })

  // ── Structural test: subshell EXIT trap ────────────────────────

  describe('subshell EXIT trap', () => {
    it('background subshell has EXIT trap that removes in-progress', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      // Extract the background subshell: from "# Spawn handler" to ") &"
      const spawnStart = content.indexOf('# Spawn handler in background subshell')
      assert.ok(spawnStart !== -1, 'Must have background subshell section')
      const subshellEnd = content.indexOf(') &', spawnStart)
      const subshellBody = content.slice(spawnStart, subshellEnd)

      assert.ok(
        subshellBody.includes("trap '") || subshellBody.includes('trap "'),
        'Background subshell must have a trap'
      )
      assert.ok(
        subshellBody.includes('EXIT'),
        'Trap must fire on EXIT (catches all exit paths)'
      )
      assert.ok(
        subshellBody.includes('--remove-label') && subshellBody.includes('in-progress'),
        'EXIT trap must remove in-progress label'
      )
    })

    it('EXIT trap covers all modes (not just implement/revise)', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      // Extract the background subshell
      const spawnStart = content.indexOf('# Spawn handler in background subshell')
      const subshellEnd = content.indexOf(') &', spawnStart)
      const subshellBody = content.slice(spawnStart, subshellEnd)

      // The EXIT trap with in-progress removal must be BEFORE the mode check
      const modeCheck = subshellBody.indexOf('if [[ "$mode" == "implement"')
      const trapPos = subshellBody.indexOf('remove-label')

      assert.ok(trapPos !== -1, 'Must have remove-label in subshell')
      assert.ok(modeCheck !== -1, 'Must have mode check in subshell')
      assert.ok(
        trapPos < modeCheck,
        'EXIT trap (with remove-label) must come before mode-specific logic so it covers ALL modes'
      )
    })

    it('old worktree-only trap is removed (replaced by unified EXIT trap)', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      // Extract the background subshell: from "# Spawn handler" to ") &"
      const spawnStart = content.indexOf('# Spawn handler in background subshell')
      const subshellEnd = content.indexOf(') &', spawnStart)
      const subshellBody = content.slice(spawnStart, subshellEnd)

      // Count traps — should be exactly one unified trap
      const trapMatches = subshellBody.match(/\btrap\s+'/g) || []

      assert.ok(
        trapMatches.length === 1,
        `Expected exactly 1 trap in subshell (unified EXIT), found ${trapMatches.length}`
      )
    })
  })
})
