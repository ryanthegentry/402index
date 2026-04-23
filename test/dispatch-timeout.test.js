import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { runBash } from './helpers/run-bash.js'

const SCRIPT_PATH = path.resolve('scripts/cc-dispatch.sh')
const CONTRIBUTING_PATH = path.resolve('CONTRIBUTING.md')

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

    // T14: pkill -P $BASHPID kills only this wrapper's children, not siblings (#204)
    it('T14: pkill -P $BASHPID kills only this wrapper\'s children', () => {
      const spawnStart = content.indexOf('# Spawn handler in background subshell')
      const subshellEnd = content.indexOf(') &', spawnStart)
      const subshellBody = content.slice(spawnStart, subshellEnd)

      const pkillLines = subshellBody.split('\n').filter(l => /pkill\b.*-P\b/.test(l))
      assert.ok(pkillLines.length >= 2, `Must have at least 2 pkill -P lines (SIGTERM + SIGKILL), got ${pkillLines.length}`)

      for (const pkillLine of pkillLines) {
        assert.ok(
          pkillLine.includes('$BASHPID'),
          `pkill -P must target $BASHPID (this wrapper's children only, not siblings), got: ${pkillLine}`
        )
        assert.ok(
          !pkillLine.includes('$$'),
          `pkill -P must NOT use $$ — in a subshell $$ is the parent PID and would kill sibling wrappers, got: ${pkillLine}`
        )
      }
    })

    // T15: Behavioral sibling-survival test — exiting one subshell must not kill siblings (#204)
    // Uses `bash -c '...' &` so $$ resolves to the subshell's own PID (same as $BASHPID
    // would in a ( ... ) & subshell). This makes the test work on bash 3.2 (macOS default)
    // while validating the same scoped-kill semantics the $BASHPID fix provides.
    it('T15: exiting one subshell does not kill sibling subshells or their children', async () => {
      const pidFile = path.join(os.tmpdir(), `sibling-pids-${Date.now()}.txt`)
      const parentScript = path.join(os.tmpdir(), `sibling-parent-${Date.now()}.sh`)
      const childScript = path.join(os.tmpdir(), `sibling-child-${Date.now()}.sh`)

      // Child script: each invocation gets its own PID via $$, scoped kill via pkill -P $$
      fs.writeFileSync(childScript, `#!/bin/bash
trap 'pkill -P $$ 2>/dev/null; sleep 0.2; pkill -9 -P $$ 2>/dev/null' EXIT
sleep 10 &
child_pid=$!
echo "SUB\${1}_PID=$$ CHILD\${1}_PID=$child_pid" >> "\${2}"
sleep 30
`)
      fs.chmodSync(childScript, 0o755)

      // Parent script: spawns 3 child scripts in background
      fs.writeFileSync(parentScript, `#!/bin/bash
PIDFILE="${pidFile}"
> "\$PIDFILE"

for i in 1 2 3; do
  bash "${childScript}" "\$i" "\$PIDFILE" &
done

# Wait for all subshells to register
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  count=\$(wc -l < "\$PIDFILE" 2>/dev/null || echo 0)
  if [ "\$count" -ge 3 ] 2>/dev/null; then break; fi
  sleep 0.1
done

wait
`)
      fs.chmodSync(parentScript, 0o755)

      let sub1Pid, sub2Pid, sub3Pid, child1Pid, child2Pid, child3Pid
      const allPids = []

      try {
        // spawn bash directly — child scripts use $$ (not $BASHPID), so PATH-resolved bash is safe here. See L513-514.
        const proc = spawn('bash', [parentScript], { stdio: ['pipe', 'pipe', 'pipe'] })
        allPids.push(proc.pid)

        // Wait for PID file to be populated
        for (let i = 0; i < 40; i++) {
          await new Promise(r => setTimeout(r, 100))
          if (fs.existsSync(pidFile)) {
            const lines = fs.readFileSync(pidFile, 'utf-8').trim().split('\n').filter(Boolean)
            if (lines.length >= 3) break
          }
        }

        const pidContent = fs.readFileSync(pidFile, 'utf-8').trim()
        const lines = pidContent.split('\n').filter(Boolean)
        assert.ok(lines.length >= 3, `Expected 3 PID lines, got ${lines.length}: ${pidContent}`)

        for (const line of lines) {
          const subMatch = line.match(/SUB(\d+)_PID=(\d+)/)
          const childMatch = line.match(/CHILD(\d+)_PID=(\d+)/)
          if (subMatch && childMatch) {
            const idx = parseInt(subMatch[1])
            const sPid = parseInt(subMatch[2])
            const cPid = parseInt(childMatch[2])
            if (idx === 1) { sub1Pid = sPid; child1Pid = cPid }
            if (idx === 2) { sub2Pid = sPid; child2Pid = cPid }
            if (idx === 3) { sub3Pid = sPid; child3Pid = cPid }
            allPids.push(sPid, cPid)
          }
        }

        assert.ok(sub1Pid && sub2Pid && sub3Pid, 'All 3 subshell PIDs must be captured')
        assert.ok(child1Pid && child2Pid && child3Pid, 'All 3 child PIDs must be captured')

        // Kill subshell #1 — its EXIT trap should fire and kill only its own children
        process.kill(sub1Pid, 'SIGTERM')

        // Wait for trap to complete (generous margin for CI)
        await new Promise(r => setTimeout(r, 500))

        // Assert subshell #1's child is dead
        let child1Alive = true
        try { process.kill(child1Pid, 0) } catch { child1Alive = false }
        assert.ok(
          !child1Alive,
          `Subshell #1's child (PID ${child1Pid}) should be dead after its parent's EXIT trap fired`
        )

        // Assert subshells #2 and #3 are still alive
        let sub2Alive = false, sub3Alive = false
        try { process.kill(sub2Pid, 0); sub2Alive = true } catch {}
        try { process.kill(sub3Pid, 0); sub3Alive = true } catch {}
        assert.ok(sub2Alive, `Subshell #2 (PID ${sub2Pid}) must survive sibling #1's exit`)
        assert.ok(sub3Alive, `Subshell #3 (PID ${sub3Pid}) must survive sibling #1's exit`)

        // Assert children of #2 and #3 are still alive
        let child2Alive = false, child3Alive = false
        try { process.kill(child2Pid, 0); child2Alive = true } catch {}
        try { process.kill(child3Pid, 0); child3Alive = true } catch {}
        assert.ok(child2Alive, `Subshell #2's child (PID ${child2Pid}) must survive sibling #1's exit`)
        assert.ok(child3Alive, `Subshell #3's child (PID ${child3Pid}) must survive sibling #1's exit`)

        proc.kill('SIGTERM')
      } finally {
        for (const pid of allPids) {
          try { process.kill(pid, 'SIGKILL') } catch {}
        }
        try { fs.unlinkSync(parentScript) } catch {}
        try { fs.unlinkSync(childScript) } catch {}
        try { fs.unlinkSync(pidFile) } catch {}
      }
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
  // Revision 1 — reviewer feedback
  // ══════════════════════════════════════════════════════════════════

  describe('bash 3.x compatibility', () => {
    // R1: kill_wrapper must not use ${pool^^} (bash 4+ only)
    it('R1: kill_wrapper does not use bash 4+ uppercase syntax', () => {
      const killStart = content.indexOf('kill_wrapper()')
      assert.ok(killStart !== -1, 'kill_wrapper function must exist')
      const killEnd = content.indexOf('\n}', killStart + 1)
      const killBody = content.slice(killStart, killEnd)

      assert.ok(
        !killBody.includes('${pool^^}'),
        `kill_wrapper must not use \${pool^^} (bash 4+ only), found bash 4+ syntax in kill_wrapper body`
      )
    })
  })

  describe('post-timeout label handling', () => {
    // R2: After timeout, issue retains ready-for-revision label for re-dispatch
    it('R2: timeout leaves ready-for-revision label on issue for re-dispatch', () => {
      const output = runBash(`
#!/usr/bin/env bash
source "${SCRIPT_PATH}"

kill() {
  if [[ "\$1" == "-0" ]]; then return 1; fi
}
export -f kill

pkill() { :; }
export -f pkill

gh_calls=""
gh() {
  gh_calls="\${gh_calls}|GH:\$*"
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
echo "GH_CALLS:\$gh_calls"
`)
      // Must add ready-for-revision
      assert.ok(
        output.includes('--add-label') && output.includes('ready-for-revision'),
        `Expected ready-for-revision label to be added, got: ${output}`
      )
      // Must NOT immediately remove it (issue needs to stay in pipeline)
      // Check all output lines for a gh call that removes the ready-for-revision label
      const removesRevision = output.split('\n').some(l =>
        l.includes('GH') && l.includes('--remove-label') && l.includes('ready-for-revision')
      )
      assert.ok(
        !removesRevision,
        `ready-for-revision label must NOT be removed after timeout — issue would be dropped from pipeline. Got: ${output}`
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
