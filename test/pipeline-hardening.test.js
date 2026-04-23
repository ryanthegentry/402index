import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

describe('pipeline-hardening', () => {
  describe('workflow-rebase-check', () => {
    const ciYml = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')

    it('checkout uses fetch-depth: 0', () => {
      assert.ok(
        ciYml.includes('fetch-depth: 0'),
        'ci.yml must contain "fetch-depth: 0"'
      )
    })

    it('rebase check uses git merge-base --is-ancestor with PR head sha', () => {
      assert.ok(
        ciYml.includes('git merge-base --is-ancestor origin/master ${{ github.event.pull_request.head.sha }}'),
        'ci.yml must contain "git merge-base --is-ancestor origin/master ${{ github.event.pull_request.head.sha }}" (not HEAD, which points to the merge commit)'
      )
    })

    it('rebase check is guarded by pull_request event', () => {
      assert.ok(
        ciYml.includes("if: github.event_name == 'pull_request'"),
        'ci.yml must contain "if: github.event_name == \'pull_request\'"'
      )
    })

    it('rebase check does not use HEAD (merge commit defeats the check)', () => {
      assert.ok(
        !ciYml.includes('--is-ancestor origin/master HEAD'),
        'ci.yml must not use HEAD — GitHub Actions checks out refs/pull/N/merge where HEAD always has origin/master as ancestor'
      )
    })

    it('git fetch does not use --depth=0 (invalid for git fetch)', () => {
      assert.ok(
        !ciYml.includes('--depth=0'),
        'ci.yml must not contain "--depth=0" — git fetch requires a positive depth integer'
      )
    })

    it('rebase check runs before Install dependencies', () => {
      const mergeBaseIndex = ciYml.indexOf('git merge-base --is-ancestor origin/master')
      const installIndex = ciYml.indexOf('- name: Install dependencies')
      assert.ok(mergeBaseIndex > -1, 'git merge-base must exist in ci.yml')
      assert.ok(installIndex > -1, 'Install dependencies step must exist in ci.yml')
      assert.ok(
        mergeBaseIndex < installIndex,
        'rebase check must appear before Install dependencies'
      )
    })
  })

  const qaReviewerPath = join(root, '.claude/agents/qa-reviewer.md')

  describe('qa-reviewer-ci-env', { skip: !existsSync(qaReviewerPath) }, () => {
    const qaReviewer = readFileSync(qaReviewerPath, 'utf8')

    it('contains CI=true npm test at least twice', () => {
      const matches = qaReviewer.match(/CI=true npm test/g)
      assert.ok(
        matches && matches.length >= 2,
        `qa-reviewer.md must contain "CI=true npm test" at least twice, found ${matches ? matches.length : 0}`
      )
    })

    it('does not contain bare "Run: npm test" or "Run the tests: npm test"', () => {
      assert.ok(
        !qaReviewer.includes('Run: npm test'),
        'qa-reviewer.md must not contain bare "Run: npm test"'
      )
      assert.ok(
        !qaReviewer.includes('Run the tests: npm test'),
        'qa-reviewer.md must not contain bare "Run the tests: npm test"'
      )
    })
  })
})
