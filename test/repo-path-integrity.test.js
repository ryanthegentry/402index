import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

// Directory prefixes that indicate a repo-relative path
const REPO_PREFIXES = ['.claude/', '.github/', 'scripts/', 'test/', 'src/', 'docs/', 'data/', 'listings/', 'mcp-server/']
const PATH_EXTENSIONS = /\.(js|ts|mjs|cjs|md|json|yml|yaml|sh|txt)['"`]/

/**
 * Guardrail: tracked source files that read gitignored paths must use existsSync.
 *
 * This catches the class of bug where a tracked test does readFileSync on a
 * local-only file (e.g. .claude/agents/qa-reviewer.md) without an existence
 * check, causing ENOENT crashes in CI where those files are absent.
 */
describe('repo-path-integrity', () => {
  const trackedFiles = execSync('git ls-files -- test/ src/ scripts/ .github/workflows/', { cwd: root })
    .toString().trim().split('\n').filter(Boolean)

  const sourceFiles = trackedFiles.filter(f =>
    f.endsWith('.js') || f.endsWith('.mjs') || f.endsWith('.ts')
  )

  describe('tracked source files that read gitignored paths must have existsSync guards', () => {
    for (const relPath of sourceFiles) {
      const fullPath = join(root, relPath)
      let content
      try {
        content = readFileSync(fullPath, 'utf8')
      } catch {
        continue
      }

      // Only check files that do file I/O (readFileSync or the readFile helper)
      if (!content.includes('readFileSync') && !content.includes('readFile(')) continue

      // Extract string literals that look like repo-relative paths
      const pathRefs = new Set()
      for (const prefix of REPO_PREFIXES) {
        const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const regex = new RegExp(`['"\`]([^'"\`]*${escaped}[^'"\`]*)['"\`]`, 'g')
        let match
        while ((match = regex.exec(content)) !== null) {
          const candidate = match[1]
          // Only include if it ends with a file extension
          if (PATH_EXTENSIONS.test(candidate + "'")) {
            // Normalize: extract the repo-relative portion
            for (const p of REPO_PREFIXES) {
              const idx = candidate.indexOf(p)
              if (idx !== -1) {
                pathRefs.add(candidate.slice(idx))
                break
              }
            }
          }
        }
      }

      // For each referenced path, check if it's gitignored
      for (const refPath of pathRefs) {
        let isGitignored = false
        try {
          execSync(`git check-ignore -q "${refPath}"`, { cwd: root, stdio: 'pipe' })
          isGitignored = true
        } catch {
          // not gitignored — tracked file, no guard needed
        }

        if (isGitignored) {
          it(`${relPath}: gitignored path "${refPath}" must have existsSync guard`, () => {
            const hasGuard = content.includes('existsSync')
            const hasSkip = /\bskip\s*:/.test(content)
            assert.ok(
              hasGuard || hasSkip,
              `${relPath} references gitignored path "${refPath}" via readFileSync ` +
              `but does not contain an existsSync guard or skip condition. ` +
              `Tracked files that read local-only paths must check existence first ` +
              `to avoid ENOENT in CI where those files are absent.`
            )
          })
        }
      }
    }
  })
})
