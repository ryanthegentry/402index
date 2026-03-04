import { Router } from 'express'
import db from '../db.js'
import { queryServices, PAGE_COLUMNS } from '../queries/services.js'
import { homePage } from '../views/home.js'
import { detailPage } from '../views/detail.js'
import { aboutPage } from '../views/about.js'
import { apiDocsPage } from '../views/api-docs.js'
import { adminPage } from '../views/admin.js'
import { layout } from '../views/layout.js'

const router = Router()

router.get('/', (req, res) => {
  const { protocol, category, health, source, q, featured, sort, payment_valid, limit: rawLimit, offset: rawOffset } = req.query
  const filters = { protocol, category, health, source, q, featured: featured === 'true', sort, payment_valid: payment_valid === 'true' }

  const { services, total, limit, offset } = queryServices(db, {
    protocol, category, health, source, q, featured, sort, payment_valid, order: sort ? 'desc' : undefined, rawLimit, rawOffset,
  }, PAGE_COLUMNS)

  const statsRows = db.prepare("SELECT health_status, COUNT(*) as c FROM services WHERE NOT (protocol = 'x402' AND x402_payment_valid = 0) GROUP BY health_status").all()
  const stats = { total: 0, healthy: 0, degraded: 0, down: 0, unknown: 0 }
  for (const row of statsRows) {
    stats[row.health_status] = row.c
    stats.total += row.c
  }

  // Distinct services (by hostname) and providers (hostname-based, filtered)
  const distinctHosts = new Set()
  const filteredProviders = { total: new Set(), L402: new Set(), x402: new Set() }
  const chainProviders = { base: new Set(), solana: new Set() }
  const allUrls = db.prepare('SELECT url, protocol, payment_network, is_template, is_demo, x402_payment_valid FROM services').all()
  for (const svc of allUrls) {
    let host
    try { host = new URL(svc.url).hostname } catch { continue }
    distinctHosts.add(host)
    if (!svc.is_template && !svc.is_demo && !(svc.protocol === 'x402' && svc.x402_payment_valid === 0)) {
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

  // Categories for dropdown
  const categories = db.prepare(
    'SELECT category, COUNT(*) as count FROM services WHERE category IS NOT NULL GROUP BY category ORDER BY count DESC'
  ).all()

  res.send(homePage({ services, total, limit, offset, filters, stats, categories }))
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

// Admin dashboard (auth is client-side via API calls)
router.get('/admin', (req, res) => {
  res.send(adminPage())
})

export default router
