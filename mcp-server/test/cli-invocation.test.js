import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const distIndex = resolve(__dirname, '..', 'dist', 'index.js')

const STARTUP_MSG = '[402index-mcp] Server running'

/**
 * Spawn node with `entryPath` and wait for the startup message on stderr.
 * Returns { stderr, started } — `started` is true if the message appeared.
 */
function spawnCLI(entryPath, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entryPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stderr = ''
    let settled = false

    const finish = (started) => {
      if (settled) return
      settled = true
      child.kill('SIGTERM')
      resolve({ stderr, started })
    }

    const timer = setTimeout(() => finish(false), timeoutMs)

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
      if (stderr.includes(STARTUP_MSG)) {
        clearTimeout(timer)
        finish(true)
      }
    })

    child.on('exit', () => {
      clearTimeout(timer)
      finish(false)
    })

    child.on('error', () => {
      clearTimeout(timer)
      finish(false)
    })

    // Close stdin so StdioServerTransport doesn't hold the process open
    child.stdin.end()
  })
}

describe('CLI invocation (#178 F-1)', () => {
  it('T-cli-direct: starts when invoked via real path', async () => {
    const { stderr, started } = await spawnCLI(distIndex)
    assert.ok(started, `Expected startup message in stderr, got: "${stderr}"`)
  })

  it('T-cli-symlink: starts when invoked via symlink (npm bin scenario)', async () => {
    const linkPath = join(tmpdir(), `mcp-server-link-${process.pid}-${Date.now()}.js`)
    symlinkSync(distIndex, linkPath)
    try {
      const { stderr, started } = await spawnCLI(linkPath)
      assert.ok(started, `Expected startup message via symlink, got: "${stderr}"`)
    } finally {
      try { unlinkSync(linkPath) } catch {}
    }
  })
})
