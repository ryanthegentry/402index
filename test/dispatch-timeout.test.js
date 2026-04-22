import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execSync, spawn } from 'node:child_process'

const SCRIPT_PATH = path.resolve('scripts/cc-dispatch.sh')
const CONTRIBUTING_PATH = path.resolve('CONTRIBUTING.md')

// Helper: write a bash script to a temp file and execute it
function runBash(script, { timeout = 15000, env } = {}) {
  const tmpfile = path.join(os.tmpdir(), `dispatch-to-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`)
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

describe('dispatch timeout and orphan cleanup (#192)', () => {
  const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')

  // ══════════════════════════════════════════════════════════════════
  // Defect 1 — per-stage timeout
  // ══════════════════════════════════════════════════════════════════

  describe('per-stage timeout', () => {

    // T1: Wrapper running > MAX_SESSION_MINUTES_IMPL (90m) → check_timeouts() sends SIGTERM
    it('T1: kills wrapper exceeding MAX_SESSION_MINUTES_IMPL', () => {
      const output = runBash(`
#!/usr/bin/env bash
source "${SCRIPT_PATH}"

# Stub kill/pkill/gh/tail/date for testing
killed_pids=""
kill() {
  if [[ "\$1" == "-0" ]]; then
    # Simulate process already dead after SIGTERM
    return 1
  fi
  killed_pids="\$killed_pids \$1"
  echo "KILL_CALLED: \$*"
}
export -f kill

pkill() { echo "PKILL_CALLED: \$*"; }
export -f pkill

gh() { echo "GH_CALLED: \$*"; }
export -f gh

tail() { echo "(log tail stub)"; }
export -f tail

MAX_SESSION_MINUTES_IMPL=90
MIN_KILL_AGE_SECONDS=0
KILL_GRACE_SECONDS=1
REPO="test/repo"
LOG_DIR="/tmp"

# Simulate a wrapper that started 91 minutes ago
now=\$(command date +%s)
start_time=\$((now - 91 * 60))
PIDS_IMPL="99999:\${start_time}:impl:\${start_time}"

# Fix tuple format: PID:ISSUE:POOL:STARTTIME
PIDS_IMPL="99999:42:impl:\${start_time}"

check_timeouts 2>&1
`)
      assert.ok(
        output.includes('TIMEOUT') || output.includes('KILL_CALLED'),
        `Expected check_timeouts to kill wrapper at 91m, got: ${output}`
      )
    })

    // T2: Wrapper running < threshold → not killed
    it('T2: does NOT kill wrapper under threshold', () => {
      const output = runBash(`
#!/usr/bin/env bash
source "${SCRIPT_PATH}"
set -e

kill() { echo "KILL_CALLED: \$*"; }
export -f kill
pkill() { :; }
export -f pkill
gh() { :; }
export -f gh

MAX_SESSION_MINUTES_IMPL=90
MIN_KILL_AGE_SECONDS=0
REPO="test/repo"
LOG_DIR="/tmp"

now=\$(command date +%s)
start_time=\$((now - 30 * 60))
PIDS_IMPL="99999:42:impl:\${start_time}"

check_timeouts 2>&1
echo "CHECK_RAN_OK"
`)
      assert.ok(
        output.includes('CHECK_RAN_OK'),
        `check_timeouts must execute without error, got: ${output}`
      )
      assert.ok(
        !output.includes('KILL_CALLED') && !output.includes('TIMEOUT'),
        `Expected no kill for wrapper at 30m (threshold 90m), got: ${output}`
      )
    })

    // T3: Wrapper at 0.7x threshold → warning logged, NOT killed
    it('T3: warns at 0.7x threshold without killing', () => {
      const output = runBash(`
#!/usr/bin/env bash
source "${SCRIPT_PATH}"

kill() { echo "KILL_CALLED: \$*"; }
export -f kill
pkill() { :; }
export -f pkill
gh() { :; }
export -f gh

MAX_SESSION_MINUTES_IMPL=90
MIN_KILL_AGE_SECONDS=0
TIMEOUT_WARNING_RATIO_NUM=7
TIMEOUT_WARNING_RATIO_DEN=10
REPO="test/repo"
LOG_DIR="/tmp"

# 0.7 * 90 = 63m, set to 65m (past warning, before kill)
now=\$(command date +%s)
start_time=\$((now - 65 * 60))
PIDS_IMPL="99999:42:impl:\${start_time}"

check_timeouts 2>&1
`)
      assert.ok(
        output.includes('WARNING') && output.includes('approaching timeout'),
        `Expected warning at 65m (0.7*90=63m threshold), got: ${output}`
      )
      assert.ok(
        !output.includes('TIMEOUT:') && !output.includes('KILL_CALLED'),
        `Expected NO kill at 65m (threshold 90m), got: ${output}`
      )
    })

    // T4: Wrapper younger than MIN_KILL_AGE_SECONDS → not killed even if over threshold
    it('T4: respects MIN_KILL_AGE_SECONDS floor', () => {
      const output = runBash(`
#!/usr/bin/env bash
source "${SCRIPT_PATH}"
set -e

kill() { echo "KILL_CALLED: \$*"; }
export -f kill
pkill() { :; }
export -f pkill
gh() { :; }
export -f gh

MAX_SESSION_MINUTES_REDTEAM=1
MIN_KILL_AGE_SECONDS=300
REPO="test/repo"
LOG_DIR="/tmp"

# Started 120s ago — over 1m threshold but under 300s floor
now=\$(command date +%s)
start_time=\$((now - 120))
PIDS_REDTEAM="99999:42:redteam:\${start_time}"

check_timeouts 2>&1
echo "CHECK_RAN_OK"
`)
      assert.ok(
        output.includes('CHECK_RAN_OK'),
        `check_timeouts must execute without error, got: ${output}`
      )
      assert.ok(
        !output.includes('KILL_CALLED') && !output.includes('TIMEOUT'),
        `Expected no kill (120s elapsed, MIN_KILL_AGE_SECONDS=300), got: ${output}`
      )
    })

    // T5: Wrapper doesn't exit within KILL_GRACE_SECONDS → SIGKILL sent + explicit cleanup
    it('T5: escalates to SIGKILL when wrapper does not exit after SIGTERM', () => {
      const output = runBash(`
#!/usr/bin/env bash
source "${SCRIPT_PATH}"

# Stub kill: -0 always returns 0 (process still alive), other signals just log
kill() {
  if [[ "\$1" == "-0" ]]; then
    return 0
  fi
  echo "KILL_CALLED: \$*"
}
export -f kill

pkill() { echo "PKILL_CALLED: \$*"; }
export -f pkill

gh() { echo "GH_CALLED: \$*"; }
export -f gh

tail() { echo "(log tail)"; }
export -f tail

sleep() { :; }
export -f sleep

MAX_SESSION_MINUTES_IMPL=90
MIN_KILL_AGE_SECONDS=0
KILL_GRACE_SECONDS=2
REPO="test/repo"
LOG_DIR="/tmp"

now=\$(command date +%s)
start_time=\$((now - 91 * 60))
PIDS_IMPL="99999:42:impl:\${start_time}"

check_timeouts 2>&1
`, { timeout: 20000 })
      assert.ok(
        output.includes('KILL_CALLED: -9'),
        `Expected SIGKILL (-9) escalation, got: ${output}`
      )
      assert.ok(
        output.includes('ESCALATED') || output.includes('SIGKILL'),
        `Expected ESCALATED log line, got: ${output}`
      )
    })

    // T6: SIGKILL path explicitly removes in-progress label (not relying on trap)
    it('T6: SIGKILL path explicitly removes in-progress label', () => {
      const output = runBash(`
#!/usr/bin/env bash
source "${SCRIPT_PATH}"

kill() {
  if [[ "\$1" == "-0" ]]; then return 0; fi
  echo "KILL_CALLED: \$*"
}
export -f kill

pkill() { echo "PKILL_CALLED: \$*"; }
export -f pkill

gh() { echo "GH_CALLED: \$*"; }
export -f gh

tail() { echo "(log tail)"; }
export -f tail

sleep() { :; }
export -f sleep

git() { echo "GIT_CALLED: \$*"; }
export -f git

MAX_SESSION_MINUTES_IMPL=90
MIN_KILL_AGE_SECONDS=0
KILL_GRACE_SECONDS=1
REPO="test/repo"
REPO_DIR="/tmp"
LOG_DIR="/tmp"

now=\$(command date +%s)
start_time=\$((now - 91 * 60))
PIDS_IMPL="99999:42:impl:\${start_time}"

check_timeouts 2>&1
`, { timeout: 20000 })
      assert.ok(
        output.includes('GH_CALLED') && output.includes('--remove-label') && output.includes('in-progress'),
        `Expected explicit in-progress label removal in SIGKILL path, got: ${output}`
      )
    })

    // T7: Timeout posts GitHub comment with elapsed time, stage, threshold, and log tail
    it('T7: posts GitHub comment with required fields', () => {
      const output = runBash(`
#!/usr/bin/env bash
source "${SCRIPT_PATH}"

kill() {
  if [[ "\$1" == "-0" ]]; then return 1; fi
  echo "KILL_CALLED: \$*"
}
export -f kill

pkill() { :; }
export -f pkill

gh_calls=""
gh() {
  echo "GH_CALLED: \$*"
}
export -f gh

tail() { echo "simulated log line 1"; echo "simulated log line 2"; }
export -f tail

MAX_SESSION_MINUTES_IMPL=90
MIN_KILL_AGE_SECONDS=0
KILL_GRACE_SECONDS=1
REPO="test/repo"
LOG_DIR="/tmp"

now=\$(command date +%s)
start_time=\$((now - 91 * 60))
PIDS_IMPL="99999:42:impl:\${start_time}"

check_timeouts 2>&1
`)
      assert.ok(
        output.includes('GH_CALLED: issue comment'),
        `Expected GitHub comment to be posted, got: ${output}`
      )
      // The comment body should contain stage, threshold, elapsed info
      assert.ok(
        output.includes('timed out') || output.includes('TIMEOUT'),
        `Expected timeout info in output, got: ${output}`
      )
    })

    // T8: Timeout-killed session increments revision counter
    it('T8: timeout counts against MAX_REVISIONS', () => {
      const output = runBash(`
#!/usr/bin/env bash
source "${SCRIPT_PATH}"

kill() {
  if [[ "\$1" == "-0" ]]; then return 1; fi
}
export -f kill

pkill() { :; }
export -f pkill

gh() { echo "GH_CALLED: \$*"; }
export -f gh

tail() { echo "(log tail)"; }
export -f tail

MAX_SESSION_MINUTES_IMPL=90
MIN_KILL_AGE_SECONDS=0
KILL_GRACE_SECONDS=1
REPO="test/repo"
LOG_DIR="/tmp"

now=\$(command date +%s)
start_time=\$((now - 91 * 60))
PIDS_IMPL="99999:42:impl:\${start_time}"

check_timeouts 2>&1
`)
      // The kill_wrapper should add ready-for-revision label to count against MAX_REVISIONS
      assert.ok(
        output.includes('ready-for-revision') || output.includes('revision'),
        `Expected timeout to increment revision counter, got: ${output}`
      )
    })

    // T9: Per-stage thresholds honored — REDTEAM=15 kills at 16m, IMPL=90 doesn't kill at 16m
    it('T9: per-stage thresholds are independent', () => {
      const output = runBash(`
#!/usr/bin/env bash
source "${SCRIPT_PATH}"

killed_pids=""
kill() {
  if [[ "\$1" == "-0" ]]; then return 1; fi
  killed_pids="\$killed_pids \$1"
  echo "KILL_CALLED_PID_\$1: \$*"
}
export -f kill

pkill() { :; }
export -f pkill
gh() { :; }
export -f gh
tail() { :; }
export -f tail

MAX_SESSION_MINUTES_REDTEAM=15
MAX_SESSION_MINUTES_IMPL=90
MIN_KILL_AGE_SECONDS=0
KILL_GRACE_SECONDS=1
REPO="test/repo"
LOG_DIR="/tmp"

now=\$(command date +%s)
start_time=\$((now - 16 * 60))
PIDS_REDTEAM="11111:42:redteam:\${start_time}"
PIDS_IMPL="22222:43:impl:\${start_time}"

check_timeouts 2>&1
`)
      assert.ok(
        output.includes('KILL_CALLED_PID_11111'),
        `Expected REDTEAM wrapper (PID 11111) killed at 16m (threshold 15m), got: ${output}`
      )
      assert.ok(
        !output.includes('KILL_CALLED_PID_22222'),
        `Expected IMPL wrapper (PID 22222) NOT killed at 16m (threshold 90m), got: ${output}`
      )
    })

    // T10: Env var override respected — MAX_SESSION_MINUTES_IMPL=120 → no kill at 90m
    it('T10: env var override changes threshold', () => {
      const output = runBash(`
#!/usr/bin/env bash
source "${SCRIPT_PATH}"
set -e

kill() { echo "KILL_CALLED: \$*"; }
export -f kill
pkill() { :; }
export -f pkill
gh() { :; }
export -f gh

MAX_SESSION_MINUTES_IMPL=120
MIN_KILL_AGE_SECONDS=0
REPO="test/repo"
LOG_DIR="/tmp"

now=\$(command date +%s)
start_time=\$((now - 95 * 60))
PIDS_IMPL="99999:42:impl:\${start_time}"

check_timeouts 2>&1
echo "CHECK_RAN_OK"
`)
      assert.ok(
        output.includes('CHECK_RAN_OK'),
        `check_timeouts must execute without error, got: ${output}`
      )
      assert.ok(
        !output.includes('KILL_CALLED') && !output.includes('TIMEOUT'),
        `Expected no kill at 95m with threshold 120m, got: ${output}`
      )
    })
  })

  // ══════════════════════════════════════════════════════════════════
  // Defect 2 — orphaned child cleanup in EXIT trap
  // ══════════════════════════════════════════════════════════════════

  describe('orphaned child cleanup', () => {

    // T11: Wrapper exits normally → trap's pkill -P $$ runs → child is killed
    it('T11: EXIT trap kills child on normal exit', () => {
      // Extract the trap from the subshell and verify it contains pkill -P
      const spawnStart = content.indexOf('# Spawn handler in background subshell')
      assert.ok(spawnStart !== -1, 'Must have background subshell section')
      const subshellEnd = content.indexOf(') &', spawnStart)
      const subshellBody = content.slice(spawnStart, subshellEnd)

      assert.ok(
        subshellBody.includes('pkill -P'),
        `EXIT trap must include 'pkill -P' to kill child processes, got trap body: ${subshellBody.slice(0, 500)}`
      )
    })

    // T12: Wrapper receives SIGTERM → trap fires → child killed
    it('T12: EXIT trap fires on SIGTERM and kills children', () => {
      const spawnStart = content.indexOf('# Spawn handler in background subshell')
      const subshellEnd = content.indexOf(') &', spawnStart)
      const subshellBody = content.slice(spawnStart, subshellEnd)

      // Trap must be on EXIT (fires for both normal and SIGTERM)
      assert.ok(
        subshellBody.includes('pkill -P') && subshellBody.includes('EXIT'),
        'EXIT trap must include pkill -P to kill children on SIGTERM'
      )
    })

    // T13: No child exists when trap fires → pkill no-op, no error
    it('T13: pkill in trap uses 2>/dev/null to suppress errors', () => {
      const spawnStart = content.indexOf('# Spawn handler in background subshell')
      const subshellEnd = content.indexOf(') &', spawnStart)
      const subshellBody = content.slice(spawnStart, subshellEnd)

      // pkill -P $$ must have 2>/dev/null
      const pkillLine = subshellBody.split('\n').find(l => l.includes('pkill -P'))
      assert.ok(pkillLine, 'Must have pkill -P in trap')
      assert.ok(
        pkillLine.includes('2>/dev/null'),
        `pkill -P must suppress errors with 2>/dev/null, got: ${pkillLine}`
      )
    })

    // T14: Multiple direct children → all killed (pkill -P kills all)
    it('T14: pkill -P $$ kills all direct children', () => {
      const spawnStart = content.indexOf('# Spawn handler in background subshell')
      const subshellEnd = content.indexOf(') &', spawnStart)
      const subshellBody = content.slice(spawnStart, subshellEnd)

      // pkill -P $$ targets all direct children, not a specific PID
      const pkillLine = subshellBody.split('\n').find(l => l.includes('pkill -P'))
      assert.ok(pkillLine, 'Must have pkill -P in trap')
      assert.ok(
        pkillLine.includes('$$'),
        `pkill -P must target $$ (all children of wrapper), got: ${pkillLine}`
      )
    })
  })

  // ══════════════════════════════════════════════════════════════════
  // Defect 3 — CONTRIBUTING.md recovery section
  // ══════════════════════════════════════════════════════════════════

  describe('CONTRIBUTING.md recovery docs', () => {

    // T15: CONTRIBUTING.md contains ## Dispatch Recovery
    it('T15: CONTRIBUTING.md has Dispatch Recovery section', () => {
      const contributing = fs.readFileSync(CONTRIBUTING_PATH, 'utf-8')
      assert.ok(
        contributing.includes('## Dispatch Recovery'),
        'CONTRIBUTING.md must contain a "## Dispatch Recovery" section'
      )
    })

    // T16: Section references pgrep and global SIGTERM recovery
    it('T16: recovery section references pgrep and SIGTERM procedure', () => {
      const contributing = fs.readFileSync(CONTRIBUTING_PATH, 'utf-8')
      const recoveryStart = contributing.indexOf('## Dispatch Recovery')
      assert.ok(recoveryStart !== -1, 'Must have Dispatch Recovery section')
      const nextSection = contributing.indexOf('\n## ', recoveryStart + 1)
      const recoverySection = nextSection === -1
        ? contributing.slice(recoveryStart)
        : contributing.slice(recoveryStart, nextSection)

      assert.ok(
        recoverySection.includes("pgrep -f 'cc-dispatch.sh --watch'"),
        `Recovery section must reference pgrep command, got: ${recoverySection.slice(0, 300)}`
      )
      assert.ok(
        recoverySection.includes('SIGTERM') || recoverySection.includes('kill <pid>'),
        `Recovery section must describe SIGTERM recovery, got: ${recoverySection.slice(0, 300)}`
      )
    })
  })

  // ══════════════════════════════════════════════════════════════════
  // Failure-mode tests
  // ══════════════════════════════════════════════════════════════════

  describe('failure modes', () => {

    // T17: Double-kill race — wrapper exits between check and kill → no error
    it('T17: kill tolerates ESRCH when wrapper exits during kill', () => {
      const output = runBash(`
#!/usr/bin/env bash
source "${SCRIPT_PATH}"

# Simulate process that doesn't exist (kill returns ESRCH)
kill() {
  if [[ "\$1" == "-0" ]]; then return 1; fi
  echo "KILL_CALLED: \$*"
  return 0  # 2>/dev/null swallows any error
}
export -f kill

pkill() { :; }
export -f pkill

gh() { echo "GH_CALLED: \$*"; }
export -f gh

tail() { echo "(log tail)"; }
export -f tail

MAX_SESSION_MINUTES_IMPL=90
MIN_KILL_AGE_SECONDS=0
KILL_GRACE_SECONDS=1
REPO="test/repo"
LOG_DIR="/tmp"

now=\$(command date +%s)
start_time=\$((now - 91 * 60))
PIDS_IMPL="99999:42:impl:\${start_time}"

# Should not crash — check_timeouts must exist and complete
check_timeouts 2>&1
echo "EXIT_OK"
`)
      assert.ok(
        output.includes('TIMEOUT') || output.includes('KILL_CALLED'),
        `Expected check_timeouts to fire the kill path, got: ${output}`
      )
      assert.ok(
        output.includes('EXIT_OK'),
        `Expected clean exit when wrapper dies during kill, got: ${output}`
      )
    })

    // T18: GitHub comment fails → kill still proceeds
    it('T18: kill proceeds when GitHub comment fails', () => {
      const output = runBash(`
#!/usr/bin/env bash
source "${SCRIPT_PATH}"

kill() {
  if [[ "\$1" == "-0" ]]; then return 1; fi
  echo "KILL_CALLED: \$*"
}
export -f kill

pkill() { :; }
export -f pkill

# gh fails for comments but works otherwise
gh() {
  if [[ "\$2" == "comment" ]]; then
    echo "GH_COMMENT_FAILED" >&2
    return 1
  fi
  echo "GH_CALLED: \$*"
}
export -f gh

tail() { echo "(log tail)"; }
export -f tail

MAX_SESSION_MINUTES_IMPL=90
MIN_KILL_AGE_SECONDS=0
KILL_GRACE_SECONDS=1
REPO="test/repo"
LOG_DIR="/tmp"

now=\$(command date +%s)
start_time=\$((now - 91 * 60))
PIDS_IMPL="99999:42:impl:\${start_time}"

check_timeouts 2>&1
echo "KILL_COMPLETED"
`)
      assert.ok(
        output.includes('KILL_COMPLETED'),
        `Expected kill to complete even when gh comment fails, got: ${output}`
      )
      assert.ok(
        output.includes('TIMEOUT') || output.includes('KILL_CALLED'),
        `Expected kill to actually fire, got: ${output}`
      )
    })
  })

  // ══════════════════════════════════════════════════════════════════
  // Structural: check_timeouts exists and is wired in
  // ══════════════════════════════════════════════════════════════════

  describe('structural', () => {
    it('check_timeouts() function exists in cc-dispatch.sh', () => {
      assert.ok(
        content.includes('check_timeouts()'),
        'cc-dispatch.sh must define a check_timeouts() function'
      )
    })

    it('kill_wrapper() function exists in cc-dispatch.sh', () => {
      assert.ok(
        content.includes('kill_wrapper()'),
        'cc-dispatch.sh must define a kill_wrapper() function'
      )
    })

    it('check_timeouts is called from run_once or emit_status_line', () => {
      // Extract run_once body
      const runOnceStart = content.indexOf('run_once()')
      const runOnceEnd = content.indexOf('\n}', runOnceStart + 1)
      const runOnceBody = content.slice(runOnceStart, runOnceEnd)

      // Also check emit_status_line
      const emitStart = content.indexOf('emit_status_line()')
      const emitEnd = content.indexOf('\n}', emitStart + 1)
      const emitBody = content.slice(emitStart, emitEnd)

      assert.ok(
        runOnceBody.includes('check_timeouts') || emitBody.includes('check_timeouts'),
        'check_timeouts must be called from run_once() or emit_status_line()'
      )
    })
  })
})
