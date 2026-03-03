import { Router } from 'express'
import { randomUUID } from 'crypto'
import db from '../db.js'
import { queryServices, API_COLUMNS } from '../queries/services.js'
import { normalizeUrl } from '../services/url-normalize.js'
import { verifyL402 } from '../services/l402-verify.js'
import { sendRegistrationNotification } from '../services/notify.js'

const router = Router()

router.get('/services', (req, res) => {
  const { limit: rawLimit, offset: rawOffset, ...filters } = req.query
  res.json(queryServices(db, { ...filters, rawLimit, rawOffset }, API_COLUMNS))
})

// GET /api/v1/services/:id
router.get('/services/:id', (req, res) => {
  const service = db.prepare("SELECT * FROM services WHERE id = ? AND (status = 'active' OR status IS NULL)").get(req.params.id)
  if (!service) {
    return res.status(404).json({ error: 'Service not found' })
  }

  const health_checks = db.prepare(
    'SELECT id, checked_at, status, response_time_ms, http_status, error_message FROM health_checks WHERE service_id = ? ORDER BY checked_at DESC LIMIT 20'
  ).all(req.params.id)

  res.json({ ...service, health_checks })
})

// Extract hostname from a URL (strips scheme and path)
function extractHostname(url) {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

// GET /api/v1/health
router.get('/health', (req, res) => {
  const ACTIVE_FILTER = "WHERE status = 'active' OR status IS NULL"

  const total = db.prepare(`SELECT COUNT(*) as c FROM services ${ACTIVE_FILTER}`).get().c

  const byProtocol = {}
  db.prepare(`SELECT protocol, COUNT(*) as c FROM services ${ACTIVE_FILTER} GROUP BY protocol`).all()
    .forEach(r => { byProtocol[r.protocol] = r.c })

  const byHealth = {}
  db.prepare(`SELECT health_status, COUNT(*) as c FROM services ${ACTIVE_FILTER} GROUP BY health_status`).all()
    .forEach(r => { byHealth[r.health_status] = r.c })

  const bySource = {}
  db.prepare(`SELECT source, COUNT(*) as c FROM services ${ACTIVE_FILTER} GROUP BY source`).all()
    .forEach(r => { bySource[r.source] = r.c })

  // Distinct services (by hostname) and providers — computed in JS since SQLite
  // lacks a reliable URL hostname extractor. Hostname = provider key.
  const allServices = db.prepare(`SELECT url, protocol, is_template, is_demo FROM services ${ACTIVE_FILTER}`).all()
  const hostnameSets = { total: new Set(), L402: new Set(), x402: new Set() }
  const rawProviders = { total: new Set(), L402: new Set(), x402: new Set() }
  const filteredProviders = { total: new Set(), L402: new Set(), x402: new Set() }

  for (const svc of allServices) {
    const host = extractHostname(svc.url)
    hostnameSets.total.add(host)
    hostnameSets[svc.protocol]?.add(host)

    rawProviders.total.add(host)
    rawProviders[svc.protocol]?.add(host)

    if (!svc.is_template && !svc.is_demo) {
      filteredProviders.total.add(host)
      filteredProviders[svc.protocol]?.add(host)
    }
  }

  const excludedTemplates = db.prepare('SELECT COUNT(*) as c FROM services WHERE is_template = 1').get().c
  const excludedDemos = db.prepare('SELECT COUNT(*) as c FROM services WHERE is_demo = 1').get().c

  const lastBazaarSync = db.prepare(
    "SELECT MAX(updated_at) as t FROM services WHERE source = 'bazaar'"
  ).get()?.t || null

  const lastSatringSync = db.prepare(
    "SELECT MAX(updated_at) as t FROM services WHERE source = 'satring'"
  ).get()?.t || null

  const lastL402AppsSync = db.prepare(
    "SELECT MAX(updated_at) as t FROM services WHERE source LIKE '%l402apps%'"
  ).get()?.t || null

  const lastHealthCheck = db.prepare(
    'SELECT MAX(checked_at) as t FROM health_checks'
  ).get()?.t || null

  res.json({
    status: 'ok',
    total_endpoints: total,
    distinct_services: hostnameSets.total.size,
    distinct_providers_raw: rawProviders.total.size,
    distinct_providers: filteredProviders.total.size,
    excluded_templates: excludedTemplates,
    excluded_demos: excludedDemos,
    by_protocol: Object.fromEntries(
      Object.entries(byProtocol).map(([proto, endpoints]) => [proto, {
        endpoints,
        services: hostnameSets[proto]?.size || 0,
        providers_raw: rawProviders[proto]?.size || 0,
        providers: filteredProviders[proto]?.size || 0,
      }])
    ),
    by_health: byHealth,
    by_source: bySource,
    last_bazaar_sync: lastBazaarSync,
    last_satring_sync: lastSatringSync,
    last_l402apps_sync: lastL402AppsSync,
    last_health_check_run: lastHealthCheck,
  })
})

// GET /api/v1/categories
router.get('/categories', (req, res) => {
  const rows = db.prepare(
    "SELECT category, COUNT(*) as count FROM services WHERE category IS NOT NULL AND (status = 'active' OR status IS NULL) GROUP BY category ORDER BY count DESC"
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

// Lazy-initialized prepared statements for registration
const stmts = {}
function stmt(key, sql) {
  if (!stmts[key]) stmts[key] = db.prepare(sql)
  return stmts[key]
}

const registerUpsert = () => stmt('registerUpsert', `
  INSERT INTO services (id, name, description, url, protocol, price_sats, price_usd, payment_asset, payment_network, category, provider, source, contact_email, health_status, status)
  VALUES (@id, @name, @description, @url, @protocol, @price_sats, @price_usd, @payment_asset, @payment_network, @category, @provider, 'self-registered', @contact_email, 'healthy', 'pending')
  ON CONFLICT(url, protocol) DO UPDATE SET
    name = excluded.name,
    description = COALESCE(excluded.description, services.description),
    price_sats = COALESCE(excluded.price_sats, services.price_sats),
    price_usd = COALESCE(excluded.price_usd, services.price_usd),
    payment_asset = COALESCE(excluded.payment_asset, services.payment_asset),
    payment_network = COALESCE(excluded.payment_network, services.payment_network),
    category = COALESCE(excluded.category, services.category),
    provider = COALESCE(excluded.provider, services.provider),
    contact_email = COALESCE(excluded.contact_email, services.contact_email),
    health_status = 'healthy',
    status = 'pending',
    updated_at = datetime('now')
  RETURNING *
`)

const REQUIRED_FIELDS = ['url', 'name', 'protocol']
const MAX_LENGTHS = { name: 200, description: 2000, url: 2000, provider: 200, category: 100, payment_asset: 50, payment_network: 50, contact_email: 254 }

// POST /api/v1/register
router.post('/register', async (req, res) => {
  try {
    const body = req.body
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'Request body must be JSON' })
    }

    // Validate required fields
    const missing = REQUIRED_FIELDS.filter(f => !body[f])
    if (missing.length > 0) {
      return res.status(400).json({
        error: `Missing required fields: ${missing.join(', ')}`,
        required: REQUIRED_FIELDS,
      })
    }

    // Validate protocol — only L402 accepted
    if (body.protocol !== 'L402') {
      return res.status(400).json({
        error: 'Invalid protocol. Only "L402" is currently accepted.',
      })
    }

    // Validate URL scheme
    let parsedUrl
    try {
      parsedUrl = new URL(body.url)
    } catch {
      return res.status(400).json({ error: 'Invalid URL format' })
    }
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
      return res.status(400).json({ error: 'URL must use http or https scheme' })
    }

    // Validate max lengths
    for (const [field, max] of Object.entries(MAX_LENGTHS)) {
      if (body[field] && String(body[field]).length > max) {
        return res.status(400).json({ error: `${field} exceeds maximum length of ${max} characters` })
      }
    }

    // Validate email format (basic @ check)
    if (body.contact_email && !body.contact_email.includes('@')) {
      return res.status(400).json({ error: 'Invalid contact_email format' })
    }

    // Normalize URL
    const url = normalizeUrl(body.url)

    // Run L402 verification probe
    const probe = await verifyL402(url)
    if (!probe.valid) {
      return res.status(422).json({
        error: 'L402 verification failed',
        detail: probe.error,
        probe: {
          httpStatus: probe.httpStatus,
          hasWwwAuthenticate: probe.hasWwwAuthenticate,
          scheme: probe.scheme,
          hasMacaroon: probe.hasMacaroon,
          hasInvoice: probe.hasInvoice,
        },
      })
    }

    // Insert with status='pending' for admin review
    const params = {
      id: randomUUID(),
      name: body.name,
      description: body.description || null,
      url,
      protocol: 'L402',
      price_sats: body.price_sats != null ? Number(body.price_sats) : null,
      price_usd: body.price_usd != null ? Number(body.price_usd) : null,
      payment_asset: body.payment_asset || null,
      payment_network: body.payment_network || null,
      category: body.category || 'uncategorized',
      provider: body.provider || null,
      contact_email: body.contact_email || null,
    }

    const service = registerUpsert().get(params)

    // Fire-and-forget email notification
    sendRegistrationNotification(service).catch(err => {
      console.error('[register] Notification failed:', err.message)
    })

    return res.status(201).json({
      message: 'Service registered and pending review',
      service,
      verification: {
        httpStatus: probe.httpStatus,
        scheme: probe.scheme,
        hasMacaroon: probe.hasMacaroon,
        hasInvoice: probe.hasInvoice,
      },
    })
  } catch (err) {
    console.error('[register] Error:', err.message)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// ─── Admin Endpoints ──────────────────────────────────────────────────────────

const getPending = () => stmt('getPending', "SELECT * FROM services WHERE status = 'pending' ORDER BY registered_at DESC")

const approveService = () => stmt('approveService', `
  UPDATE services SET status = 'active', updated_at = datetime('now') WHERE id = @id AND status = 'pending'
`)

const rejectService = () => stmt('rejectService', `
  DELETE FROM services WHERE id = @id AND status = 'pending'
`)

router.get('/admin/pending', (req, res) => {
  const services = getPending().all()
  res.json({ services, total: services.length })
})

router.post('/admin/approve/:id', (req, res) => {
  const result = approveService().run({ id: req.params.id })
  if (result.changes === 0) {
    return res.status(404).json({ error: 'No pending service with that ID' })
  }
  res.json({ message: 'Service approved', id: req.params.id })
})

router.post('/admin/reject/:id', (req, res) => {
  const result = rejectService().run({ id: req.params.id })
  if (result.changes === 0) {
    return res.status(404).json({ error: 'No pending service with that ID' })
  }
  res.json({ message: 'Service rejected and deleted', id: req.params.id })
})

export default router
