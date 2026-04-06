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
    it('run_once declares dispatched_this_cycle associative array', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('run_once()')
      const fnEnd = content.indexOf('\n}', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)
      assert.ok(
        fnBody.includes('dispatched_this_cycle'),
        'run_once must declare dispatched_this_cycle for intra-cycle dedup'
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
      // then count how many times dispatch_issue is invoked
      const output = runBash(`
#!/usr/bin/env bash
set -euo pipefail

# Source the script functions
source "${SCRIPT_PATH}"

# Override globals
REPO="test/repo"
REPO_DIR="/tmp"
LOG_DIR="/tmp"
DEFAULT_BRANCH="master"
DRY_RUN=true
WATCH=false
DISPATCH_LABELS=(ready-for-impl ready-for-security)

# Counter for dispatch_issue calls
DISPATCH_COUNT=0

# Mock gh: return issue #42 for both labels
gh() {
  case "\$1" in
    issue)
      case "\$2" in
        list)
          echo -e "42\\tTest issue"
          ;;
        view)
          echo "in-progress"
          ;;
      esac
      ;;
  esac
}
export -f gh

# Wrap dispatch_issue to count calls
original_dispatch_issue=$(declare -f dispatch_issue)
eval "real_dispatch_issue() { \${original_dispatch_issue#*\\{}; }"

dispatch_issue() {
  DISPATCH_COUNT=\$((DISPATCH_COUNT + 1))
  echo "DISPATCH_CALL: issue=\$1 label=\$3 count=\$DISPATCH_COUNT"
}

run_once

echo "TOTAL_DISPATCHES=\$DISPATCH_COUNT"
`)
      // Extract total dispatches
      const match = output.match(/TOTAL_DISPATCHES=(\d+)/)
      assert.ok(match, `Expected TOTAL_DISPATCHES in output, got: ${output}`)
      assert.equal(match[1], '1', `Issue #42 should be dispatched exactly once, but was dispatched ${match[1]} time(s). Output: ${output}`)
    })
  })

  // ── Structural test: subshell EXIT trap ────────────────────────

  describe('subshell EXIT trap', () => {
    it('background subshell has EXIT trap that removes in-progress', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      // Find the background subshell in dispatch_issue (starts at the ( and ends at ) &)
      const fnStart = content.indexOf('dispatch_issue()')
      const fnEnd = content.indexOf('\n}', fnStart + 200) // skip past nested }
      const fnBody = content.slice(fnStart, fnEnd)

      // The subshell must have a trap on EXIT that removes in-progress
      const subshellStart = fnBody.indexOf('# Spawn handler in background subshell')
      assert.ok(subshellStart !== -1, 'Must have background subshell section')
      const subshellBody = fnBody.slice(subshellStart)

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
      const fnStart = content.indexOf('dispatch_issue()')
      const fnEnd = content.indexOf('\n}', fnStart + 200)
      const fnBody = content.slice(fnStart, fnEnd)

      // The EXIT trap with in-progress removal must be BEFORE the mode check
      const subshellStart = fnBody.indexOf('(', fnBody.indexOf('# Spawn handler'))
      const modeCheck = fnBody.indexOf('if [[ "$mode" == "implement"', subshellStart)
      const trapPos = fnBody.indexOf("remove-label", subshellStart)

      assert.ok(trapPos !== -1, 'Must have remove-label in subshell')
      assert.ok(modeCheck !== -1, 'Must have mode check in subshell')
      assert.ok(
        trapPos < modeCheck,
        'EXIT trap (with remove-label) must come before mode-specific logic so it covers ALL modes'
      )
    })

    it('old worktree-only trap is removed (replaced by unified EXIT trap)', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_issue()')
      const fnEnd = content.indexOf('\n}', fnStart + 200)
      const fnBody = content.slice(fnStart, fnEnd)

      // Count traps in the subshell — should be exactly one unified trap
      const subshellStart = fnBody.indexOf('(', fnBody.indexOf('# Spawn handler'))
      const subshellBody = fnBody.slice(subshellStart)
      const trapMatches = subshellBody.match(/\btrap\b/g) || []

      assert.ok(
        trapMatches.length === 1,
        `Expected exactly 1 trap in subshell (unified EXIT), found ${trapMatches.length}`
      )
    })
  })
})
