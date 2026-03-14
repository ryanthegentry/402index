import { Router } from 'express'
import db from '../db.js'
import { queryServices, PAGE_COLUMNS } from '../queries/services.js'
import { getCachedBtcUsdRate } from '../services/btc-price.js'
import { homePage } from '../views/home.js'
import { detailPage } from '../views/detail.js'
import { aboutPage } from '../views/about.js'
import { apiDocsPage } from '../views/api-docs.js'
import { adminPage } from '../views/admin.js'
import { demoPage } from '../views/demo.js'
import { layout } from '../views/layout.js'

const router = Router()

router.get('/', (req, res) => {
  const { protocol, category, health, source, q, featured, sort, payment_valid, limit: rawLimit, offset: rawOffset } = req.query
  const filters = { protocol, category, health, source, q, featured: featured === 'true', sort, payment_valid: payment_valid === 'true' }

  const { services, total, limit, offset } = queryServices(db, {
    protocol, category, health, source, q, featured, sort, payment_valid, order: sort ? 'desc' : undefined, rawLimit, rawOffset,
  }, PAGE_COLUMNS)

  // Verified count: matches the payment_valid checkbox filter exactly
  const verifiedCount = db.prepare(
    "SELECT COUNT(*) as c FROM services WHERE (status = 'active' OR status IS NULL) AND ((protocol = 'x402' AND x402_payment_valid = 1) OR (protocol = 'L402' AND health_status = 'healthy'))"
  ).get().c

  // Health breakdown: ALL endpoints (unfiltered)
  const healthRows = db.prepare("SELECT health_status, COUNT(*) as c FROM services WHERE (status = 'active' OR status IS NULL) GROUP BY health_status").all()
  const stats = { verified: verifiedCount, healthy: 0, degraded: 0, down: 0, unknown: 0 }
  for (const row of healthRows) {
    stats[row.health_status] = row.c
  }

  // Total indexed (unfiltered) counts
  stats.totalIndexed = db.prepare("SELECT COUNT(*) as c FROM services WHERE (status = 'active' OR status IS NULL)").get().c

  // Distinct services (by hostname) and providers (hostname-based, filtered + unfiltered)
  const distinctHosts = new Set()
  const filteredProviders = { total: new Set(), L402: new Set(), x402: new Set() }
  const chainProviders = { base: new Set(), solana: new Set() }
  const allProviders = { total: new Set(), L402: new Set(), x402: new Set() }
  const allChainProviders = { base: new Set(), solana: new Set() }
  const allUrls = db.prepare('SELECT url, protocol, payment_network, is_template, is_demo, x402_payment_valid, health_status FROM services').all()
  for (const svc of allUrls) {
    let host
    try { host = new URL(svc.url).hostname } catch { continue }
    distinctHosts.add(host)
    // Unfiltered provider counts (excluding templates/demos only)
    if (!svc.is_template && !svc.is_demo) {
      allProviders.total.add(host)
      allProviders[svc.protocol]?.add(host)
      if (svc.protocol === 'x402') {
        const network = (svc.payment_network || '').toLowerCase()
        if (network === 'base' || network.includes('base')) allChainProviders.base.add(host)
        else if (network === 'solana' || network.includes('solana')) allChainProviders.solana.add(host)
      }
    }
    // Filtered provider counts: exclude x402 with payment_valid=0, exclude L402 without healthy status
    if (!svc.is_template && !svc.is_demo
      && !(svc.protocol === 'x402' && svc.x402_payment_valid === 0)
      && !(svc.protocol === 'L402' && svc.health_status !== 'healthy')) {
      filteredProviders.total.add(host)
      filteredProviders[svc.protocol]?.add(host)
      if (svc.protocol === 'x402') {
        const network = (svc.payment_network || '').toLowerCase()
        if (network === 'base' || network.includes('base')) chainProviders.base.add(host)
        else if (network === 'solana' || network.includes('solana')) chainProviders.solana.add(host)
      }
    }
  }
  stats.distinctServices = distinctHosts.size
  stats.distinctProviders = filteredProviders.total.size
  stats.l402Providers = filteredProviders.L402.size
  stats.x402Providers = filteredProviders.x402.size
  stats.baseProviders = chainProviders.base.size
  stats.solanaProviders = chainProviders.solana.size
  stats.allL402Providers = allProviders.L402.size
  stats.allBaseProviders = allChainProviders.base.size
  stats.allSolanaProviders = allChainProviders.solana.size

  // Categories for dropdown
  const categories = db.prepare(
    'SELECT category, COUNT(*) as count FROM services WHERE category IS NOT NULL GROUP BY category ORDER BY count DESC'
  ).all()

  const btcUsdRate = getCachedBtcUsdRate()
  res.send(homePage({ services, total, limit, offset, filters, stats, categories, btcUsdRate }))
})

