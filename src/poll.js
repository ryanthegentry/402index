// Standalone script: npm run poll
import { loadListings } from './listings.js'
import { pollBazaar } from './aggregators/bazaar.js'

async function main() {
  loadListings()
  await pollBazaar()
  process.exit(0)
}

main().catch(err => {
  console.error('[poll] Fatal error:', err)
  process.exit(1)
})
