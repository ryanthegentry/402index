import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execSync } from 'node:child_process'

const SCRIPT_PATH = path.resolve('scripts/cc-dispatch.sh')

// Helper: write a bash script to a temp file and execute it
function runBash(script, { timeout = 10000, env } = {}) {
  const tmpfile = path.join(os.tmpdir(), `dispatch-bk-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`)
  fs.writeFileSync(tmpfile, script)
  try {
    return execSync(`bash "${tmpfile}"`, { encoding: 'utf-8', timeout, env: { ...process.env, ...env } }).trim()
  } catch (e) {
    const out = [e.stdout, e.stderr].filter(Boolean).join('\n').trim()
    if (out) return out
    throw e
  } finally {
    fs.unlinkSync(tmpfile)
  }
}

describe('dispatch bookkeeping (#182)', () => {
  const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')

  // ── Part 1: wait_for_ci dedup ─────────────────────────────────

  describe('wait_for_ci dedup', () => {
    it('script contains exactly ONE wait_for_ci() function definition', () => {
      const matches = content.match(/^wait_for_ci\(\)/gm) || []
      assert.equal(matches.length, 1,
        `Expected exactly 1 wait_for_ci() definition, found ${matches.length}`)
    })

    it('the single wait_for_ci has 3-arg signature with side effects', () => {
      // Find the single definition and extract its body
      const defIndex = content.indexOf('wait_for_ci()')
      const bodyEnd = content.indexOf('\n}', defIndex + 1)
      const body = content.slice(defIndex, bodyEnd)

      // Must reference $3 (possibly as ${3...}) or <timeout_seconds> (3-arg signature)
      const has3rdArg = /\$\{?3/.test(body) || body.includes('<timeout_seconds>')
      assert.ok(has3rdArg,
        'wait_for_ci must have 3-arg signature (references $3 or <timeout_seconds>)')

      // Must have side effects: labels ready-for-revision on failure
      assert.ok(
        body.includes('add-label') && body.includes('ready-for-revision'),
        'wait_for_ci must label ready-for-revision on CI failure (side effects)')
    })

    it('wait_for_ci labels ready-for-revision and returns 1 on CI failure (behavioral)', () => {
      const output = runBash(`
#!/usr/bin/env bash
set -euo pipefail

source "${SCRIPT_PATH}"

REPO="test/repo"
REPO_DIR="/tmp"
LOG_DIR="/tmp"

STUB_LOG=$(mktemp)
export STUB_LOG

# Stub gh: pr checks returns "fail", everything else logs args
gh() {
  case "\$1" in
    pr)
      case "\$2" in
        checks)
          echo "some-check\tfail\t0\thttps://example.com"
          return 0
          ;;
      esac
      ;;
    issue)
      echo "gh \$*" >> "\$STUB_LOG"
      ;;
  esac
}
export -f gh

# Call with 3-arg signature: pr_number=42, issue_number=173, timeout=5
# Disable errexit so we can capture exit code
set +e
wait_for_ci 42 173 5
exit_code=\$?
set -e

echo "EXIT_CODE=\${exit_code}"
echo "STUB_LOG:"
cat "\$STUB_LOG"
rm -f "\$STUB_LOG"
`, { timeout: 15000 })

      assert.ok(output.includes('EXIT_CODE=1'),
        `wait_for_ci should return 1 on CI failure. Output:\n${output}`)
      assert.ok(output.includes('add-label') && output.includes('ready-for-revision'),
        `wait_for_ci should label ready-for-revision on failure. Output:\n${output}`)
      // Must target issue 173, not PR 42
      assert.ok(output.includes('173'),
        `wait_for_ci should target issue_number (173) for labeling. Output:\n${output}`)
    })
  })

  // ── Part 2: post_pr_open_bookkeeping helper ───────────────────

  describe('post_pr_open_bookkeeping', () => {
    it('script defines post_pr_open_bookkeeping() function', () => {
      assert.ok(
        content.includes('post_pr_open_bookkeeping()'),
        'Script must define post_pr_open_bookkeeping() function')
    })

    it('dispatch_implement calls _create_or_adopt_pr', () => {
      const fnStart = content.indexOf('dispatch_implement()')
      const fnEnd = content.indexOf('\n}', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)
      assert.ok(
        fnBody.includes('_create_or_adopt_pr'),
        'dispatch_implement must call _create_or_adopt_pr')
    })

    it('post_pr_open_bookkeeping runs all four bookkeeping operations (behavioral)', () => {
      const output = runBash(`
#!/usr/bin/env bash
set -euo pipefail

source "${SCRIPT_PATH}"

REPO="test/repo"
REPO_DIR="/tmp"
LOG_DIR="/tmp"

STUB_LOG=$(mktemp)
export STUB_LOG

gh() {
  echo "gh \$*" >> "\$STUB_LOG"
}
export -f gh

post_pr_open_bookkeeping 999 "https://example.com/pr/42" 42 "ready-for-impl" "ready-for-security"

echo "STUB_LOG:"
cat "\$STUB_LOG"
rm -f "\$STUB_LOG"
`)

      // (a) add done_label to PR
      assert.ok(output.includes('pr edit') && output.includes('add-label') && output.includes('ready-for-security'),
        `Must add done_label to PR. Output:\n${output}`)
      // (b) remove in-progress from issue
      assert.ok(output.includes('remove-label') && output.includes('in-progress'),
        `Must remove in-progress from issue. Output:\n${output}`)
      // (c) post comment on issue
      assert.ok(output.includes('issue comment') && output.includes('999'),
        `Must post PR comment on issue. Output:\n${output}`)
      // (d) chain_next_stage (gh issue edit with add-label for next stage)
      const stubLines = output.split('\n').filter(l => l.startsWith('gh '))
      assert.ok(stubLines.length >= 4,
        `Must make at least 4 gh calls (label PR, remove in-progress, comment, chain). Got ${stubLines.length}:\n${stubLines.join('\n')}`)
    })

    it('continues bookkeeping after a single gh call fails and emits WARNING (behavioral)', () => {
      const output = runBash(`
#!/usr/bin/env bash
set -euo pipefail

source "${SCRIPT_PATH}"

REPO="test/repo"
REPO_DIR="/tmp"
LOG_DIR="/tmp"

STUB_LOG=$(mktemp)
CALL_COUNT_FILE=$(mktemp)
echo 0 > "\$CALL_COUNT_FILE"
export STUB_LOG CALL_COUNT_FILE

gh() {
  local count
  count=\$(cat "\$CALL_COUNT_FILE")
  count=\$((count + 1))
  echo "\$count" > "\$CALL_COUNT_FILE"
  echo "gh \$*" >> "\$STUB_LOG"
  # Fail the second call (remove in-progress)
  if [[ \$count -eq 2 ]]; then
    echo "simulated failure" >&2
    return 1
  fi
}
export -f gh

post_pr_open_bookkeeping 999 "https://example.com/pr/42" 42 "ready-for-impl" "ready-for-security" 2>&1

echo "STUB_LOG:"
cat "\$STUB_LOG"
rm -f "\$STUB_LOG" "\$CALL_COUNT_FILE"
`, { timeout: 15000 })

      // WARNING must appear with issue number and PR URL
      assert.ok(output.includes('WARNING') || output.includes('warning') || output.includes('Warning'),
        `Must emit WARNING on failed gh call. Output:\n${output}`)
      assert.ok(output.includes('999') && output.includes('https://example.com/pr/42'),
        `WARNING must include issue number and PR URL. Output:\n${output}`)

      // Subsequent calls must still run (at least 3 calls total even though #2 failed)
      const stubLines = output.split('\n').filter(l => l.startsWith('gh '))
      assert.ok(stubLines.length >= 3,
        `Must continue after failure — expected >=3 gh calls, got ${stubLines.length}:\n${stubLines.join('\n')}`)
    })

    it('bookkeeping WARNING includes gh stderr reason (behavioral)', () => {
      const output = runBash(`
#!/usr/bin/env bash
set -euo pipefail

source "${SCRIPT_PATH}"

REPO="test/repo"
REPO_DIR="/tmp"
LOG_DIR="/tmp"

STUB_LOG=$(mktemp)
CALL_COUNT_FILE=$(mktemp)
echo 0 > "\$CALL_COUNT_FILE"
export STUB_LOG CALL_COUNT_FILE

gh() {
  local count
  count=\$(cat "\$CALL_COUNT_FILE")
  count=\$((count + 1))
  echo "\$count" > "\$CALL_COUNT_FILE"
  echo "gh \$*" >> "\$STUB_LOG"
  # Fail the first call (add done_label to PR) with specific stderr
  if [[ \$count -eq 1 ]]; then
    echo "rate limited" >&2
    return 1
  fi
}
export -f gh

post_pr_open_bookkeeping 999 "https://example.com/pr/42" 42 "dispatch-label" "done-label" 2>&1

rm -f "\$STUB_LOG" "\$CALL_COUNT_FILE"
`, { timeout: 15000 })

      assert.ok(output.includes('rate limited'),
        `WARNING must include gh stderr reason. Output:\n${output}`)
    })

    it('post_pr_open_bookkeeping does not silence stderr with 2>/dev/null', () => {
      const fnStart = content.indexOf('post_pr_open_bookkeeping()')
      const fnEnd = content.indexOf('\n}', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)

      assert.ok(
        !fnBody.includes('2>/dev/null'),
        'post_pr_open_bookkeeping must not use 2>/dev/null — stderr should be captured for diagnostics')
    })
  })

  // ── chain_next_stage error handling ────────────────────────

  describe('chain_next_stage error handling', () => {
    it('chain_next_stage logs WARNING on gh failure (behavioral)', () => {
      const output = runBash(`
#!/usr/bin/env bash
set -euo pipefail

source "${SCRIPT_PATH}"

REPO="test/repo"
REPO_DIR="/tmp"
LOG_DIR="/tmp"

gh() {
  echo "label not found" >&2
  return 1
}
export -f gh

set +e
chain_next_stage 173 ready-for-impl
exit_code=\$?
set -e

echo "EXIT_CODE=\${exit_code}"
`, { timeout: 10000 })

      // Must not crash
      assert.ok(!output.includes('unbound variable'),
        `chain_next_stage must not crash. Output:\n${output}`)
      // Must log WARNING with issue number and label
      assert.ok(output.includes('WARNING') && output.includes('173') && output.includes('ready-for-impl'),
        `WARNING must include issue number and current label. Output:\n${output}`)
      // Must include gh stderr reason
      assert.ok(output.includes('label not found'),
        `WARNING must include gh stderr. Output:\n${output}`)
      // Must return non-zero
      assert.ok(output.includes('EXIT_CODE=1'),
        `chain_next_stage must return 1 on failure. Output:\n${output}`)
    })

    it('chain_next_stage body has error handling with WARNING and exit-code check', () => {
      const fnStart = content.indexOf('chain_next_stage()')
      const fnEnd = content.indexOf('\n}', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)

      assert.ok(fnBody.includes('WARNING'),
        'chain_next_stage must contain WARNING for error handling')
      assert.ok(fnBody.includes('return 1'),
        'chain_next_stage must return 1 on failure')
    })
  })

  // ── Part 2: adopt-or-create PR ────────────────────────────────

  describe('adopt-or-create PR pattern', () => {
    it('gh pr create in _create_or_adopt_pr captures stderr (2>&1)', () => {
      const fnStart = content.indexOf('_create_or_adopt_pr()')
      const fnEnd = content.indexOf('\n}', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)

      // Must have stderr redirect on gh pr create
      assert.ok(
        fnBody.includes('gh pr create') && fnBody.includes('2>&1'),
        'gh pr create must capture stderr (2>&1)')
    })

    it('_create_or_adopt_pr has adopt fallback using gh pr list --head', () => {
      const fnStart = content.indexOf('_create_or_adopt_pr()')
      const fnEnd = content.indexOf('\n}', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)

      assert.ok(
        fnBody.includes('gh pr list') && fnBody.includes('--head'),
        '_create_or_adopt_pr must have adopt-PR fallback using gh pr list --head "$branch"')
    })

    it('adopts existing PR and runs bookkeeping when gh pr create fails (behavioral)', () => {
      const output = runBash(`
#!/usr/bin/env bash
set -euo pipefail

source "${SCRIPT_PATH}"

REPO="test/repo"
REPO_DIR="/tmp"
LOG_DIR="/tmp"

STUB_LOG=$(mktemp)
export STUB_LOG

gh() {
  echo "gh \$*" >> "\$STUB_LOG"
  case "\$1" in
    pr)
      case "\$2" in
        create)
          echo "a pull request for branch already exists" >&2
          return 1
          ;;
        list)
          # Return field based on --jq argument
          for arg in "\$@"; do
            case "\$arg" in
              '.[0].url') echo "https://github.com/x/y/pull/42"; return 0 ;;
              '.[0].number') echo "42"; return 0 ;;
            esac
          done
          ;;
        edit) ;; # bookkeeping — just log
      esac
      ;;
    issue) ;; # bookkeeping — just log
  esac
}
export -f gh

_create_or_adopt_pr 999 "test title" "fix/issue-999" "summary" "" "ready-for-impl" "ready-for-security" 2>&1

echo "STUB_LOG:"
cat "\$STUB_LOG"
rm -f "\$STUB_LOG"
`, { timeout: 15000 })

      // Must adopt existing PR
      assert.ok(output.includes('Adopted existing PR #42'),
        `Must log adoption of PR #42. Output:\n${output}`)
      assert.ok(output.includes('https://github.com/x/y/pull/42'),
        `Must use adopted PR URL. Output:\n${output}`)
      // Bookkeeping must run with adopted PR details
      const stubLines = output.split('\n').filter(l => l.startsWith('gh '))
      // create(1) + adopt-list(2) + bookkeeping(4) = 7 min
      assert.ok(stubLines.length >= 6,
        `Must run create + adopt + bookkeeping (>=6 gh calls). Got ${stubLines.length}:\n${stubLines.join('\n')}`)
    })
  })

  // ── Part 3: main_sha ref fix ──────────────────────────────────

  describe('main_sha origin ref', () => {
    it('main_sha uses origin/${DEFAULT_BRANCH}', () => {
      assert.ok(
        content.includes('git rev-parse "origin/${DEFAULT_BRANCH}"'),
        'main_sha must be computed from origin/${DEFAULT_BRANCH}')
    })

    it('no bare git rev-parse "$DEFAULT_BRANCH" remains (excluding checkout -B)', () => {
      // Find all git rev-parse lines
      const lines = content.split('\n')
      for (const line of lines) {
        if (line.includes('git rev-parse') && line.includes('"$DEFAULT_BRANCH"')) {
          // This is ok if it's the origin/ form
          if (!line.includes('origin/')) {
            assert.fail(
              `Found bare git rev-parse "$DEFAULT_BRANCH" (without origin/): ${line.trim()}`)
          }
        }
      }
    })
  })

  // ── Part 4: PR prohibition in cc_prompt ───────────────────────

  describe('cc_prompt PR prohibition', () => {
    it('both cc_prompt branches contain "Do NOT open a pull request"', () => {
      // Extract dispatch_implement body
      const fnStart = content.indexOf('dispatch_implement()')
      const fnEnd = content.indexOf('\n}', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)

      // Find the if/else for agent_flag prompt construction
      const ifAgent = fnBody.indexOf('if [[ -n "$agent_flag" ]]')
      assert.ok(ifAgent !== -1, 'Must have agent_flag conditional in dispatch_implement')

      // Split at the else to get both branches
      const afterIf = fnBody.slice(ifAgent)
      const elsePos = afterIf.indexOf('else')
      assert.ok(elsePos !== -1, 'Must have else branch for cc_prompt')

      const branch1 = afterIf.slice(0, elsePos)
      const branch2 = afterIf.slice(elsePos)

      // Truncate branch2 at the closing "fi" (on its own line) to avoid matching outside
      const fiMatch = branch2.match(/^\s+fi\b/m)
      const fiPos = fiMatch ? branch2.indexOf(fiMatch[0]) : -1
      const branch2Trimmed = branch2.slice(0, fiPos !== -1 ? fiPos : undefined)

      assert.ok(branch1.includes('Do NOT open a pull request'),
        'Agent-flag branch of cc_prompt must contain "Do NOT open a pull request"')
      assert.ok(branch2Trimmed.includes('Do NOT open a pull request'),
        'Non-agent branch of cc_prompt must contain "Do NOT open a pull request"')
    })
  })
})

// ══════════════════════════════════════════════════════════════════
// #188 PR 1 — Counter accuracy (Defect 2) + STATUS line (Defect 3)
// ══════════════════════════════════════════════════════════════════

describe('dispatch counter + STATUS (#188 PR 1)', () => {
  const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')

  // ── Defect 2: dispatch_issue return codes ───────────────────────

  describe('dispatch_issue return codes', () => {
    it('returns 2 when issue is already in-progress', () => {
      const output = runBash(`
#!/usr/bin/env bash
set -euo pipefail

source "${SCRIPT_PATH}"

REPO="test/repo"
REPO_DIR="/tmp"
LOG_DIR="/tmp"
DRY_RUN=false
dispatched_this_cycle=" "

gh() {
  case "\$1" in
    issue)
      case "\$2" in
        view) echo "in-progress,bug" ;;
      esac
      ;;
  esac
}
export -f gh

set +e
dispatch_issue 101 "Test issue" "ready-for-impl"
exit_code=\$?
set -e

echo "EXIT_CODE=\${exit_code}"
`, { timeout: 15000 })

      assert.ok(output.includes('EXIT_CODE=2'),
        `dispatch_issue should return 2 when in-progress. Output:\n${output}`)
    })

    it('returns 2 when concurrency limit reached', () => {
      const output = runBash(`
#!/usr/bin/env bash
set -euo pipefail

source "${SCRIPT_PATH}"

REPO="test/repo"
REPO_DIR="/tmp"
LOG_DIR="/tmp"
DRY_RUN=false
MAX_CONCURRENT=0
dispatched_this_cycle=" "

gh() {
  case "\$1" in
    issue)
      case "\$2" in
        view) echo "bug,enhancement" ;;
      esac
      ;;
  esac
}
export -f gh

set +e
dispatch_issue 101 "Test issue" "ready-for-impl"
exit_code=\$?
set -e

echo "EXIT_CODE=\${exit_code}"
`, { timeout: 15000 })

      assert.ok(output.includes('EXIT_CODE=2'),
        `dispatch_issue should return 2 when concurrency limit reached. Output:\n${output}`)
    })

    it('returns 2 when issue already dispatched this cycle (dedup)', () => {
      const output = runBash(`
#!/usr/bin/env bash
set -euo pipefail

source "${SCRIPT_PATH}"

REPO="test/repo"
REPO_DIR="/tmp"
LOG_DIR="/tmp"
DRY_RUN=false
dispatched_this_cycle=" 101 "

set +e
dispatch_issue 101 "Test issue" "ready-for-impl"
exit_code=\$?
set -e

echo "EXIT_CODE=\${exit_code}"
`, { timeout: 15000 })

      assert.ok(output.includes('EXIT_CODE=2'),
        `dispatch_issue should return 2 for dedup skip. Output:\n${output}`)
    })
  })

  // ── Defect 2: run_once counter accuracy ─────────────────────────

  describe('run_once counter accuracy', () => {
    it('reports "Dispatched 1 issue(s); skipped 2 (concurrency/in-progress)." for 1 spawned 2 skipped', () => {
      const output = runBash(`
#!/usr/bin/env bash
set -euo pipefail

source "${SCRIPT_PATH}"

REPO="test/repo"
REPO_DIR="/tmp"
LOG_DIR="/tmp"
DRY_RUN=false
DISPATCH_LABELS=(ready-for-impl)

CALL_COUNT=0

dispatch_issue() {
  CALL_COUNT=\$((CALL_COUNT + 1))
  case \$CALL_COUNT in
    1) return 0 ;;
    *) return 2 ;;
  esac
}

gh() {
  case "\$1" in
    issue)
      case "\$2" in
        list) printf "101\\tIssue 1\\n102\\tIssue 2\\n103\\tIssue 3\\n" ;;
      esac
      ;;
  esac
}
export -f gh

run_once 2>&1
`, { timeout: 15000 })

      assert.ok(
        output.includes('Dispatched 1 issue(s); skipped 2 (concurrency/in-progress)'),
        `Expected 'Dispatched 1 issue(s); skipped 2 (concurrency/in-progress)'. Output:\n${output}`)
    })

    it('reports "Dispatched 0 issue(s); skipped 3 (concurrency/in-progress)." when all skipped', () => {
      const output = runBash(`
#!/usr/bin/env bash
set -euo pipefail

source "${SCRIPT_PATH}"

REPO="test/repo"
REPO_DIR="/tmp"
LOG_DIR="/tmp"
DRY_RUN=false
DISPATCH_LABELS=(ready-for-impl)

dispatch_issue() { return 2; }

gh() {
  case "\$1" in
    issue)
      case "\$2" in
        list) printf "101\\tIssue 1\\n102\\tIssue 2\\n103\\tIssue 3\\n" ;;
      esac
      ;;
  esac
}
export -f gh

run_once 2>&1
`, { timeout: 15000 })

      assert.ok(
        output.includes('Dispatched 0 issue(s); skipped 3 (concurrency/in-progress)'),
        `Expected 'Dispatched 0 issue(s); skipped 3 (concurrency/in-progress)'. Output:\n${output}`)
    })

    it('reports "Dispatched 3 issue(s)." with no skip clause when all spawned', () => {
      const output = runBash(`
#!/usr/bin/env bash
set -euo pipefail

source "${SCRIPT_PATH}"

REPO="test/repo"
REPO_DIR="/tmp"
LOG_DIR="/tmp"
DRY_RUN=false
DISPATCH_LABELS=(ready-for-impl)

dispatch_issue() { return 0; }

gh() {
  case "\$1" in
    issue)
      case "\$2" in
        list) printf "101\\tIssue 1\\n102\\tIssue 2\\n103\\tIssue 3\\n" ;;
      esac
      ;;
  esac
}
export -f gh

run_once 2>&1
`, { timeout: 15000 })

      assert.ok(
        output.includes('Dispatched 3 issue(s).'),
        `Expected 'Dispatched 3 issue(s).'. Output:\n${output}`)
      assert.ok(
        !output.includes('skipped'),
        `Should NOT include skip clause when all spawned. Output:\n${output}`)
    })
  })

  // ── Defect 3: STATUS line ──────────────────────────────────────

  describe('STATUS line (Defect 3)', () => {
    it('emits STATUS line with in_flight=0 and no jobs= when nothing tracked', () => {
      const output = runBash(`
#!/usr/bin/env bash
set -euo pipefail

source "${SCRIPT_PATH}"

REPO="test/repo"
REPO_DIR="/tmp"
LOG_DIR="/tmp"
DRY_RUN=false
DISPATCH_LABELS=()

# Initialize empty pool tracking
PIDS_REDTEAM=""
PIDS_IMPL=""
PIDS_SECURITY=""
PIDS_QA=""
PIDS_CHORE=""
PIDS_REVISION=""

run_once 2>&1
`, { timeout: 15000 })

      assert.ok(output.includes('STATUS:'),
        `Must emit STATUS line. Output:\n${output}`)
      assert.ok(output.includes('in_flight=0'),
        `Must show in_flight=0. Output:\n${output}`)
      assert.ok(!output.includes('jobs='),
        `Must NOT include jobs= when in_flight=0. Output:\n${output}`)
    })

    it('emits STATUS line with pool utilization and job entries for tracked PIDs', () => {
      const output = runBash(`
#!/usr/bin/env bash
set -euo pipefail

source "${SCRIPT_PATH}"

REPO="test/repo"
REPO_DIR="/tmp"
LOG_DIR="/tmp"
DRY_RUN=false
DISPATCH_LABELS=()

# Use current PID as a "live" process
LIVE_PID=\$\$
START_TIME=\$(( \$(date +%s) - 120 ))  # 2 minutes ago

PIDS_REDTEAM="\${LIVE_PID}:184:redteam:\${START_TIME}"
PIDS_IMPL="\${LIVE_PID}:173:impl:\${START_TIME}"
PIDS_SECURITY=""
PIDS_QA=""
PIDS_CHORE=""
PIDS_REVISION=""

# Need reap_pool to exist for STATUS emission
run_once 2>&1
`, { timeout: 15000 })

      assert.ok(output.includes('STATUS:'),
        `Must emit STATUS line. Output:\n${output}`)
      assert.ok(output.includes('in_flight=2'),
        `Must show in_flight=2. Output:\n${output}`)
      assert.ok(output.includes('redteam:1/'),
        `Must show redteam pool utilization. Output:\n${output}`)
      assert.ok(output.includes('impl:1/'),
        `Must show impl pool utilization. Output:\n${output}`)
      assert.ok(output.includes('jobs='),
        `Must include jobs= with entries. Output:\n${output}`)
      assert.ok(output.includes('#184:redteam:'),
        `Must include issue #184 in jobs list. Output:\n${output}`)
      assert.ok(output.includes('#173:impl:'),
        `Must include issue #173 in jobs list. Output:\n${output}`)
    })

    it('reap_pool removes dead PIDs before STATUS emission', () => {
      const output = runBash(`
#!/usr/bin/env bash
set -euo pipefail

source "${SCRIPT_PATH}"

REPO="test/repo"
REPO_DIR="/tmp"
LOG_DIR="/tmp"
DRY_RUN=false
DISPATCH_LABELS=()

LIVE_PID=\$\$
START_TIME=\$(date +%s)

# 99999 is a dead PID (almost certainly not running)
PIDS_REDTEAM="99999:184:redteam:\${START_TIME} \${LIVE_PID}:185:redteam:\${START_TIME}"
PIDS_IMPL=""
PIDS_SECURITY=""
PIDS_QA=""
PIDS_CHORE=""
PIDS_REVISION=""

run_once 2>&1
`, { timeout: 15000 })

      assert.ok(output.includes('STATUS:'),
        `Must emit STATUS line. Output:\n${output}`)
      assert.ok(output.includes('in_flight=1'),
        `Must show in_flight=1 after reaping dead PID 99999. Output:\n${output}`)
      assert.ok(!output.includes('#184:'),
        `Dead PID issue #184 must NOT appear in jobs list. Output:\n${output}`)
      assert.ok(output.includes('#185:redteam:'),
        `Live PID issue #185 must appear in jobs list. Output:\n${output}`)
    })

    it('STATUS line appends orphans=N when jobs -rp exceeds tracked pool count', () => {
      const output = runBash(`
#!/usr/bin/env bash
set -euo pipefail

source "${SCRIPT_PATH}"

REPO="test/repo"
REPO_DIR="/tmp"
LOG_DIR="/tmp"
DRY_RUN=false
DISPATCH_LABELS=()

# Initialize empty pools — no tracked PIDs
PIDS_REDTEAM=""
PIDS_IMPL=""
PIDS_SECURITY=""
PIDS_QA=""
PIDS_CHORE=""
PIDS_REVISION=""

# Spawn 2 orphan background jobs (not tracked in any pool)
sleep 300 &
sleep 300 &

# Ensure jobs are visible
sleep 0.1

run_once 2>&1

# Clean up background jobs
kill %1 %2 2>/dev/null
wait 2>/dev/null
`, { timeout: 15000 })

      assert.ok(output.includes('STATUS:'),
        `Must emit STATUS line. Output:\n${output}`)
      assert.ok(output.includes('orphans='),
        `Must append orphans= when untracked background jobs exist. Output:\n${output}`)
    })
  })

  // ── Defect 3: reap_pool + pool_count helpers ───────────────────

  describe('reap_pool and pool_count helpers', () => {
    it('reap_pool removes dead PIDs and preserves live ones', () => {
      const output = runBash(`
#!/usr/bin/env bash
set -euo pipefail

source "${SCRIPT_PATH}"

REPO="test/repo"
REPO_DIR="/tmp"
LOG_DIR="/tmp"

LIVE_PID=\$\$
START_TIME=\$(date +%s)

PIDS_REDTEAM="99999:100:redteam:\${START_TIME} \${LIVE_PID}:200:redteam:\${START_TIME}"

reap_pool REDTEAM

echo "POOL_AFTER=\${PIDS_REDTEAM}"
echo "CONTAINS_DEAD=\$(echo "\${PIDS_REDTEAM}" | grep -c 99999 || true)"
echo "CONTAINS_LIVE=\$(echo "\${PIDS_REDTEAM}" | grep -c "\${LIVE_PID}" || true)"
`, { timeout: 15000 })

      assert.ok(output.includes('CONTAINS_DEAD=0'),
        `Dead PID 99999 must be removed. Output:\n${output}`)
      assert.ok(output.includes('CONTAINS_LIVE=1'),
        `Live PID must be preserved. Output:\n${output}`)
    })

    it('pool_count returns correct count of tracked PIDs', () => {
      const output = runBash(`
#!/usr/bin/env bash
set -euo pipefail

source "${SCRIPT_PATH}"

REPO="test/repo"
REPO_DIR="/tmp"
LOG_DIR="/tmp"

PIDS_IMPL="123:100:impl:1700000000 456:200:impl:1700000000 789:300:impl:1700000000"

count=\$(pool_count IMPL)
echo "COUNT=\${count}"
`, { timeout: 15000 })

      assert.ok(output.includes('COUNT=3'),
        `pool_count should return 3 for 3 tracked PIDs. Output:\n${output}`)
    })

    it('pool_count returns 0 for empty pool', () => {
      const output = runBash(`
#!/usr/bin/env bash
set -euo pipefail

source "${SCRIPT_PATH}"

REPO="test/repo"
REPO_DIR="/tmp"
LOG_DIR="/tmp"

PIDS_IMPL=""

count=\$(pool_count IMPL)
echo "COUNT=\${count}"
`, { timeout: 15000 })

      assert.ok(output.includes('COUNT=0'),
        `pool_count should return 0 for empty pool. Output:\n${output}`)
    })
  })
})