// Service detail
router.get('/service/:id', (req, res) => {
  const service = db.prepare('SELECT * FROM services WHERE id = ?').get(req.params.id)
  if (!service) {
    return res.status(404).send(layout('Not Found', '<div class="container"><h1>Service not found</h1><p><a href="/">Back to directory</a></p></div>'))
  }

  const health_checks = db.prepare(
    'SELECT id, checked_at, status, response_time_ms, http_status, error_message FROM health_checks WHERE service_id = ? ORDER BY checked_at DESC LIMIT 20'
  ).all(req.params.id)

  res.send(detailPage({ ...service, health_checks }))
})

// About
router.get('/about', (req, res) => {
  res.send(aboutPage())
})

// API docs
router.get('/api-docs', (req, res) => {
  res.send(apiDocsPage())
})

// Demo page
router.get('/demo', (req, res) => {
  const ACTIVE_FILTER = "WHERE (status = 'active' OR status IS NULL)"

  // Gather stats
  const totalIndexed = db.prepare(`SELECT COUNT(*) as c FROM services ${ACTIVE_FILTER}`).get().c

  const verifiedCount = db.prepare(
    `SELECT COUNT(*) as c FROM services ${ACTIVE_FILTER} AND ((protocol = 'x402' AND x402_payment_valid = 1) OR (protocol = 'L402' AND health_status = 'healthy'))`
  ).get().c

  const healthRows = db.prepare(`SELECT health_status, COUNT(*) as c FROM services ${ACTIVE_FILTER} GROUP BY health_status`).all()
  const healthMap = { healthy: 0, degraded: 0, down: 0, unknown: 0 }
  for (const row of healthRows) {
    healthMap[row.health_status] = row.c
  }

  // Distinct providers (excluding templates/demos)
  const allUrls = db.prepare(`SELECT url, protocol, is_template, is_demo, x402_payment_valid, health_status FROM services ${ACTIVE_FILTER}`).all()
  const providerSets = { total: new Set(), L402: new Set(), x402: new Set() }
  for (const svc of allUrls) {
    if (svc.is_template || svc.is_demo) continue
    let host
    try { host = new URL(svc.url).hostname } catch { continue }
    providerSets.total.add(host)
    providerSets[svc.protocol]?.add(host)
  }

  // Protocol breakdowns
  const l402Total = db.prepare(`SELECT COUNT(*) as c FROM services ${ACTIVE_FILTER} AND protocol = 'L402'`).get().c
  const l402Healthy = db.prepare(`SELECT COUNT(*) as c FROM services ${ACTIVE_FILTER} AND protocol = 'L402' AND health_status = 'healthy'`).get().c
  const x402Total = db.prepare(`SELECT COUNT(*) as c FROM services ${ACTIVE_FILTER} AND protocol = 'x402'`).get().c
  const x402Verified = db.prepare(`SELECT COUNT(*) as c FROM services ${ACTIVE_FILTER} AND protocol = 'x402' AND x402_payment_valid = 1`).get().c
  const x402Healthy = db.prepare(`SELECT COUNT(*) as c FROM services ${ACTIVE_FILTER} AND protocol = 'x402' AND health_status = 'healthy'`).get().c

  const lastHealthCheck = db.prepare('SELECT MAX(checked_at) as t FROM health_checks').get()?.t || null

  const stats = {
    totalIndexed,
    verified: verifiedCount,
    distinctProviders: providerSets.total.size,
    ...healthMap,
    lastHealthCheck,
    l402: { endpoints: l402Total, verified: l402Healthy, healthy: l402Healthy, providers: providerSets.L402.size },
    x402: { endpoints: x402Total, verified: x402Verified, healthy: x402Healthy, providers: providerSets.x402.size },
  }

  // Probe sample for flow visualization
  const probeSample = buildProbeSample(db, 'L402')

  res.send(demoPage({ stats, probeSample }))
})

