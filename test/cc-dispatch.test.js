import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const SCRIPT_PATH = path.resolve('scripts/cc-dispatch.sh')

// Helper: source the script functions (without running main) and call a function
function callBashFn(fnName, args = '') {
  // We source the script but override ensure_deps/ensure_labels and skip the entry point
  // by wrapping in a subshell that returns before the main execution
  const bash = `
    # Stub out functions that need external deps
    ensure_deps() { :; }
    ensure_labels() { :; }
    REPO="test/repo"
    REPO_DIR="/tmp"
    LOG_DIR="/tmp"
    DEFAULT_BRANCH="master"
    DRY_RUN=true
    WATCH=false

    # Source only the functions (not the entry point)
    # We extract functions via eval trick: source the script but override the tail
    eval "$(sed -n '1,/^# ── Entry point/p' '${SCRIPT_PATH}' | head -n -1)"

    ${fnName} ${args}
  `
  try {
    return execSync(`bash -c '${bash.replace(/'/g, "'\\''")}'`, {
      encoding: 'utf-8',
      timeout: 5000
    }).trim()
  } catch (e) {
    return e.stdout?.trim() || ''
  }
}

// Better helper that uses heredoc to avoid quoting issues
function callFn(fnName, ...args) {
  const quotedArgs = args.map(a => `"${a}"`).join(' ')
  const script = `
ensure_deps() { :; }
ensure_labels() { :; }
REPO="test/repo"
REPO_DIR="/tmp"
LOG_DIR="/tmp"
DEFAULT_BRANCH="master"
DRY_RUN=true
WATCH=false

# Source functions only — stop before entry point
eval "$(awk '/^# ── Entry point/{exit} {print}' '${SCRIPT_PATH}')"

${fnName} ${quotedArgs}
`
  const tmpfile = path.join(os.tmpdir(), `cc-dispatch-test-${Date.now()}.sh`)
  fs.writeFileSync(tmpfile, script)
  try {
    return execSync(`bash "${tmpfile}"`, { encoding: 'utf-8', timeout: 5000 }).trim()
  } catch (e) {
    return e.stdout?.trim() || ''
  } finally {
    fs.unlinkSync(tmpfile)
  }
}

