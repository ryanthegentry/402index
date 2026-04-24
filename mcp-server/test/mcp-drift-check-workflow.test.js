import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const workflowPath = join(__dirname, '..', '..', '.github', 'workflows', 'mcp-drift-check.yml')

let workflowContent
try {
  workflowContent = readFileSync(workflowPath, 'utf8')
} catch {
  workflowContent = null
}

describe('mcp-drift-check workflow structural assertions', () => {
  it('a. file exists', () => {
    assert.ok(workflowContent !== null, 'Expected .github/workflows/mcp-drift-check.yml to exist')
  })

  it('b. triggers on pull_request with mcp-server/** path filter', () => {
    assert.ok(workflowContent.includes('pull_request:'), 'Expected pull_request: trigger')
    assert.ok(/paths:[\s\S]*mcp-server\/\*\*/.test(workflowContent), 'Expected paths: entry for mcp-server/**')
  })

  it('c. uses node-version: 20 (not 22, not 18)', () => {
    assert.ok(workflowContent.includes('node-version: 20'), 'Expected node-version: 20')
    assert.ok(!workflowContent.includes('node-version: 22'), 'Must not use node-version: 22')
    assert.ok(!workflowContent.match(/node-version:\s+['"]?18['"]?/), 'Must not use node-version: 18')
  })

  it('d. uses actions/checkout@v4', () => {
    assert.ok(workflowContent.includes('actions/checkout@v4'), 'Expected actions/checkout@v4')
  })

  it('e. uses actions/setup-node@v4 with cache: npm and cache-dependency-path: mcp-server/package-lock.json', () => {
    assert.ok(workflowContent.includes('actions/setup-node@v4'), 'Expected actions/setup-node@v4')
    assert.ok(workflowContent.includes("cache: 'npm'") || workflowContent.includes('cache: npm'), 'Expected cache: npm')
    assert.ok(workflowContent.includes('cache-dependency-path: mcp-server/package-lock.json'), 'Expected cache-dependency-path: mcp-server/package-lock.json')
  })

  it('f. runs npm ci with working-directory: mcp-server', () => {
    assert.ok(/run:\s*npm ci/.test(workflowContent) || workflowContent.includes('run: npm ci'), 'Expected npm ci step')
    assert.ok(workflowContent.includes('working-directory: mcp-server'), 'Expected working-directory: mcp-server')
  })

  it('g. runs npm run build with working-directory: mcp-server', () => {
    assert.ok(/run:\s*npm run build/.test(workflowContent) || workflowContent.includes('run: npm run build'), 'Expected npm run build step')
  })

  it('h. contains git diff --exit-code targeting mcp-server/dist', () => {
    assert.ok(
      /git diff --exit-code.*mcp-server\/dist/.test(workflowContent) ||
      workflowContent.includes('git diff --exit-code mcp-server/dist'),
      'Expected git diff --exit-code mcp-server/dist'
    )
  })

  it('i. runs node --test test/version-drift.test.js', () => {
    assert.ok(
      workflowContent.includes('node --test test/version-drift.test.js'),
      'Expected node --test test/version-drift.test.js'
    )
  })

  it('j. contains npm pack --dry-run --json and .tarball-allowlist.txt (allowlist-diff gate)', () => {
    assert.ok(
      workflowContent.includes('npm pack --dry-run --json'),
      'Expected npm pack --dry-run --json'
    )
    assert.ok(
      workflowContent.includes('.tarball-allowlist.txt'),
      'Expected .tarball-allowlist.txt reference'
    )
  })

  it('k. job-level timeout-minutes: 3', () => {
    assert.ok(
      workflowContent.includes('timeout-minutes: 3'),
      'Expected timeout-minutes: 3 at job level'
    )
  })

  it('l. has schedule trigger with cron string', () => {
    assert.ok(
      workflowContent.includes('schedule:'),
      'Expected schedule: trigger'
    )
    assert.ok(
      /cron:\s*'[^']*'/.test(workflowContent),
      'Expected cron string in schedule trigger'
    )
  })

  it('m. has live-smoke job', () => {
    assert.ok(
      workflowContent.includes('live-smoke:'),
      'Expected live-smoke job definition'
    )
  })

  it('n. live-smoke job has continue-on-error: true', () => {
    // Extract the live-smoke job block
    const liveIdx = workflowContent.indexOf('live-smoke:')
    assert.ok(liveIdx !== -1, 'Expected live-smoke job')
    const block = workflowContent.substring(liveIdx, liveIdx + 500)
    assert.ok(
      block.includes('continue-on-error: true'),
      'live-smoke job must have continue-on-error: true'
    )
  })

  it('o. live-smoke job runs only on schedule trigger', () => {
    const liveIdx = workflowContent.indexOf('live-smoke:')
    assert.ok(liveIdx !== -1, 'Expected live-smoke job')
    const block = workflowContent.substring(liveIdx, liveIdx + 500)
    assert.ok(
      block.includes("github.event_name == 'schedule'"),
      'live-smoke job must have if: github.event_name == \'schedule\''
    )
  })
})
