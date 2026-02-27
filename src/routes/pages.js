import { Router } from 'express'
import db from '../db.js'
import { homePage } from '../views/home.js'
import { detailPage } from '../views/detail.js'
import { aboutPage } from '../views/about.js'
import { apiDocsPage } from '../views/api-docs.js'

const router = Router()

// Home — service listing
router.get('/', (req, res) => {
  const {
    protocol,
    category,
    health,
    source,
    q,
    featured,
    limit: rawLimit,
    offset: rawOffset,
  } = req.query

  const limit = Math.min(Math.max(parseInt(rawLimit) || 50, 1), 200)
  const offset = Math.max(parseInt(rawOffset) || 0, 0)

  const filters = { protocol, category, health, source, q, featured: featured === 'true' }

  const conditions = []
  const params = {}

  if (protocol) {
    conditions.push('protocol = @protocol COLLATE NOCASE')
    params.protocol = protocol
  }
  if (category) {
    conditions.push("(category = @category OR category LIKE @categoryPrefix)")
    params.category = category
    params.categoryPrefix = category + '/%'
  }
  if (health) {
    conditions.push('health_status = @health')
    params.health = health
  }
  if (source) {
    conditions.push('source = @source')
    params.source = source
  }
  if (q) {
    conditions.push("(name LIKE @q OR description LIKE @q)")
    params.q = `%${q}%`
  }
  if (featured === 'true') {
    conditions.push('featured = 1')
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : ''

  const orderBy = `ORDER BY
    featured DESC,
    CASE WHEN featured = 1 THEN 0 ELSE CASE WHEN category != 'uncategorized' THEN 0 ELSE 1 END END,
    CASE health_status WHEN 'healthy' THEN 0 WHEN 'degraded' THEN 1 WHEN 'down' THEN 2 WHEN 'unknown' THEN 3 END,
    name`

  const total = db.prepare(`SELECT COUNT(*) as c FROM services ${where}`).get(params).c
  const services = db.prepare(
    `SELECT id, name, url, protocol, price_sats, price_usd, payment_asset, category, provider, source, featured, health_status, latency_p50_ms
     FROM services ${where} ${orderBy} LIMIT @limit OFFSET @offset`
  ).all({ ...params, limit, offset })

  // Stats for the stats bar
  const statsRows = db.prepare('SELECT health_status, COUNT(*) as c FROM services GROUP BY health_status').all()
  const stats = { total: 0, healthy: 0, degraded: 0, down: 0, unknown: 0 }
  for (const row of statsRows) {
    stats[row.health_status] = row.c
    stats.total += row.c
  }

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
    return res.status(404).send('<h1>Not found</h1>')
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

export default router
