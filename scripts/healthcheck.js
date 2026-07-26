// Standalone script: npm run healthcheck
import { runHealthChecks, formatCycleSummary } from '../src/health/checker.js'

async function main() {
  const result = await runHealthChecks()
  console.log(`[healthcheck] ${formatCycleSummary(result)}`)
  process.exit(0)
}

main().catch(err => {
  console.error('[healthcheck] Fatal error:', err)
  process.exit(1)
})
