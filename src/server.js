import express from 'express'
import { loadListings, loadFeatured } from './listings.js'
import { pollBazaar } from './aggregators/bazaar.js'
import { pollSatring } from './aggregators/satring.js'
import { runHealthChecks } from './health/checker.js'
import apiRoutes from './routes/api.js'
import pageRoutes from './routes/pages.js'

const app = express()
const PORT = process.env.PORT || 3402

// Warn if NODE_ENV is not production
if (process.env.NODE_ENV !== 'production') {
  console.warn('[server] WARNING: NODE_ENV is not "production" (current: %s)', process.env.NODE_ENV || 'undefined')
}

// Security: don't leak technology stack
app.disable('x-powered-by')

app.use('/api/v1', apiRoutes)
app.use('/', pageRoutes)

// Track in-flight health check for graceful shutdown
let healthCheckRunning = false

// Start server
const server = app.listen(PORT, () => {
  console.log(`[server] 402index listening on port ${PORT}`)

  // Load YAML listings on startup, then apply featured flags immediately
  loadListings()
  loadFeatured()

  // Run Bazaar + Satring polls on startup, then re-apply featured flags (catches polled services)
  Promise.all([
    pollBazaar().catch(err => console.error('[server] Initial Bazaar poll failed:', err.message)),
    pollSatring().catch(err => console.error('[server] Initial Satring poll failed:', err.message)),
  ]).then(() => loadFeatured())
  const bazaarInterval = parseInt(process.env.BAZAAR_POLL_INTERVAL_MS) || 3600000
  setInterval(() => {
    pollBazaar().catch(err => console.error('[server] Bazaar poll failed:', err.message))
    pollSatring().catch(err => console.error('[server] Satring poll failed:', err.message))
  }, bazaarInterval)

  // Run health checks on startup (delayed 30s to let polls finish), then on interval
  setTimeout(() => {
    healthCheckRunning = true
    runHealthChecks()
      .catch(err => console.error('[server] Initial health check failed:', err.message))
      .finally(() => { healthCheckRunning = false })
  }, 30000)
  const healthInterval = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS) || 900000
  setInterval(() => {
    healthCheckRunning = true
    runHealthChecks()
      .catch(err => console.error('[server] Health check failed:', err.message))
      .finally(() => { healthCheckRunning = false })
  }, healthInterval)
})

// Graceful shutdown: wait for in-flight health checks before exiting
function shutdown(signal) {
  console.log(`[server] ${signal} received, shutting down gracefully...`)
  server.close(() => {
    console.log('[server] HTTP server closed')
  })
  if (healthCheckRunning) {
    console.log('[server] Waiting for health check batch to finish...')
    const check = setInterval(() => {
      if (!healthCheckRunning) {
        clearInterval(check)
        console.log('[server] Health check complete, exiting')
        process.exit(0)
      }
    }, 500)
    // Force exit after 30s even if health check is stuck
    setTimeout(() => {
      console.warn('[server] Forced exit after 30s timeout')
      process.exit(1)
    }, 30000)
  } else {
    process.exit(0)
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
