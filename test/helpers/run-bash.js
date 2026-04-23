import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execSync } from 'node:child_process'

// Cached bash path — resolved once per test run
let resolvedBashPath = null

/**
 * Resolve a bash 4+ binary. Checks Homebrew paths first, then PATH.
 * Throws if no bash 4+ is found.
 */
export function getBashPath() {
  if (resolvedBashPath) return resolvedBashPath

  const candidates = [
    '/opt/homebrew/bin/bash',   // Apple Silicon Homebrew
    '/usr/local/bin/bash',      // Intel Homebrew / Linux
  ]

  // Add PATH-resolved bash as final candidate
  try {
    const pathBash = execSync('command -v bash', { encoding: 'utf-8' }).trim()
    if (pathBash && !candidates.includes(pathBash)) candidates.push(pathBash)
  } catch { /* ignore */ }

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue
      const version = execSync(`"${candidate}" -c 'echo \${BASH_VERSINFO[0]}'`, { encoding: 'utf-8' }).trim()
      if (parseInt(version, 10) >= 4) {
        resolvedBashPath = candidate
        return resolvedBashPath
      }
    } catch { /* ignore, try next */ }
  }

  throw new Error('bash 4+ not found; install with: brew install bash')
}

/**
 * Write a bash script to a temp file and execute it with bash 4+.
 */
export function runBash(script, { timeout = 15000, env } = {}) {
  const bash = getBashPath()
  const tmpfile = path.join(os.tmpdir(), `dispatch-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`)
  fs.writeFileSync(tmpfile, script)
  try {
    return execSync(`"${bash}" "${tmpfile}"`, { encoding: 'utf-8', timeout, env: { ...process.env, ...env } }).trim()
  } catch (e) {
    const out = [e.stdout, e.stderr].filter(Boolean).join('\n').trim()
    if (out) return out
    throw e
  } finally {
    fs.unlinkSync(tmpfile)
  }
}
