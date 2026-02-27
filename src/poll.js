// Standalone script: npm run poll
import { loadListings } from './listings.js'
import { pollBazaar } from './aggregators/bazaar.js'
import { pollSatring } from './aggregators/satring.js'

async function main() {
  loadListings()
  await pollBazaar()
  await pollSatring()
  process.exit(0)
}

main().catch(err => {
  console.error('[poll] Fatal error:', err)
  process.exit(1)
})
