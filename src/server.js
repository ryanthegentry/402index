import express from 'express'
import { loadListings } from './listings.js'
import { pollBazaar } from './aggregators/bazaar.js'
import { runHealthChecks } from './health/checker.js'
import apiRoutes from './routes/api.js'
import pageRoutes from './routes/pages.js'

const app = express()
const PORT = process.env.PORT || 3402

app.use('/api/v1', apiRoutes)
app.use('/', pageRoutes)

// Start server
app.listen(PORT, () => {
  console.log(`[server] 402index listening on port ${PORT}`)

  // Load YAML listings on startup
  loadListings()

  // Run Bazaar poll on startup, then on interval
  pollBazaar().catch(err => console.error('[server] Initial Bazaar poll failed:', err.message))
  const bazaarInterval = parseInt(process.env.BAZAAR_POLL_INTERVAL_MS) || 3600000
  setInterval(() => {
    pollBazaar().catch(err => console.error('[server] Bazaar poll failed:', err.message))
  }, bazaarInterval)

  // Run health checks on startup (delayed 30s to let polls finish), then on interval
  setTimeout(() => {
    runHealthChecks().catch(err => console.error('[server] Initial health check failed:', err.message))
  }, 30000)
  const healthInterval = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS) || 900000
  setInterval(() => {
    runHealthChecks().catch(err => console.error('[server] Health check failed:', err.message))
  }, healthInterval)
})
