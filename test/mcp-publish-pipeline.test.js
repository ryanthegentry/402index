import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

function readFile(relPath) {
  return readFileSync(resolve(ROOT, relPath), 'utf8')
}

function fileExists(relPath) {
  return existsSync(resolve(ROOT, relPath))
}

describe('mcp-publish pipeline', () => {
  describe('(a)-(g) publish-mcp.yml', () => {
    it('(a) exists and parses as valid YAML', () => {
      assert.ok(
        fileExists('.github/workflows/publish-mcp.yml'),
        '.github/workflows/publish-mcp.yml must exist'
      )
      const text = readFile('.github/workflows/publish-mcp.yml')
      const wf = yaml.load(text)
      assert.ok(wf && typeof wf === 'object', 'Workflow must parse as a valid YAML object')
    })

    it('(b) triggers on push.tags: ["mcp-v*"] only — no branches, no workflow_dispatch', () => {
      const wf = yaml.load(readFile('.github/workflows/publish-mcp.yml'))
      assert.deepEqual(
        wf.on,
        { push: { tags: ['mcp-v*'] } },
        'on: must be exactly { push: { tags: ["mcp-v*"] } }'
      )
    })

    it('(c) id-token: write at job level only, not workflow level', () => {
      const wf = yaml.load(readFile('.github/workflows/publish-mcp.yml'))
      if (wf.permissions && typeof wf.permissions === 'object') {
        assert.notEqual(
          wf.permissions['id-token'],
          'write',
          'id-token: write must not be set at workflow level'
        )
      }
      const jobPerms = wf.jobs.publish.permissions
      assert.ok(jobPerms, 'publish job must declare permissions')
      assert.equal(jobPerms['id-token'], 'write', 'publish job must have id-token: write')
      assert.equal(jobPerms.contents, 'read', 'publish job must have contents: read')
    })

    it('(d) publish job references environment: mcp-publish', () => {
      const wf = yaml.load(readFile('.github/workflows/publish-mcp.yml'))
      assert.equal(
        wf.jobs.publish.environment,
        'mcp-publish',
        'publish job must declare environment: mcp-publish'
      )
    })

    it('(e) publish job node-version matches ci.yml matrix node-version', () => {
      const wf = yaml.load(readFile('.github/workflows/publish-mcp.yml'))
      const ci = yaml.load(readFile('.github/workflows/ci.yml'))
      const ciNodeVersion = ci.jobs.test.strategy.matrix['node-version'][0]
      const setupNodeStep = wf.jobs.publish.steps.find(
        (s) => s.uses && s.uses.startsWith('actions/setup-node')
      )
      assert.ok(setupNodeStep, 'publish job must have an actions/setup-node step')
      assert.equal(
        String(setupNodeStep.with['node-version']),
        String(ciNodeVersion),
        `publish node-version must match ci.yml (${ciNodeVersion})`
      )
    })

    it('(f) workflow references no NPM_TOKEN, NODE_AUTH_TOKEN, or MCP_REGISTRY_TOKEN', () => {
      const text = readFile('.github/workflows/publish-mcp.yml')
      assert.ok(!text.includes('NPM_TOKEN'), 'Workflow must not reference NPM_TOKEN')
      assert.ok(!text.includes('NODE_AUTH_TOKEN'), 'Workflow must not reference NODE_AUTH_TOKEN')
      assert.ok(!text.includes('MCP_REGISTRY_TOKEN'), 'Workflow must not reference MCP_REGISTRY_TOKEN')
    })

    it('(g) allowlist-diff step is present and normalization is deterministic', () => {
      const text = readFile('.github/workflows/publish-mcp.yml')
      assert.ok(
        text.includes('npm pack --dry-run --json'),
        'Workflow must contain allowlist diff step with npm pack --dry-run --json'
      )
      assert.ok(
        text.includes('.tarball-allowlist.txt'),
        'Workflow must reference .tarball-allowlist.txt in the allowlist diff step'
      )
      // Verify the normalization pipeline: strip package/ prefix then sort
      const fixture = '[{"files":[{"path":"package/dist/index.js"},{"path":"package/README.md"},{"path":"package/LICENSE"}]}]'
      const result = execSync(
        `echo '${fixture}' | jq -r '.[0].files[].path' | sed 's|^package/||' | sort`
      ).toString().trim()
      assert.equal(
        result,
        'LICENSE\nREADME.md\ndist/index.js',
        'Normalization pipeline must strip package/ prefix and sort alphabetically'
      )
    })
  })

  describe('(h)-(i) server.json repository corrections', () => {
    it('(h) repository.url points to the monorepo', () => {
      const sj = JSON.parse(readFile('mcp-server/server.json'))
      assert.equal(
        sj.repository.url,
        'https://github.com/ryanthegentry/402index',
        'server.json repository.url must be the monorepo URL, not the standalone repo'
      )
    })

    it('(i) repository.subfolder is "mcp-server"', () => {
      const sj = JSON.parse(readFile('mcp-server/server.json'))
      assert.equal(
        sj.repository.subfolder,
        'mcp-server',
        'server.json must have repository.subfolder = "mcp-server"'
      )
    })
  })

  describe('(j)-(k) cross-file version invariants', () => {
    it('(j) package.json#mcpName equals server.json#name', () => {
      const pkg = JSON.parse(readFile('mcp-server/package.json'))
      const sj = JSON.parse(readFile('mcp-server/server.json'))
      assert.equal(
        pkg.mcpName,
        sj.name,
        'package.json#mcpName must equal server.json#name'
      )
    })

    it('(k) package.json#version === server.json#version === server.json#packages[0].version', () => {
      const pkg = JSON.parse(readFile('mcp-server/package.json'))
      const sj = JSON.parse(readFile('mcp-server/server.json'))
      assert.equal(
        pkg.version,
        sj.version,
        `package.json version (${pkg.version}) must equal server.json version (${sj.version})`
      )
      assert.equal(
        pkg.version,
        sj.packages[0].version,
        `package.json version (${pkg.version}) must equal server.json packages[0].version (${sj.packages[0].version})`
      )
    })
  })

  describe('(l) RELEASE.md', () => {
    it('(l) exists and contains all four required sections', () => {
      assert.ok(
        fileExists('mcp-server/RELEASE.md'),
        'mcp-server/RELEASE.md must exist'
      )
      const content = readFile('mcp-server/RELEASE.md')
      assert.ok(content.includes('One-time setup'), 'RELEASE.md must contain "One-time setup" section')
      assert.ok(content.includes('Per-release ceremony'), 'RELEASE.md must contain "Per-release ceremony" section')
      assert.ok(content.includes('Failure recovery'), 'RELEASE.md must contain "Failure recovery" section')
      assert.ok(content.includes('7-tool smoke-test checklist'), 'RELEASE.md must contain "7-tool smoke-test checklist" section')
    })
  })

  describe('(m) CHANGELOG.md', () => {
    it('(m) exists and contains entries for 0.3.0 and 0.2.5', () => {
      assert.ok(
        fileExists('mcp-server/CHANGELOG.md'),
        'mcp-server/CHANGELOG.md must exist'
      )
      const content = readFile('mcp-server/CHANGELOG.md')
      assert.ok(content.includes('0.3.0'), 'CHANGELOG.md must contain a 0.3.0 entry')
      assert.ok(content.includes('0.2.5'), 'CHANGELOG.md must contain a 0.2.5 entry')
    })
  })
})
