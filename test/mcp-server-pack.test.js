import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const mcpDir = join(root, 'mcp-server')

/**
 * Smoke test: npm pack of @402index/mcp-server produces a usable package.
 *
 * Catches package-shape regressions before they reach npm consumers.
 * Does not hit the network — purely validates local tarball contents.
 */
describe('mcp-server-pack', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'mcp-pack-'))
  let tarballName

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('npm pack produces a tarball', () => {
    // Build first (TypeScript → dist/)
    execSync('npm run build', { cwd: mcpDir, stdio: 'pipe' })
    const output = execSync('npm pack --pack-destination ' + tmpDir, {
      cwd: mcpDir,
      encoding: 'utf8'
    }).trim()
    tarballName = output.split('\n').pop()
    assert.ok(
      tarballName.includes('402index-mcp-server'),
      `npm pack should produce a tarball named with 402index-mcp-server, got: ${tarballName}`
    )
    assert.ok(
      existsSync(join(tmpDir, tarballName)),
      `Tarball must exist at ${join(tmpDir, tarballName)}`
    )
  })

  it('tarball extracts and contains expected files', () => {
    assert.ok(tarballName, 'tarball must have been created in previous test')
    execSync(`tar xzf "${tarballName}"`, { cwd: tmpDir })

    const pkg = join(tmpDir, 'package')
    assert.ok(existsSync(join(pkg, 'dist', 'index.js')), 'dist/index.js must exist')
    assert.ok(existsSync(join(pkg, 'package.json')), 'package.json must exist')
    assert.ok(existsSync(join(pkg, 'README.md')), 'README.md must exist')
    assert.ok(existsSync(join(pkg, 'LICENSE')), 'LICENSE must exist')
  })

  it('entry point has node shebang and imports MCP SDK', () => {
    const indexPath = join(tmpDir, 'package', 'dist', 'index.js')
    const content = readFileSync(indexPath, 'utf8')
    assert.ok(
      content.startsWith('#!/usr/bin/env node'),
      'Entry point must start with #!/usr/bin/env node shebang'
    )
    assert.ok(
      content.includes('@modelcontextprotocol/sdk'),
      'Entry point must import @modelcontextprotocol/sdk'
    )
  })

  it('package.json bin field points to dist/index.js', () => {
    const pkgPath = join(tmpDir, 'package', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    assert.equal(pkg.bin['mcp-server'], 'dist/index.js', 'bin.mcp-server must be dist/index.js')
  })
})
