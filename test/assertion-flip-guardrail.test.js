import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execSync } from 'node:child_process'

const SCRIPT_PATH = path.resolve('scripts/check-assertion-flips.sh')
const DISPATCH_PATH = path.resolve('scripts/cc-dispatch.sh')

// Helper: run a bash snippet, returning stdout+stderr. Non-zero exits don't throw.
function runBash(script, { timeout = 10000 } = {}) {
  const tmpfile = path.join(os.tmpdir(), `af-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`)
  fs.writeFileSync(tmpfile, script)
  try {
    return execSync(`bash "${tmpfile}"`, { encoding: 'utf-8', timeout }).trim()
  } catch (e) {
    const out = [e.stdout, e.stderr].filter(Boolean).join('\n').trim()
    if (out) return out
    throw e
  } finally {
    fs.unlinkSync(tmpfile)
  }
}

// Helper: run check-assertion-flips.sh with stubbed git diff and git log output
function runCheck({ diffOutput = '', logOutput = '', extraArgs = '' } = {}) {
  const diffFile = path.join(os.tmpdir(), `af-diff-${Date.now()}.txt`)
  const logFile = path.join(os.tmpdir(), `af-log-${Date.now()}.txt`)
  fs.writeFileSync(diffFile, diffOutput)
  fs.writeFileSync(logFile, logOutput)
  try {
    return runBash(`
#!/usr/bin/env bash
# Stub git to return canned output
git() {
  case "\$1" in
    diff) cat "${diffFile}" ;;
    log)  cat "${logFile}" ;;
    *) command git "\$@" ;;
  esac
}
export -f git

bash "${SCRIPT_PATH}" --base origin/master --head HEAD ${extraArgs} 2>&1
echo "EXIT_CODE=\$?"
`, { timeout: 10000 })
  } finally {
    fs.unlinkSync(diffFile)
    fs.unlinkSync(logFile)
  }
}

