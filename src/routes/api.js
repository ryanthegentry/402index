import { Router } from 'express'
import db from '../db.js'

const router = Router()

// GET /api/v1/services
router.get('/services', (req, res) => {
  const {
    protocol,
    category,
    health,
    source,
    max_price_usd,
    payment_asset,
    q,
    featured,
    sort,
    order,
    limit: rawLimit,
    offset: rawOffset,
  } = req.query

  const limit = Math.min(Math.max(parseInt(rawLimit) || 50, 1), 200)
  const offset = Math.max(parseInt(rawOffset) || 0, 0)

  const conditions = []
  const params = {}

  if (protocol) {
    conditions.push('protocol = @protocol COLLATE NOCASE')
    params.protocol = protocol
  }
  if (category) {
    // Prefix match: 'crypto' matches 'crypto/nft', 'crypto/defi', etc.
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
  if (max_price_usd) {
    conditions.push('price_usd <= @max_price_usd')
    params.max_price_usd = parseFloat(max_price_usd)
  }
  if (payment_asset) {
    conditions.push('payment_asset = @payment_asset')
    params.payment_asset = payment_asset
  }
  if (q) {
    conditions.push("(name LIKE @q OR description LIKE @q)")
    params.q = `%${q}%`
  }
  if (featured === 'true' || featured === '1') {
    conditions.push('featured = 1')
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : ''

  const sortColumns = { name: 'name', price: 'price_usd', latency: 'latency_p50_ms', uptime: 'uptime_30d' }
  const sortCol = sortColumns[sort]
  const sortDir = order === 'desc' ? 'DESC' : 'ASC'

  const orderBy = sortCol
    ? `ORDER BY featured DESC, ${sortCol} ${sortDir}`
    : `ORDER BY
    featured DESC,
    CASE WHEN featured = 1 THEN 0 ELSE CASE WHEN category != 'uncategorized' THEN 0 ELSE 1 END END,
    CASE health_status WHEN 'healthy' THEN 0 WHEN 'degraded' THEN 1 WHEN 'down' THEN 2 WHEN 'unknown' THEN 3 END,
    name`

  const total = db.prepare(`SELECT COUNT(*) as c FROM services ${where}`).get(params).c
  const services = db.prepare(
    `SELECT id, name, description, url, protocol, price_sats, price_usd, payment_asset, payment_network, category, provider, source, featured, health_status, uptime_30d, latency_p50_ms, last_checked, registered_at
     FROM services ${where} ${orderBy} LIMIT @limit OFFSET @offset`
  ).all({ ...params, limit, offset })

  res.json({ services, total, limit, offset })
})

// GET /api/v1/services/:id
router.get('/services/:id', (req, res) => {
  const service = db.prepare('SELECT * FROM services WHERE id = ?').get(req.params.id)
  if (!service) {
    return res.status(404).json({ error: 'Service not found' })
  }

  const health_checks = db.prepare(
    'SELECT id, checked_at, status, response_time_ms, http_status, error_message FROM health_checks WHERE service_id = ? ORDER BY checked_at DESC LIMIT 20'
  ).all(req.params.id)

  res.json({ ...service, health_checks })
})

// GET /api/v1/health
router.get('/health', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as c FROM services').get().c

  const byProtocol = {}
  db.prepare('SELECT protocol, COUNT(*) as c FROM services GROUP BY protocol').all()
    .forEach(r => { byProtocol[r.protocol] = r.c })

  const byHealth = {}
  db.prepare('SELECT health_status, COUNT(*) as c FROM services GROUP BY health_status').all()
    .forEach(r => { byHealth[r.health_status] = r.c })

  const bySource = {}
  db.prepare('SELECT source, COUNT(*) as c FROM services GROUP BY source').all()
    .forEach(r => { bySource[r.source] = r.c })

  const lastBazaarSync = db.prepare(
    "SELECT MAX(updated_at) as t FROM services WHERE source = 'bazaar'"
  ).get()?.t || null

  const lastSatringSync = db.prepare(
    "SELECT MAX(updated_at) as t FROM services WHERE source = 'satring'"
  ).get()?.t || null

  const lastHealthCheck = db.prepare(
    'SELECT MAX(checked_at) as t FROM health_checks'
  ).get()?.t || null

  res.json({
    status: 'ok',
    total_services: total,
    by_protocol: byProtocol,
    by_health: byHealth,
    by_source: bySource,
    last_bazaar_sync: lastBazaarSync,
    last_satring_sync: lastSatringSync,
    last_health_check_run: lastHealthCheck,
  })
})

// GET /api/v1/categories
router.get('/categories', (req, res) => {
  const rows = db.prepare(
    'SELECT category, COUNT(*) as count FROM services WHERE category IS NOT NULL GROUP BY category ORDER BY count DESC'
  ).all()

  // Build tree: { "crypto": { count: 100, subcategories: { "nft": 13, "defi": 45 } } }
  const tree = {}
  for (const { category, count } of rows) {
    const parts = category.split('/')
    const top = parts[0]
    if (!tree[top]) tree[top] = { count: 0, subcategories: {} }
    tree[top].count += count
    if (parts.length > 1) {
      tree[top].subcategories[parts.slice(1).join('/')] = count
    }
  }

  res.json({ categories: tree, total: rows.length })
})

export default router
