import { loadListings, loadFeatured } from './listings.js'
import { pollBazaar } from './aggregators/bazaar.js'
import { pollSatring } from './aggregators/satring.js'
import { pollL402Apps } from './aggregators/l402apps.js'
import { pollSponge } from './aggregators/sponge.js'
import { runHealthChecks } from './health/checker.js'
import { classifyServices } from './services/classify.js'

let healthCheckRunning = false

export function isHealthCheckRunning() {
  return healthCheckRunning
}

function runPolls() {
  return Promise.all([
    pollBazaar().catch(err => console.error('[scheduler] Bazaar poll failed:', err.message)),
    pollSatring().catch(err => console.error('[scheduler] Satring poll failed:', err.message)),
  ]).then(() => {
    loadFeatured()
    classifyServices()
  })
}

function runL402AppsPoll() {
  return pollL402Apps()
    .then(() => {
      loadFeatured()
      classifyServices()
    })
    .catch(err => console.error('[scheduler] l402apps poll failed:', err.message))
}

function runSpongePoll() {
  return pollSponge()
    .then(() => {
      loadFeatured()
      classifyServices()
    })
    .catch(err => console.error('[scheduler] sponge poll failed:', err.message))
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
  runL402AppsPoll()
  runSpongePoll()

  const bazaarInterval = parseInt(process.env.BAZAAR_POLL_INTERVAL_MS) || 3600000
  setInterval(runPolls, bazaarInterval)

  // l402apps + sponge: daily poll (sites update infrequently)
  const l402appsInterval = parseInt(process.env.L402APPS_POLL_INTERVAL_MS) || 86400000
  setInterval(runL402AppsPoll, l402appsInterval)

  const spongeInterval = parseInt(process.env.SPONGE_POLL_INTERVAL_MS) || 86400000
  setInterval(runSpongePoll, spongeInterval)

  // Delay health checks 30s to let polls finish first
  setTimeout(runHealthCheckGuarded, 30000)
  const healthInterval = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS) || 3600000
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