describe('cc-dispatch.sh', () => {
  // ── Pure function tests ──────────────────────────────────────────

  describe('get_agent()', () => {
    const expected = {
      'ready-for-chore': '',
      'ready-for-impl': 'implementer',
      'ready-for-red-team': 'red-team',
      'ready-for-security': 'security-reviewer',
      'ready-for-qa': 'qa-reviewer',
      'ready-for-revision': 'implementer'
    }
    for (const [label, agent] of Object.entries(expected)) {
      it(`returns "${agent || '(empty)'}" for ${label}`, () => {
        const result = callFn('get_agent', label)
        assert.equal(result, agent)
      })
    }
  })

  describe('get_mode()', () => {
    const expected = {
      'ready-for-chore': 'implement',
      'ready-for-impl': 'implement',
      'ready-for-red-team': 'review-issue',
      'ready-for-security': 'review-pr',
      'ready-for-qa': 'review-pr',
      'ready-for-revision': 'revise'
    }
    for (const [label, mode] of Object.entries(expected)) {
      it(`returns "${mode}" for ${label}`, () => {
        const result = callFn('get_mode', label)
        assert.equal(result, mode)
      })
    }
  })

  describe('get_done_label()', () => {
    const expected = {
      'ready-for-chore': 'needs-review',
      'ready-for-impl': '',
      'ready-for-red-team': 'red-team-complete',
      'ready-for-security': '',
      'ready-for-qa': '',
      'ready-for-revision': ''
    }
    for (const [label, done] of Object.entries(expected)) {
      it(`returns "${done || '(empty)'}" for ${label}`, () => {
        const result = callFn('get_done_label', label)
        assert.equal(result, done)
      })
    }
  })

  describe('get_next_stage_label()', () => {
    const expected = {
      'ready-for-red-team': '',    // human gate
      'ready-for-impl': 'ready-for-security',
      'ready-for-chore': 'ready-for-security',
      'ready-for-security': 'ready-for-qa',
      'ready-for-qa': 'ready-to-merge',
      'ready-for-revision': 'ready-for-security'
    }
    for (const [label, next] of Object.entries(expected)) {
      it(`returns "${next || '(empty, human gate)'}" for ${label}`, () => {
        const result = callFn('get_next_stage_label', label)
        assert.equal(result, next)
      })
    }
  })

  // ── No stale references ──────────────────────────────────────────

  describe('no stale references', () => {
    it('has no ready-for-cc references in the script', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const matches = content.match(/ready-for-cc/g)
      assert.equal(matches, null, 'Found stale ready-for-cc references')
    })
  })

  // ── DISPATCH_LABELS array ────────────────────────────────────────

  describe('DISPATCH_LABELS', () => {
    it('includes ready-for-revision', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      assert.ok(content.includes('ready-for-revision'), 'DISPATCH_LABELS missing ready-for-revision')
    })

    it('includes all 6 dispatch labels', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const labels = [
        'ready-for-chore', 'ready-for-impl', 'ready-for-red-team',
        'ready-for-security', 'ready-for-qa', 'ready-for-revision'
      ]
      for (const label of labels) {
        assert.ok(content.includes(label), `Missing label: ${label}`)
      }
    })
  })

  // ── ensure_labels() ──────────────────────────────────────────────

  describe('ensure_labels()', () => {
    it('function exists in the script', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      assert.ok(content.includes('ensure_labels()'), 'ensure_labels() function missing')
    })

    it('creates ready-to-merge label', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      assert.ok(
        content.includes('ready-to-merge') && content.includes('gh label create'),
        'ensure_labels must create ready-to-merge via gh label create'
      )
    })

    it('creates ready-for-revision label', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      // Check that ready-for-revision appears in the ensure_labels function
      const ensureLabelsSection = content.slice(content.indexOf('ensure_labels()'))
      assert.ok(
        ensureLabelsSection.includes('ready-for-revision'),
        'ensure_labels must create ready-for-revision label'
      )
    })

    it('creates needs-manual-review label', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const ensureLabelsSection = content.slice(content.indexOf('ensure_labels()'))
      assert.ok(
        ensureLabelsSection.includes('needs-manual-review'),
        'ensure_labels must create needs-manual-review label'
      )
    })

    it('uses --force for idempotency', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const ensureLabelsSection = content.slice(content.indexOf('ensure_labels()'))
      assert.ok(
        ensureLabelsSection.includes('--force'),
        'ensure_labels must use --force for idempotent label creation'
      )
    })

    it('is called at startup', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      // ensure_labels should be called in the entry point section (after ensure_deps)
      const entryPoint = content.slice(content.indexOf('# ── Entry point'))
      assert.ok(
        entryPoint.includes('ensure_labels'),
        'ensure_labels must be called at startup (entry point section)'
      )
    })
  })

  // ── dispatch_issue router ────────────────────────────────────────

  describe('dispatch_issue router', () => {
    it('has revise case in the mode switch', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      assert.ok(content.includes('revise)'), 'dispatch_issue must route revise mode')
    })
  })

  // ── dispatch_review_issue posts to ISSUE ─────────────────────────

  describe('dispatch_review_issue', () => {
    it('script posts agent output as issue comment via --body-file', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      // Extract dispatch_review_issue function body
      const fnStart = content.indexOf('dispatch_review_issue()')
      const fnEnd = content.indexOf('\n# ── ', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)

      // Script must post the agent's output (agent can't reliably post in --print mode)
      assert.ok(
        fnBody.includes('gh issue comment'),
        'dispatch_review_issue must post agent output as issue comment'
      )
      assert.ok(
        fnBody.includes('--body-file'),
        'dispatch_review_issue must use --body-file for safe posting'
      )
    })

    it('does not use fragile bot-detection timestamp logic', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_review_issue()')
      const fnEnd = content.indexOf('\n# ── ', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)

      assert.ok(
        !fnBody.includes('402index-bot'),
        'dispatch_review_issue must not use fragile bot-detection logic'
      )
      assert.ok(
        !fnBody.includes('session_start'),
        'dispatch_review_issue must not use timestamp comparison logic'
      )
    })
  })

  // ── dispatch_review_pr posts to PR ───────────────────────────────

  describe('dispatch_review_pr', () => {
    it('posts review via submit_review (script-side, not agent-side)', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_review_pr()')
      const fnEnd = content.indexOf('\n# ── ', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)

      assert.ok(
        fnBody.includes('submit_review'),
        'dispatch_review_pr must use submit_review for deterministic review posting'
      )
    })

    it('parses verdict from CC output (not GitHub API)', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_review_pr()')
      const fnEnd = content.indexOf('\n# ── ', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)

      assert.ok(
        fnBody.includes('parse_verdict_from_output'),
        'dispatch_review_pr must parse verdict from CC output'
      )
    })

    it('collects formal reviews (not just comments)', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_review_pr()')
      const fnEnd = content.indexOf('\n# ── ', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)

      assert.ok(
        fnBody.includes('comments,reviews'),
        'dispatch_review_pr must collect both comments and formal reviews from PR'
      )
    })

    it('collects issue comments (where red-team posted)', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_review_pr()')
      const fnEnd = content.indexOf('\n# ── ', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)

      assert.ok(
        fnBody.includes('gh issue view') && fnBody.includes('issue comment'),
        'dispatch_review_pr must collect issue comments where red-team posted'
      )
    })

    it('does not use fragile bot-detection logic', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_review_pr()')
      const fnEnd = content.indexOf('\n# ── ', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)

      assert.ok(
        !fnBody.includes('402index-bot'),
        'dispatch_review_pr must not use fragile bot-detection logic'
      )
    })
  })

  // ── dispatch_review_pr verdict detection ─────────────────────────

  describe('review verdict detection', () => {
    it('parse_verdict_from_output returns APPROVED for VERDICT:APPROVE marker', () => {
      const result = callFn('parse_verdict_from_output', 'Some review text\nVERDICT:APPROVE', '999')
      assert.equal(result, 'APPROVED')
    })

    it('parse_verdict_from_output returns CHANGES_REQUESTED for VERDICT:REQUEST_CHANGES marker', () => {
      const result = callFn('parse_verdict_from_output', 'Some review text\nVERDICT:REQUEST_CHANGES', '999')
      assert.equal(result, 'CHANGES_REQUESTED')
    })

    it('parse_verdict_from_output falls back to keyword matching', () => {
      const result = callFn('parse_verdict_from_output', 'QA Review: APPROVED\nAll tests pass.', '999')
      assert.equal(result, 'APPROVED')
    })

    it('parse_verdict_from_output prefers REQUEST_CHANGES over APPROVED in keyword fallback', () => {
      const result = callFn('parse_verdict_from_output', 'Some things APPROVED but also CHANGES REQUESTED for demo.js', '999')
      assert.equal(result, 'CHANGES_REQUESTED')
    })

    it('parse_verdict_from_output and submit_review functions exist', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      assert.ok(
        content.includes('parse_verdict_from_output'),
        'parse_verdict_from_output function must exist for verdict parsing'
      )
      assert.ok(
        content.includes('submit_review'),
        'submit_review function must exist for deterministic review posting'
      )
    })

    it('dispatch_review_pr chains to ready-for-revision on CHANGES_REQUESTED', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_review_pr()')
      const fnEnd = content.indexOf('\n# ── ', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)

      assert.ok(
        fnBody.includes('ready-for-revision'),
        'dispatch_review_pr must route to ready-for-revision on changes requested'
      )
    })

    it('dispatch_review_pr uses verdict to decide chaining', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_review_pr()')
      const fnEnd = content.indexOf('\n# ── ', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)

      assert.ok(
        fnBody.includes('APPROVED'),
        'dispatch_review_pr must check for APPROVED verdict before chaining to next stage'
      )
    })
  })

  // ── dispatch_revise ──────────────────────────────────────────────

  describe('dispatch_revise()', () => {
    it('function exists', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      assert.ok(content.includes('dispatch_revise()'), 'dispatch_revise function must exist')
    })

    it('checks out existing branch (not creates new)', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_revise()')
      const fnEnd = content.indexOf('\n# ── ', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)

      // Should checkout existing branch, NOT create new one
      assert.ok(
        fnBody.includes('headRefName'),
        'dispatch_revise must get existing branch name from PR'
      )
      assert.ok(
        !fnBody.includes('git checkout -b'),
        'dispatch_revise must NOT create a new branch'
      )
    })

    it('does NOT create a new PR', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_revise()')
      const fnEnd = content.indexOf('\n# ── ', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)

      assert.ok(
        !fnBody.includes('gh pr create'),
        'dispatch_revise must NOT create a new PR'
      )
    })

    it('reads review feedback and includes in prompt', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_revise()')
      const fnEnd = content.indexOf('\n# ── ', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)

      assert.ok(
        fnBody.includes('review_feedback') || fnBody.includes('REVIEWER FEEDBACK'),
        'dispatch_revise must include review feedback in the CC prompt'
      )
    })

    it('pushes to existing branch', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_revise()')
      const fnEnd = content.indexOf('\n# ── ', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)

      assert.ok(
        fnBody.includes('git push'),
        'dispatch_revise must push to the existing branch'
      )
    })

    it('has MAX_REVISIONS safety valve', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      assert.ok(
        content.includes('MAX_REVISIONS'),
        'MAX_REVISIONS constant must exist for revision loop safety'
      )
    })

    it('bails to needs-manual-review after MAX_REVISIONS', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_revise()')
      const fnEnd = content.indexOf('\n# ── ', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)

      assert.ok(
        fnBody.includes('needs-manual-review'),
        'dispatch_revise must bail to needs-manual-review after max revisions'
      )
    })

    it('tracks revision count via GitHub events API', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_revise()')
      const fnEnd = content.indexOf('\n# ── ', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)

      assert.ok(
        fnBody.includes('ready-for-revision') && fnBody.includes('gh api'),
        'dispatch_revise must count revisions via GitHub events API'
      )
    })

    it('chains back to ready-for-security after revision', () => {
      const result = callFn('get_next_stage_label', 'ready-for-revision')
      assert.equal(result, 'ready-for-security')
    })

    it('posts revision summary to PR via --body-file', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_revise()')
      const fnEnd = content.indexOf('\n# ── ', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)

      assert.ok(
        fnBody.includes('--body-file'),
        'dispatch_revise must post revision summary via --body-file'
      )
    })
  })

  // ── dispatch_revise no-change gate ────────────────────────────────

  describe('dispatch_revise no-change gate', () => {
    it('records HEAD before CC run', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_revise()')
      const fnEnd = content.indexOf('\n# ── ', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)

      // head_before capture must appear before the CC execution block
      const headBeforeIdx = fnBody.indexOf('head_before')
      const ccRunIdx = fnBody.indexOf('claude --print')
      assert.ok(headBeforeIdx !== -1, 'dispatch_revise must capture head_before via rev-parse HEAD')
      assert.ok(headBeforeIdx < ccRunIdx, 'head_before must be captured before CC execution')
    })

    it('gates chain_next_stage on actual changes', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_revise()')
      const fnEnd = content.indexOf('\n# ── ', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)

      // chain_next_stage must appear after a HEAD comparison guard
      const headCompareIdx = fnBody.indexOf('head_before')
      const chainIdx = fnBody.indexOf('chain_next_stage')
      assert.ok(headCompareIdx !== -1 && headCompareIdx < chainIdx,
        'chain_next_stage must be gated behind HEAD comparison check')
    })

    it('rolls back when no changes pushed', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_revise()')
      const fnEnd = content.indexOf('\n# ── ', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)

      // After git push, there must be a path that checks head_before == head_after and calls rollback_issue
      const pushIdx = fnBody.indexOf('git push')
      const afterPush = fnBody.slice(pushIdx)
      assert.ok(
        afterPush.includes('head_before') && afterPush.includes('rollback_issue'),
        'dispatch_revise must rollback when revision produces no changes'
      )
    })

    it('does not post comment when no changes', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_revise()')
      const fnEnd = content.indexOf('\n# ── ', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)

      // The --body-file comment block must appear after the HEAD comparison gate
      const headAfterIdx = fnBody.indexOf('head_after')
      const bodyFileIdx = fnBody.indexOf('--body-file')
      assert.ok(headAfterIdx !== -1, 'dispatch_revise must check head_after')
      assert.ok(headAfterIdx < bodyFileIdx,
        'PR comment (--body-file) must come after HEAD comparison gate')
    })
  })

  // ── chain_next_stage human gate ──────────────────────────────────

  describe('chain_next_stage', () => {
    it('does NOT chain after ready-for-red-team (human gate)', () => {
      const result = callFn('get_next_stage_label', 'ready-for-red-team')
      assert.equal(result, '', 'Red-team must not auto-chain (human gate)')
    })
  })

  // ── Empty output guard ───────────────────────────────────────────

  describe('empty output guard', () => {
    it('dispatch_review_issue posts via --body-file and guards empty output', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_review_issue()')
      const fnEnd = content.indexOf('\n# ── ', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)

      // Script posts agent output via tmpfile (agent can't reliably post in --print mode)
      assert.ok(
        fnBody.includes('--body-file'),
        'dispatch_review_issue must use --body-file for posting'
      )
      // Must guard against empty output
      assert.ok(
        fnBody.includes('CC produced empty output'),
        'dispatch_review_issue must guard against empty agent output'
      )
    })

    it('dispatch_review_pr checks for empty output before posting', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_review_pr()')
      const fnEnd = content.indexOf('\n# ── ', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)

      assert.ok(
        fnBody.includes('-s "$tmpfile"'),
        'dispatch_review_pr must check for empty output before posting'
      )
    })
  })

  // ── Commit status check (dispatch/review) ────────────────────────

  describe('set_review_status()', () => {
    it('function exists in the script', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      assert.ok(content.includes('set_review_status()'), 'set_review_status() function must exist')
    })

    it('uses dispatch/review as context string', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('set_review_status()')
      const fnEnd = content.indexOf('\n}', fnStart) + 2
      const fnBody = content.slice(fnStart, fnEnd)

      assert.ok(
        fnBody.includes('dispatch/review'),
        'set_review_status must use dispatch/review as status context'
      )
    })

    it('uses || true to avoid blocking pipeline', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('set_review_status()')
      const fnEnd = content.indexOf('\n}', fnStart) + 2
      const fnBody = content.slice(fnStart, fnEnd)

      assert.ok(
        fnBody.includes('|| true'),
        'set_review_status must use || true to avoid blocking pipeline on API failure'
      )
    })

    it('calls gh api repos/.../statuses/...', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('set_review_status()')
      const fnEnd = content.indexOf('\n}', fnStart) + 2
      const fnBody = content.slice(fnStart, fnEnd)

      assert.ok(
        fnBody.includes('gh api') && fnBody.includes('statuses'),
        'set_review_status must call GitHub statuses API via gh api'
      )
    })
  })

  describe('dispatch_review_pr status calls', () => {
    it('sets pending status before CC runs', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_review_pr()')
      const fnEnd = content.indexOf('\n# ── ', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)

      // pending must appear before claude --print
      const pendingIdx = fnBody.indexOf('set_review_status')
      const claudeIdx = fnBody.indexOf('claude --print')
      assert.ok(pendingIdx !== -1, 'dispatch_review_pr must call set_review_status')
      assert.ok(pendingIdx < claudeIdx, 'pending status must be set before CC runs')
    })

    it('sets failure status and review-failed label when CC crashes', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_review_pr()')
      const fnEnd = content.indexOf('\n# ── ', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)

      // Find the CC exit check block
      const exitBlock = fnBody.slice(fnBody.indexOf('cc_exit'))
      assert.ok(
        exitBlock.includes('set_review_status') && exitBlock.includes('failure'),
        'dispatch_review_pr must set failure status when CC crashes'
      )
      assert.ok(
        exitBlock.includes('review-failed'),
        'dispatch_review_pr must add review-failed label when CC crashes'
      )
    })

    it('sets success status after successful review', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_review_pr()')
      const fnEnd = content.indexOf('\n# ── ', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)

      // success status should appear after submit_review
      const submitIdx = fnBody.indexOf('submit_review')
      const afterSubmit = fnBody.slice(submitIdx)
      assert.ok(
        afterSubmit.includes('success'),
        'dispatch_review_pr must set success status after review submission'
      )
    })

    it('sets error status if submit_review fails', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_review_pr()')
      const fnEnd = content.indexOf('\n# ── ', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)

      assert.ok(
        fnBody.includes('error') && fnBody.includes('set_review_status'),
        'dispatch_review_pr must set error status if submit_review fails'
      )
    })
  })

  // ── review-failed label ─────────────────────────────────────────

  describe('review-failed label', () => {
    it('is created in ensure_labels()', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const ensureLabelsSection = content.slice(content.indexOf('ensure_labels()'))
      assert.ok(
        ensureLabelsSection.includes('review-failed'),
        'ensure_labels must create review-failed label'
      )
    })

    it('is added to PR (not issue) on CC crash', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_review_pr()')
      const fnEnd = content.indexOf('\n# ── ', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)

      assert.ok(
        fnBody.includes('gh pr edit') && fnBody.includes('review-failed'),
        'review-failed label must be added to PR via gh pr edit'
      )
    })
  })

  // ── Reviewer prompt augmentation ────────────────────────────────

  describe('reviewer prompt augmentation', () => {
    it('includes integration test requirement for src/queries/ changes', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_review_pr()')
      const fnEnd = content.indexOf('\n# ── ', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)

      assert.ok(
        fnBody.includes('src/queries/') && fnBody.includes('integration test'),
        'reviewer prompt must require integration tests for query-layer changes'
      )
    })

    it('includes TDD compliance check instruction', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_review_pr()')
      const fnEnd = content.indexOf('\n# ── ', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)

      assert.ok(
        fnBody.includes('TDD') && fnBody.includes('test'),
        'reviewer prompt must include TDD compliance check instruction'
      )
    })

    it('augmentation appears after existing prompt, before VERDICT format', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_review_pr()')
      const fnEnd = content.indexOf('\n# ── ', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)

      const additionalIdx = fnBody.indexOf('ADDITIONAL REVIEW REQUIREMENTS')
      const verdictIdx = fnBody.indexOf('VERDICT')
      assert.ok(additionalIdx !== -1, 'must have ADDITIONAL REVIEW REQUIREMENTS section')
      assert.ok(additionalIdx < verdictIdx, 'additional requirements must appear before VERDICT format')
    })
  })

  // ── Review status edge cases ─────────────────────────────────────

  describe('review status edge cases', () => {
    it('submit_review() ends with $review_ok', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('submit_review()')
      const fnEnd = content.indexOf('\n}', fnStart)
      const fnBody = content.slice(fnStart, fnEnd)
      const lines = fnBody.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'))
      const lastLine = lines[lines.length - 1].trim()
      assert.strictEqual(lastLine, '$review_ok', 'last executable line of submit_review() must be $review_ok')
    })

    it('submit_review() initializes review_ok=false', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('submit_review()')
      const fnEnd = content.indexOf('\n}', fnStart)
      const fnBody = content.slice(fnStart, fnEnd)
      assert.ok(fnBody.includes('review_ok=false'), 'submit_review() must initialize review_ok=false')
    })

    it('empty review body aborts the review chain', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_review_pr()')
      const fnEnd = content.indexOf('\n# ── ', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)
      // Find the else branch of [ -s "$tmpfile" ]
      const sCheckIdx = fnBody.indexOf('[ -s "$tmpfile" ]')
      const elseBranch = fnBody.slice(sCheckIdx)
      const elseIdx = elseBranch.indexOf('else')
      const fiIdx = elseBranch.indexOf('\n    fi', elseIdx)
      const elseBlock = elseBranch.slice(elseIdx, fiIdx)
      assert.ok(
        elseBlock.includes('rollback_issue') || elseBlock.includes('return'),
        'empty review body else branch must abort via rollback_issue or return'
      )
    })

    it('empty review body cleans up tmpfile before returning', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_review_pr()')
      const fnEnd = content.indexOf('\n# ── ', fnStart + 1)
      const fnBody = content.slice(fnStart, fnEnd)
      const sCheckIdx = fnBody.indexOf('[ -s "$tmpfile" ]')
      const elseBranch = fnBody.slice(sCheckIdx)
      const elseIdx = elseBranch.indexOf('else')
      const fiIdx = elseBranch.indexOf('\n    fi', elseIdx)
      const elseBlock = elseBranch.slice(elseIdx, fiIdx)
      const rmIdx = elseBlock.indexOf('rm -f "$tmpfile"')
      const returnIdx = elseBlock.indexOf('return')
      assert.ok(rmIdx !== -1, 'else branch must rm -f "$tmpfile"')
      assert.ok(returnIdx !== -1, 'else branch must return')
      assert.ok(rmIdx < returnIdx, 'rm -f "$tmpfile" must appear before return')
    })
  })

  // ── Fix 2: CC output logging (two-file pattern) ─────────────────

  describe('CC output logging', () => {
    it('does NOT use tee-in-command-substitution for CC execution', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      // The broken pattern: cc_output=$(... | tee "$logfile")
      const teeCapture = content.match(/cc_output=\$\(.*\|\s*tee\b/g)
      assert.equal(teeCapture, null, 'Must not use tee inside command substitution for CC output')
    })

    it('writes CC output to .out temp file', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      assert.ok(
        content.includes('${logfile}.out'),
        'Must use ${logfile}.out as temp file for raw CC output'
      )
    })

    it('reads cc_output from .out file (not from tee)', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      assert.ok(
        content.includes('cc_output=$(cat "${logfile}.out")'),
        'cc_output must be read from .out temp file'
      )
    })

    it('cleans up .out temp file after reading', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      assert.ok(
        content.includes('rm -f "${logfile}.out"'),
        'Must clean up .out temp file after reading into cc_output'
      )
    })

    it('writes session header to logfile before CC execution', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      assert.ok(
        content.includes('=== CC Session ==='),
        'Logfile must contain session header'
      )
      assert.ok(
        content.includes('=== Prompt ==='),
        'Logfile must contain prompt section header'
      )
      assert.ok(
        content.includes('=== Output ==='),
        'Logfile must contain output section header'
      )
    })

    it('appends raw CC output to logfile (header + output in one file)', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      assert.ok(
        content.includes('cat "${logfile}.out" >> "$logfile"'),
        'Must append .out contents to logfile for full debug log'
      )
    })

    it('all four handlers use the two-file pattern', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const handlers = ['dispatch_implement', 'dispatch_review_issue', 'dispatch_review_pr', 'dispatch_revise']
      for (const handler of handlers) {
        const fnStart = content.indexOf(`${handler}()`)
        const fnEnd = content.indexOf('\n# ── ', fnStart + 1)
        const fnBody = fnEnd !== -1 ? content.slice(fnStart, fnEnd) : content.slice(fnStart, fnStart + 3000)

        assert.ok(
          fnBody.includes('${logfile}.out'),
          `${handler} must use two-file logging pattern`
        )
        assert.ok(
          !fnBody.match(/cc_output=\$\(.*\|\s*tee\b/),
          `${handler} must not use tee-in-command-substitution`
        )
      }
    })
  })

  // ── Fix 3: CC output validation and retry ────────────────────────

  describe('CC output validation', () => {
    it('validate_cc_output function exists', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      assert.ok(content.includes('validate_cc_output()'), 'validate_cc_output() function must exist')
    })

    it('detects API errors as transient failures', () => {
      const result = callFn('validate_cc_output', 'API Error: overloaded_error', 'review-pr')
      // VALIDATION_OK should be false, VALIDATION_TRANSIENT should be true
      // We test by checking the global vars after the call
      const script = `
ensure_deps() { :; }
ensure_labels() { :; }
REPO="test/repo"
REPO_DIR="/tmp"
LOG_DIR="/tmp"
DEFAULT_BRANCH="master"
DRY_RUN=true
WATCH=false
eval "$(awk '/^# ── Entry point/{exit} {print}' '${SCRIPT_PATH}')"
validate_cc_output "API Error: overloaded_error" "review-pr"
echo "OK=\$VALIDATION_OK TRANSIENT=\$VALIDATION_TRANSIENT"
`
      const tmpfile = path.join(os.tmpdir(), `cc-test-${Date.now()}.sh`)
      fs.writeFileSync(tmpfile, script)
      try {
        const out = execSync(`bash "${tmpfile}"`, { encoding: 'utf-8', timeout: 5000 }).trim()
        assert.ok(out.includes('OK=false'), 'API error must set VALIDATION_OK=false')
        assert.ok(out.includes('TRANSIENT=true'), 'API error must set VALIDATION_TRANSIENT=true')
      } finally {
        fs.unlinkSync(tmpfile)
      }
    })

    it('detects empty output as non-transient failure', () => {
      const script = `
ensure_deps() { :; }
ensure_labels() { :; }
REPO="test/repo"
REPO_DIR="/tmp"
LOG_DIR="/tmp"
DEFAULT_BRANCH="master"
DRY_RUN=true
WATCH=false
eval "$(awk '/^# ── Entry point/{exit} {print}' '${SCRIPT_PATH}')"
validate_cc_output "" "review-pr"
echo "OK=\$VALIDATION_OK TRANSIENT=\$VALIDATION_TRANSIENT"
`
      const tmpfile = path.join(os.tmpdir(), `cc-test-${Date.now()}.sh`)
      fs.writeFileSync(tmpfile, script)
      try {
        const out = execSync(`bash "${tmpfile}"`, { encoding: 'utf-8', timeout: 5000 }).trim()
        assert.ok(out.includes('OK=false'), 'Empty output must set VALIDATION_OK=false')
        assert.ok(out.includes('TRANSIENT=false'), 'Empty output must set VALIDATION_TRANSIENT=false')
      } finally {
        fs.unlinkSync(tmpfile)
      }
    })

    it('requires VERDICT line for review-pr mode', () => {
      const script = `
ensure_deps() { :; }
ensure_labels() { :; }
REPO="test/repo"
REPO_DIR="/tmp"
LOG_DIR="/tmp"
DEFAULT_BRANCH="master"
DRY_RUN=true
WATCH=false
eval "$(awk '/^# ── Entry point/{exit} {print}' '${SCRIPT_PATH}')"
validate_cc_output "Some review text without verdict" "review-pr"
echo "OK=\$VALIDATION_OK TRANSIENT=\$VALIDATION_TRANSIENT"
`
      const tmpfile = path.join(os.tmpdir(), `cc-test-${Date.now()}.sh`)
      fs.writeFileSync(tmpfile, script)
      try {
        const out = execSync(`bash "${tmpfile}"`, { encoding: 'utf-8', timeout: 5000 }).trim()
        assert.ok(out.includes('OK=false'), 'review-pr without VERDICT must set VALIDATION_OK=false')
      } finally {
        fs.unlinkSync(tmpfile)
      }
    })

    it('passes review-pr with VERDICT:APPROVE', () => {
      const script = `
ensure_deps() { :; }
ensure_labels() { :; }
REPO="test/repo"
REPO_DIR="/tmp"
LOG_DIR="/tmp"
DEFAULT_BRANCH="master"
DRY_RUN=true
WATCH=false
eval "$(awk '/^# ── Entry point/{exit} {print}' '${SCRIPT_PATH}')"
validate_cc_output "Good review text
VERDICT:APPROVE" "review-pr"
echo "OK=\$VALIDATION_OK TRANSIENT=\$VALIDATION_TRANSIENT"
`
      const tmpfile = path.join(os.tmpdir(), `cc-test-${Date.now()}.sh`)
      fs.writeFileSync(tmpfile, script)
      try {
        const out = execSync(`bash "${tmpfile}"`, { encoding: 'utf-8', timeout: 5000 }).trim()
        assert.ok(out.includes('OK=true'), 'review-pr with VERDICT:APPROVE must set VALIDATION_OK=true')
      } finally {
        fs.unlinkSync(tmpfile)
      }
    })

    it('requires markdown content for review-issue mode', () => {
      const script = `
ensure_deps() { :; }
ensure_labels() { :; }
REPO="test/repo"
REPO_DIR="/tmp"
LOG_DIR="/tmp"
DEFAULT_BRANCH="master"
DRY_RUN=true
WATCH=false
eval "$(awk '/^# ── Entry point/{exit} {print}' '${SCRIPT_PATH}')"
validate_cc_output "plain text no markdown" "review-issue"
echo "OK=\$VALIDATION_OK TRANSIENT=\$VALIDATION_TRANSIENT"
`
      const tmpfile = path.join(os.tmpdir(), `cc-test-${Date.now()}.sh`)
      fs.writeFileSync(tmpfile, script)
      try {
        const out = execSync(`bash "${tmpfile}"`, { encoding: 'utf-8', timeout: 5000 }).trim()
        assert.ok(out.includes('OK=false'), 'review-issue without markdown must set VALIDATION_OK=false')
      } finally {
        fs.unlinkSync(tmpfile)
      }
    })

    it('passes review-issue with markdown headers', () => {
      const script = `
ensure_deps() { :; }
ensure_labels() { :; }
REPO="test/repo"
REPO_DIR="/tmp"
LOG_DIR="/tmp"
DEFAULT_BRANCH="master"
DRY_RUN=true
WATCH=false
eval "$(awk '/^# ── Entry point/{exit} {print}' '${SCRIPT_PATH}')"
validate_cc_output "# Security Findings
- Issue 1
- Issue 2" "review-issue"
echo "OK=\$VALIDATION_OK TRANSIENT=\$VALIDATION_TRANSIENT"
`
      const tmpfile = path.join(os.tmpdir(), `cc-test-${Date.now()}.sh`)
      fs.writeFileSync(tmpfile, script)
      try {
        const out = execSync(`bash "${tmpfile}"`, { encoding: 'utf-8', timeout: 5000 }).trim()
        assert.ok(out.includes('OK=true'), 'review-issue with markdown must set VALIDATION_OK=true')
      } finally {
        fs.unlinkSync(tmpfile)
      }
    })

    it('passes implement mode without positive pattern check', () => {
      const script = `
ensure_deps() { :; }
ensure_labels() { :; }
REPO="test/repo"
REPO_DIR="/tmp"
LOG_DIR="/tmp"
DEFAULT_BRANCH="master"
DRY_RUN=true
WATCH=false
eval "$(awk '/^# ── Entry point/{exit} {print}' '${SCRIPT_PATH}')"
validate_cc_output "I made changes to the file" "implement"
echo "OK=\$VALIDATION_OK TRANSIENT=\$VALIDATION_TRANSIENT"
`
      const tmpfile = path.join(os.tmpdir(), `cc-test-${Date.now()}.sh`)
      fs.writeFileSync(tmpfile, script)
      try {
        const out = execSync(`bash "${tmpfile}"`, { encoding: 'utf-8', timeout: 5000 }).trim()
        assert.ok(out.includes('OK=true'), 'implement mode must pass without positive pattern check')
      } finally {
        fs.unlinkSync(tmpfile)
      }
    })

    it('detects rate_limit_error as transient', () => {
      const script = `
ensure_deps() { :; }
ensure_labels() { :; }
REPO="test/repo"
REPO_DIR="/tmp"
LOG_DIR="/tmp"
DEFAULT_BRANCH="master"
DRY_RUN=true
WATCH=false
eval "$(awk '/^# ── Entry point/{exit} {print}' '${SCRIPT_PATH}')"
validate_cc_output "Error: rate_limit_error - too many requests" "implement"
echo "OK=\$VALIDATION_OK TRANSIENT=\$VALIDATION_TRANSIENT"
`
      const tmpfile = path.join(os.tmpdir(), `cc-test-${Date.now()}.sh`)
      fs.writeFileSync(tmpfile, script)
      try {
        const out = execSync(`bash "${tmpfile}"`, { encoding: 'utf-8', timeout: 5000 }).trim()
        assert.ok(out.includes('OK=false'), 'rate_limit_error must set VALIDATION_OK=false')
        assert.ok(out.includes('TRANSIENT=true'), 'rate_limit_error must set VALIDATION_TRANSIENT=true')
      } finally {
        fs.unlinkSync(tmpfile)
      }
    })

    it('retry logic exists with backoff', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      assert.ok(
        content.includes('max_retries') && content.includes('backoff'),
        'Must have retry logic with backoff for transient failures'
      )
    })

    it('rollback on validation failure after retries exhausted', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      // After validation+retry block, must call rollback_issue
      assert.ok(
        content.includes('VALIDATION_OK') && content.includes('rollback_issue'),
        'Must rollback on validation failure after retries exhausted'
      )
    })

    it('validate_cc_output uses printf not echo for output piping', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('validate_cc_output()')
      const fnEnd = content.indexOf('\n}', fnStart) + 2
      const fnBody = content.slice(fnStart, fnEnd)

      // Must not use echo "$output" | grep — fragile with dash-prefixed output
      assert.ok(
        !fnBody.includes('echo "$output"'),
        'validate_cc_output must use printf, not echo, for piping output to grep'
      )
      assert.ok(
        fnBody.includes('printf'),
        'validate_cc_output must use printf for safe output handling'
      )
    })

    it('validate_cc_output handles output starting with dash flags', () => {
      const script = `
ensure_deps() { :; }
ensure_labels() { :; }
REPO="test/repo"
REPO_DIR="/tmp"
LOG_DIR="/tmp"
DEFAULT_BRANCH="master"
DRY_RUN=true
WATCH=false
eval "$(awk '/^# ── Entry point/{exit} {print}' '${SCRIPT_PATH}')"
validate_cc_output "-e some output that starts with a dash" "implement"
echo "OK=\$VALIDATION_OK TRANSIENT=\$VALIDATION_TRANSIENT"
`
      const tmpfile = path.join(os.tmpdir(), `cc-test-${Date.now()}.sh`)
      fs.writeFileSync(tmpfile, script)
      try {
        const out = execSync(`bash "${tmpfile}"`, { encoding: 'utf-8', timeout: 5000 }).trim()
        // Should pass validation (implement mode has no positive pattern check)
        assert.ok(out.includes('OK=true'), 'Output starting with -e must not break validation')
      } finally {
        fs.unlinkSync(tmpfile)
      }
    })

    it('all review handlers call validate_cc_output', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const handlers = ['dispatch_review_issue', 'dispatch_review_pr']
      for (const handler of handlers) {
        const fnStart = content.indexOf(`${handler}()`)
        const fnEnd = content.indexOf('\n# ── ', fnStart + 1)
        const fnBody = fnEnd !== -1 ? content.slice(fnStart, fnEnd) : content.slice(fnStart, fnStart + 3000)

        assert.ok(
          fnBody.includes('validate_cc_output'),
          `${handler} must call validate_cc_output`
        )
      }
    })
  })

  // ── Fix 1: Background execution, concurrency, worktrees ──────────

  describe('background execution', () => {
    it('MAX_CONCURRENT variable exists with default value', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      assert.ok(
        content.includes('MAX_CONCURRENT'),
        'MAX_CONCURRENT variable must exist for concurrency control'
      )
      // Should have a default value
      assert.ok(
        content.match(/MAX_CONCURRENT=.*[0-9]/),
        'MAX_CONCURRENT must have a numeric default'
      )
    })

    it('dispatch_issue checks concurrency before label swap', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_issue()')
      const fnEnd = content.indexOf('\n# ── Main loop', fnStart)
      const fnBody = content.slice(fnStart, fnEnd)

      // Concurrency check must appear before label swap
      const concurrencyIdx = fnBody.indexOf('MAX_CONCURRENT')
      const labelSwapIdx = fnBody.indexOf('--remove-label "$dispatch_label"')
      assert.ok(concurrencyIdx !== -1, 'dispatch_issue must check MAX_CONCURRENT')
      assert.ok(labelSwapIdx !== -1, 'dispatch_issue must have label swap')
      assert.ok(concurrencyIdx < labelSwapIdx, 'Concurrency check must come before label swap')
    })

    it('dispatch_issue skips already in-progress issues', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_issue()')
      const fnEnd = content.indexOf('\n# ── Main loop', fnStart)
      const fnBody = content.slice(fnStart, fnEnd)

      assert.ok(
        fnBody.includes('in-progress'),
        'dispatch_issue must check for in-progress label'
      )
    })

    it('handlers run in background subshell', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_issue()')
      const fnEnd = content.indexOf('\n# ── Main loop', fnStart)
      const fnBody = content.slice(fnStart, fnEnd)

      // Should have a subshell spawned in background: ) &
      assert.ok(
        fnBody.includes(') &'),
        'dispatch_issue must spawn handler in background subshell'
      )
    })

    it('worktree isolation for implement and revise modes', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_issue()')
      const fnEnd = content.indexOf('\n# ── Main loop', fnStart)
      const fnBody = content.slice(fnStart, fnEnd)

      assert.ok(
        fnBody.includes('worktree add'),
        'dispatch_issue must create worktree for implement/revise modes'
      )
    })

    it('worktree cleanup trap in subshell', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_issue()')
      const fnEnd = content.indexOf('\n# ── Main loop', fnStart)
      const fnBody = content.slice(fnStart, fnEnd)

      assert.ok(
        fnBody.includes('trap') && fnBody.includes('worktree remove'),
        'Background subshell must have trap for worktree cleanup'
      )
    })

    it('status file written on completion', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      assert.ok(
        content.includes('.status'),
        'Background jobs must write status files for observability'
      )
    })

    it('status file captures handler exit code (not always success)', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_issue()')
      const fnEnd = content.indexOf('\n# ── Main loop', fnStart)
      const fnBody = content.slice(fnStart, fnEnd)

      // Must capture exit code from the case block before writing status
      assert.ok(
        fnBody.includes('handler_exit') || fnBody.includes('$?'),
        'Status file must capture handler exit code, not hardcode success'
      )
      // Must NOT have unconditional status=success
      assert.ok(
        !fnBody.match(/echo\s+"status=success\b(?!.*\$)/),
        'Status file must not unconditionally write status=success'
      )
    })

    it('dispatch_issue does not use wait -n (which serializes dispatch)', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_issue()')
      const fnEnd = content.indexOf('\n# ── Main loop', fnStart)
      const fnBody = content.slice(fnStart, fnEnd)

      assert.ok(
        !fnBody.includes('wait -n'),
        'dispatch_issue must not use wait -n — it blocks until a job finishes, serializing dispatch'
      )
    })

    it('signal trap kills background agents on INT/TERM', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      // Should be in the watch mode section
      assert.ok(
        content.includes('trap') && content.includes('INT') && content.includes('TERM'),
        'Main loop must trap INT/TERM to kill background agents'
      )
      assert.ok(
        content.includes('jobs -rp') || content.includes('kill'),
        'Signal trap must kill running background jobs'
      )
    })

    it('git worktree prune in ensure_deps', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('ensure_deps()')
      const fnEnd = content.indexOf('\n}', fnStart) + 2
      const fnBody = content.slice(fnStart, fnEnd)

      assert.ok(
        fnBody.includes('worktree prune'),
        'ensure_deps must prune orphaned worktrees at startup'
      )
    })

    it('log rotation in ensure_deps', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('ensure_deps()')
      const fnEnd = content.indexOf('\n}', fnStart) + 2
      const fnBody = content.slice(fnStart, fnEnd)

      assert.ok(
        fnBody.includes('-mtime') && fnBody.includes('-delete'),
        'ensure_deps must rotate old log files'
      )
    })

    it('worktrees directory creation', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      assert.ok(
        content.includes('.worktrees'),
        'Must use .worktrees directory for isolated worktrees'
      )
    })
  })

  // ── Issue #50: review-issue double-posting fix ─────────────────────

  describe('review-issue double-posting fix (#50)', () => {
    it('review-issue prompt contains "Do NOT run gh issue comment"', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_review_issue()')
      const fnEnd = content.indexOf('\n}', fnStart + 200)
      const fnBody = content.slice(fnStart, fnEnd)

      assert.ok(
        fnBody.includes('Do NOT run gh issue comment'),
        'dispatch_review_issue prompt must explicitly forbid agent from posting comments'
      )
    })

    it('review-issue prompt tells agent to output findings directly', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_review_issue()')
      const fnEnd = content.indexOf('\n}', fnStart + 200)
      const fnBody = content.slice(fnStart, fnEnd)

      assert.ok(
        fnBody.includes('output your full review findings directly'),
        'dispatch_review_issue prompt must tell agent to output findings for script to post'
      )
    })
  })

  // ── Issue #50: worktree --detach fix ──────────────────────────────

  describe('worktree detach fix (#50)', () => {
    it('dispatch_issue uses worktree add --detach', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      const fnStart = content.indexOf('dispatch_issue()')
      const fnEnd = content.indexOf('\n# ── Main loop', fnStart)
      const fnBody = content.slice(fnStart, fnEnd)

      assert.ok(
        fnBody.includes('worktree add --detach'),
        'dispatch_issue must use --detach to avoid branch-already-in-use error'
      )
    })
  })

  // ── Comment accuracy ─────────────────────────────────────────────

  describe('comment accuracy', () => {
    it('dispatch_review_issue comment says "issue" not "PR"', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8')
      // Find the comment line before dispatch_review_issue
      const fnIdx = content.indexOf('dispatch_review_issue()')
      const commentLine = content.slice(Math.max(0, fnIdx - 200), fnIdx)

      assert.ok(
        commentLine.includes('issue') && !commentLine.includes('posts findings on the PR'),
        'Comment before dispatch_review_issue should reference posting to issue, not PR'
      )
    })
  })
})
