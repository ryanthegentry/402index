import { loadListings, loadFeatured } from './listings.js'
import { pollBazaar } from './aggregators/bazaar.js'
import { pollSatring } from './aggregators/satring.js'
import { runHealthChecks } from './health/checker.js'

let healthCheckRunning = false

export function isHealthCheckRunning() {
  return healthCheckRunning
}

function runPolls() {
  return Promise.all([
    pollBazaar().catch(err => console.error('[scheduler] Bazaar poll failed:', err.message)),
    pollSatring().catch(err => console.error('[scheduler] Satring poll failed:', err.message)),
  ]).then(() => loadFeatured())
}

function runHealthCheckGuarded() {
  if (healthCheckRunning) return
  healthCheckRunning = true
  runHealthChecks()
    .catch(err => console.error('[scheduler] Health check failed:', err.message))
    .finally(() => { healthCheckRunning = false })
}

/** Call once after the HTTP server is listening. */
export function startScheduler() {
  loadListings()
  loadFeatured()
  runPolls()

  const bazaarInterval = parseInt(process.env.BAZAAR_POLL_INTERVAL_MS) || 3600000
  setInterval(runPolls, bazaarInterval)

  // Delay health checks 30s to let polls finish first
  setTimeout(runHealthCheckGuarded, 30000)
  const healthInterval = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS) || 900000
  setInterval(runHealthCheckGuarded, healthInterval)
}

export function shutdown(server, signal) {
  console.log(`[scheduler] ${signal} received, shutting down gracefully...`)
  server.close(() => {
    console.log('[scheduler] HTTP server closed')
    if (!healthCheckRunning) {
      process.exit(0)
    }
  })
  if (healthCheckRunning) {
    console.log('[scheduler] Waiting for health check batch to finish...')
    const check = setInterval(() => {
      if (!healthCheckRunning) {
        clearInterval(check)
        console.log('[scheduler] Health check complete, exiting')
        process.exit(0)
      }
    }, 500)
    setTimeout(() => {
      console.warn('[scheduler] Forced exit after 30s timeout')
      process.exit(1)
    }, 30000)
  }
}
