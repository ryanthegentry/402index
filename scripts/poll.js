// Standalone script: npm run poll
import { loadListings, loadFeatured } from '../src/listings.js'
import { pollBazaar } from '../src/aggregators/bazaar.js'
import { pollSatring } from '../src/aggregators/satring.js'

async function main() {
  loadListings()
  await pollBazaar()
  await pollSatring()
  loadFeatured()
  process.exit(0)
}

main().catch(err => {
  console.error('[poll] Fatal error:', err)
  process.exit(1)
})
