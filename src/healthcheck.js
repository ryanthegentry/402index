// Standalone script: npm run healthcheck
import { runHealthChecks } from './health/checker.js'

async function main() {
  await runHealthChecks()
  process.exit(0)
}

main().catch(err => {
  console.error('[healthcheck] Fatal error:', err)
  process.exit(1)
})
