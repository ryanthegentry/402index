import { Router } from 'express'
import db from '../db.js'
import { queryServices, API_COLUMNS } from '../queries/services.js'

const router = Router()

router.get('/services', (req, res) => {
  const { limit: rawLimit, offset: rawOffset, ...filters } = req.query
  res.json(queryServices(db, { ...filters, rawLimit, rawOffset }, API_COLUMNS))
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