describe('assertion-flip guardrail (#187)', () => {

  // ── Structural: script exists and is executable ──────────────────
  describe('script existence', () => {
    it('scripts/check-assertion-flips.sh exists and is executable', () => {
      assert.ok(fs.existsSync(SCRIPT_PATH),
        'scripts/check-assertion-flips.sh must exist')
      const stat = fs.statSync(SCRIPT_PATH)
      assert.ok(stat.mode & 0o111,
        'scripts/check-assertion-flips.sh must be executable')
    })

    it('--help returns exit 0', () => {
      const output = runBash(`bash "${SCRIPT_PATH}" --help 2>&1; echo "EXIT_CODE=$?"`)
      assert.ok(output.includes('EXIT_CODE=0'),
        `--help must exit 0. Output:\n${output}`)
    })
  })

  // ── Behavioral: fires when it should ─────────────────────────────
  describe('fires on assertion flip', () => {
    it('detects assertion flip in same hunk — exit non-zero, stderr contains ASSERTION-FLIP DETECTED', () => {
      const diff = `diff --git a/test/admin-auth.test.js b/test/admin-auth.test.js
index abc1234..def5678 100644
--- a/test/admin-auth.test.js
+++ b/test/admin-auth.test.js
@@ -45,7 +45,7 @@ describe('admin auth', () => {
   it('renders admin page', async () => {
     const res = await request(app).get('/admin')
-    assert.equal(res.statusCode, 200, 'admin page renders login form')
+    assert.equal(res.statusCode, 401, 'admin page returns unauthorized')
   })
 })`
      const output = runCheck({ diffOutput: diff })
      assert.ok(output.includes('ASSERTION-FLIP DETECTED'),
        `Must detect assertion flip. Output:\n${output}`)
      assert.ok(output.includes('EXIT_CODE=1'),
        `Must exit non-zero. Output:\n${output}`)
    })

    it('rejects empty BEHAVIOR-CHANGE: justification (nothing after colon)', () => {
      const diff = `diff --git a/test/admin-auth.test.js b/test/admin-auth.test.js
index abc1234..def5678 100644
--- a/test/admin-auth.test.js
+++ b/test/admin-auth.test.js
@@ -45,7 +45,7 @@ describe('admin auth', () => {
   it('renders admin page', async () => {
     const res = await request(app).get('/admin')
-    assert.equal(res.statusCode, 200, 'admin page renders login form')
+    assert.equal(res.statusCode, 401, 'admin page returns unauthorized')
   })
 })`
      const log = `abc1234 fix: update admin auth

BEHAVIOR-CHANGE:
`
      const output = runCheck({ diffOutput: diff, logOutput: log })
      assert.ok(output.includes('ASSERTION-FLIP DETECTED'),
        `Must reject empty BEHAVIOR-CHANGE. Output:\n${output}`)
      assert.ok(output.includes('EXIT_CODE=1'),
        `Must exit non-zero for empty justification. Output:\n${output}`)
    })
  })

  // ── Behavioral: does NOT fire ────────────────────────────────────
  describe('does not fire on legitimate changes', () => {
    it('exits 0 when diff has only new assertion lines (no removals)', () => {
      const diff = `diff --git a/test/new-feature.test.js b/test/new-feature.test.js
index abc1234..def5678 100644
--- a/test/new-feature.test.js
+++ b/test/new-feature.test.js
@@ -10,6 +10,8 @@ describe('new feature', () => {
   it('works', () => {
     const result = doThing()
+    assert.equal(result.status, 200)
+    assert.ok(result.body)
   })
 })`
      const output = runCheck({ diffOutput: diff })
      assert.ok(output.includes('EXIT_CODE=0'),
        `Must exit 0 for addition-only. Output:\n${output}`)
    })

    it('exits 0 when diff modifies only src/ files with assert. strings', () => {
      const diff = `diff --git a/src/middleware/auth.js b/src/middleware/auth.js
index abc1234..def5678 100644
--- a/src/middleware/auth.js
+++ b/src/middleware/auth.js
@@ -10,7 +10,7 @@ function checkAuth(req, res, next) {
-  // assert.equal for debug
+  // assert.ok for debug
   if (!token) return res.status(401).end()
 }`
      const output = runCheck({ diffOutput: diff })
      assert.ok(output.includes('EXIT_CODE=0'),
        `Must exit 0 for src-only changes. Output:\n${output}`)
    })

    it('exits 0 with valid BEHAVIOR-CHANGE: justification', () => {
      const diff = `diff --git a/test/admin-auth.test.js b/test/admin-auth.test.js
index abc1234..def5678 100644
--- a/test/admin-auth.test.js
+++ b/test/admin-auth.test.js
@@ -45,7 +45,7 @@ describe('admin auth', () => {
   it('renders admin page', async () => {
     const res = await request(app).get('/admin')
-    assert.equal(res.statusCode, 200, 'admin page renders login form')
+    assert.equal(res.statusCode, 401, 'admin page returns unauthorized')
   })
 })`
      const log = `abc1234 fix: add auth gate to admin page

BEHAVIOR-CHANGE: admin page now requires auth`
      const output = runCheck({ diffOutput: diff, logOutput: log })
      assert.ok(output.includes('EXIT_CODE=0'),
        `Must exit 0 with valid BEHAVIOR-CHANGE. Output:\n${output}`)
    })

    it('exits 0 with valid ASSERTION-REFACTOR: justification', () => {
      const diff = `diff --git a/test/admin-auth.test.js b/test/admin-auth.test.js
index abc1234..def5678 100644
--- a/test/admin-auth.test.js
+++ b/test/admin-auth.test.js
@@ -45,7 +45,7 @@ describe('admin auth', () => {
   it('renders admin page', async () => {
     const res = await request(app).get('/admin')
-    assert.equal(res.statusCode, 200, 'admin page renders login form')
+    assert.strictEqual(res.statusCode, 200, 'admin page renders login form')
   })
 })`
      const log = `abc1234 refactor: use strictEqual

ASSERTION-REFACTOR: rename res to response`
      const output = runCheck({ diffOutput: diff, logOutput: log })
      assert.ok(output.includes('EXIT_CODE=0'),
        `Must exit 0 with valid ASSERTION-REFACTOR. Output:\n${output}`)
    })
  })

  // ── Behavioral: hunk-level pairing ───────────────────────────────
  describe('hunk-level pairing', () => {
    it('exits 0 when one hunk deletes assertion and separate hunk adds unrelated assertion', () => {
      const diff = `diff --git a/test/admin-auth.test.js b/test/admin-auth.test.js
index abc1234..def5678 100644
--- a/test/admin-auth.test.js
+++ b/test/admin-auth.test.js
@@ -10,7 +10,6 @@ describe('admin auth', () => {
   it('old test', () => {
     const res = doOldThing()
-    assert.equal(res.statusCode, 200)
   })
 })
@@ -50,6 +49,7 @@ describe('new feature', () => {
   it('new test', () => {
     const result = doNewThing()
+    assert.ok(result.valid)
   })
 })`
      const output = runCheck({ diffOutput: diff })
      assert.ok(output.includes('EXIT_CODE=0'),
        `Must exit 0 for cross-hunk delete+add (not a flip). Output:\n${output}`)
    })
  })

  // ── Structural: cc-dispatch.sh integration ───────────────────────
  describe('cc-dispatch.sh integration', () => {
    const dispatchContent = fs.readFileSync(DISPATCH_PATH, 'utf-8')

    it('dispatch_implement invokes check-assertion-flips.sh BEFORE chain_next_stage', () => {
      // Extract dispatch_implement body
      const fnStart = dispatchContent.indexOf('dispatch_implement()')
      const fnEnd = dispatchContent.indexOf('\n}', fnStart + 1)
      const fnBody = dispatchContent.slice(fnStart, fnEnd)

      const checkPos = fnBody.indexOf('check-assertion-flips')
      assert.ok(checkPos !== -1,
        'dispatch_implement must invoke check-assertion-flips.sh')

      // In dispatch_implement, chain_next_stage happens inside _create_or_adopt_pr.
      // The check must appear before _create_or_adopt_pr call.
      const createPrPos = fnBody.indexOf('_create_or_adopt_pr')
      assert.ok(checkPos < createPrPos,
        'check-assertion-flips must run BEFORE _create_or_adopt_pr (which chains)')
    })

    it('dispatch_revise invokes check-assertion-flips.sh BEFORE chain_next_stage', () => {
      const fnStart = dispatchContent.indexOf('dispatch_revise()')
      const fnEnd = dispatchContent.indexOf('\n}', fnStart + 1)
      const fnBody = dispatchContent.slice(fnStart, fnEnd)

      const checkPos = fnBody.indexOf('check-assertion-flips')
      assert.ok(checkPos !== -1,
        'dispatch_revise must invoke check-assertion-flips.sh')

      const chainPos = fnBody.indexOf('chain_next_stage')
      assert.ok(checkPos < chainPos,
        'check-assertion-flips must run BEFORE chain_next_stage in dispatch_revise')
    })

    it('labels ready-for-revision when check exits non-zero (behavioral)', () => {
      // Structural check: dispatch_revise must contain logic that labels
      // ready-for-revision specifically due to assertion-flip check failure.
      // Look for the pattern: check-assertion-flips -> ready-for-revision
      const fnStart = dispatchContent.indexOf('dispatch_revise()')
      const fnEnd = dispatchContent.indexOf('\n}', fnStart + 1)
      const fnBody = dispatchContent.slice(fnStart, fnEnd)

      const checkPos = fnBody.indexOf('check-assertion-flips')
      assert.ok(checkPos !== -1,
        'dispatch_revise must call check-assertion-flips.sh')

      // After the check call, there must be a block that labels ready-for-revision
      // and returns/skips chain_next_stage
      const afterCheck = fnBody.slice(checkPos)
      assert.ok(
        afterCheck.includes('ready-for-revision') && afterCheck.includes('ASSERTION-FLIP'),
        'dispatch_revise must label ready-for-revision with ASSERTION-FLIP log on check failure')
    })
  })
})