// Admin dashboard (auth is client-side via API calls)
router.get('/admin', (req, res) => {
  res.send(adminPage())
})

// ─── Probe Sample Builder ─────────────────────────────────────────────────────

export function buildProbeSample(database, protocol = 'L402') {
  const proto = protocol === 'x402' ? 'x402' : 'L402'

  // Find a healthy service with recent health check data
  const service = database.prepare(`
    SELECT id, name, url, protocol, price_sats, price_usd, category, provider, payment_asset, payment_network
    FROM services
    WHERE (status = 'active' OR status IS NULL)
      AND protocol = ?
      AND health_status = 'healthy'
      AND reliability_score IS NOT NULL
    ORDER BY reliability_score DESC
    LIMIT 1
  `).get(proto)

  if (!service) {
    return buildStaticProbeSample(proto)
  }

  const healthCheck = database.prepare(`
    SELECT checked_at, status, response_time_ms, http_status
    FROM health_checks
    WHERE service_id = ?
    ORDER BY checked_at DESC
    LIMIT 1
  `).get(service.id)

  const flow = proto === 'L402' ? {
    request: `GET ${service.url}`,
    responseStatus: 402,
    protocolHeaders: {
      L402: `WWW-Authenticate: L402 macaroon="AGIAJEem...", invoice="lnbc${service.price_sats || 100}n1..."`,
    },
    retryHeader: 'Authorization: L402 <macaroon>:<preimage>',
    successStatus: 200,
  } : {
    request: `GET ${service.url}`,
    responseStatus: 402,
    protocolHeaders: {
      x402: `PAYMENT-REQUIRED: { "accepts": [{ "asset": "${service.payment_asset || 'USDC'}", "amount": "${service.price_usd ? Math.round(service.price_usd * 1000000) : '10000'}", "facilitator": "https://x402.org/facilitator" }] }`,
    },
    retryHeader: 'X-PAYMENT: <base64-encoded-signed-payment>',
    successStatus: 200,
  }

  return {
    service: {
      name: service.name,
      url: service.url,
      protocol: service.protocol,
      price_sats: service.price_sats,
      price_usd: service.price_usd,
      category: service.category,
      provider: service.provider,
    },
    healthCheck: healthCheck || {
      checked_at: null,
      status: 'unknown',
      response_time_ms: null,
      http_status: null,
    },
    flow,
  }
}

function buildStaticProbeSample(protocol) {
  if (protocol === 'x402') {
    return {
      service: {
        name: 'Example x402 API',
        url: 'https://api.example.com/data',
        protocol: 'x402',
        price_sats: null,
        price_usd: 0.01,
        category: 'data',
        provider: 'Example',
      },
      healthCheck: { checked_at: null, status: 'unknown', response_time_ms: null, http_status: null },
      flow: {
        request: 'GET https://api.example.com/data',
        responseStatus: 402,
        protocolHeaders: {
          x402: 'PAYMENT-REQUIRED: { "accepts": [{ "asset": "USDC", "amount": "10000", "facilitator": "https://x402.org/facilitator" }] }',
        },
        retryHeader: 'X-PAYMENT: <base64-encoded-signed-payment>',
        successStatus: 200,
      },
    }
  }
  return {
    service: {
      name: 'Example L402 API',
      url: 'https://api.example.com/weather',
      protocol: 'L402',
      price_sats: 10,
      price_usd: null,
      category: 'data/weather',
      provider: 'Example',
    },
    healthCheck: { checked_at: null, status: 'unknown', response_time_ms: null, http_status: null },
    flow: {
      request: 'GET https://api.example.com/weather',
      responseStatus: 402,
      protocolHeaders: {
        L402: 'WWW-Authenticate: L402 macaroon="AGIAJEem...", invoice="lnbc100n1..."',
      },
      retryHeader: 'Authorization: L402 <macaroon>:<preimage>',
      successStatus: 200,
    },
  }
}

export default router
