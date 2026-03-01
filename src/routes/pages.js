import { Router } from 'express'
import db from '../db.js'
import { queryServices, PAGE_COLUMNS } from '../queries/services.js'
import { homePage } from '../views/home.js'
import { detailPage } from '../views/detail.js'
import { aboutPage } from '../views/about.js'
import { apiDocsPage } from '../views/api-docs.js'
import { layout } from '../views/layout.js'

const router = Router()

router.get('/', (req, res) => {
  const { protocol, category, health, source, q, featured, limit: rawLimit, offset: rawOffset } = req.query
  const filters = { protocol, category, health, source, q, featured: featured === 'true' }

  const { services, total, limit, offset } = queryServices(db, {
    protocol, category, health, source, q, featured, rawLimit, rawOffset,
  }, PAGE_COLUMNS)

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

export default router
