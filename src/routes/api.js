import { Router } from 'express'
import { randomUUID } from 'crypto'
import db, { logQuery } from '../db.js'
import { queryServices, buildServiceQuery, API_COLUMNS } from '../queries/services.js'
import { getCachedBtcUsdRate } from '../services/btc-price.js'
import { normalizeUrl } from '../services/url-normalize.js'
import { verifyL402 } from '../services/l402-verify.js'
import { getProvider } from '../services/l402-provider.js'
import { registerWebhook, deleteWebhook, getWebhook } from '../services/webhooks.js'
import { emit } from '../services/events.js'
import { findOpportunities } from '../services/opportunities.js'
import { discoverProbeConfig } from '../services/wellknown-discovery.js'

const router = Router()

router.get('/services', (req, res) => {
  const startTime = Date.now()
  const { limit: rawLimit, offset: rawOffset, ...filters } = req.query
  const result = queryServices(db, { ...filters, rawLimit, rawOffset }, API_COLUMNS)
  res.json(result)

  const { q, ...filterParams } = filters
  logQuery({
    queryText: q || null,
    filters: JSON.stringify(filterParams),
    resultCount: result.total,
    responseTimeMs: Date.now() - startTime,
    userAgent: req.get('User-Agent') || null,
  })
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

// CSV export (L402-gated)
const CSV_COLUMNS = 'id, name, description, url, protocol, price_sats, price_usd, payment_asset, payment_network, category, provider, source, health_status, uptime_30d, latency_p50_ms, last_checked, http_method, reliability_score'

function escapeCsvField(value) {
  if (value == null) return ''
  const str = String(value)
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"'
  }
  return str
}

router.get('/export.csv', async (req, res) => {
  if (!req.l402Verified) {
    const priceSats = parseInt(process.env.L402_PRICE_SATS) || 500
    const durationHours = parseInt(process.env.L402_DURATION_HOURS) || 24
    try {
      const provider = getProvider()
      const challenge = await provider.createChallenge(priceSats, durationHours)
      if (challenge) {
        const wwwAuth = `L402 macaroon="${challenge.macaroon}", invoice="${challenge.invoice}"`
        return res.status(402).set('WWW-Authenticate', wwwAuth).json({
          error: 'Payment Required',
          message: 'CSV export requires L402 payment. Pay the Lightning invoice to download.',
          invoice: challenge.invoice,
          macaroon: challenge.macaroon,
          payment_hash: challenge.paymentHash,
          price_sats: priceSats,
          duration_hours: durationHours,
        })
      }
    } catch (err) {
      console.error('[export.csv] L402 challenge creation failed:', err.message)
    }
    // Fallback: bare 402 (graceful degradation if provider unavailable)
    return res.status(402).json({
      error: 'Payment Required',
      message: 'CSV export requires L402 payment. Add ?l402=require to any API endpoint, or include an L402 token in the Authorization header.',
    })
  }

  const { limit: _limit, offset: _offset, ...filters } = req.query
  const { where, params, orderBy } = buildServiceQuery({ ...filters, rawLimit: 10000, rawOffset: 0 })
  const services = db.prepare(`SELECT ${CSV_COLUMNS} FROM services ${where} ${orderBy}`).all(params)

  const btcUsdRate = getCachedBtcUsdRate()
  const headers = CSV_COLUMNS.split(', ')
  const csvRows = [headers.join(',')]

  for (const svc of services) {
    // Convert sats-only to USD
    if (svc.price_usd == null && svc.price_sats != null && btcUsdRate) {
      svc.price_usd = (svc.price_sats / 100_000_000) * btcUsdRate
    }
    csvRows.push(headers.map(h => escapeCsvField(svc[h])).join(','))
  }

  const date = new Date().toISOString().slice(0, 10)
  res.setHeader('Content-Type', 'text/csv')
  res.setHeader('Content-Disposition', `attachment; filename="402index-export-${date}.csv"`)
  res.send(csvRows.join('\n'))
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
  const ACTIVE_FILTER = "WHERE (status = 'active' OR status IS NULL)"

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
  INSERT INTO services (id, name, description, url, protocol, price_sats, price_usd, payment_asset, payment_network, category, provider, source, contact_email, http_method, probe_body, health_status, status)
  VALUES (@id, @name, @description, @url, @protocol, @price_sats, @price_usd, @payment_asset, @payment_network, @category, @provider, 'self-registered', @contact_email, @http_method, @probe_body, 'healthy', 'pending')
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
    http_method = COALESCE(excluded.http_method, services.http_method),
    probe_body = COALESCE(excluded.probe_body, services.probe_body),
    health_status = 'healthy',
    status = CASE WHEN services.status = 'active' THEN 'active' ELSE services.status END,
    updated_at = datetime('now')
  RETURNING *
`)

const REQUIRED_FIELDS = ['url', 'name', 'protocol']
const VALID_HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE'])
const MAX_LENGTHS = { name: 200, description: 2000, url: 2000, provider: 200, category: 100, payment_asset: 50, payment_network: 50, contact_email: 254, http_method: 10, probe_body: 4000 }

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

    // Validate protocol — only L402 accepted (case-insensitive)
    if (String(body.protocol).toUpperCase() !== 'L402') {
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

    // Validate http_method (optional, defaults to GET)
    let httpMethod = body.http_method ? String(body.http_method).toUpperCase() : 'GET'
    if (!VALID_HTTP_METHODS.has(httpMethod)) {
      return res.status(400).json({
        error: `Invalid http_method "${body.http_method}". Must be one of: ${[...VALID_HTTP_METHODS].join(', ')}`,
      })
    }

    // Validate probe_body (optional, must be valid JSON)
    let probeBody = '{}'
    if (body.probe_body != null) {
      try {
        JSON.parse(body.probe_body)
        probeBody = body.probe_body
      } catch {
        return res.status(400).json({ error: 'probe_body must be valid JSON' })
      }
    }

    // Normalize URL
    const url = normalizeUrl(body.url)

    // Run L402 verification probe
    let probe = await verifyL402(url, httpMethod, probeBody)

    // If probe failed with 400 or 406, try .well-known auto-discovery
    let discoveredConfig = null
    if (!probe.valid && [400, 406].includes(probe.httpStatus)) {
      discoveredConfig = await discoverProbeConfig(url)
      if (discoveredConfig) {
        console.log(`[register] .well-known discovery found config for ${url}: method=${discoveredConfig.method}, body=${discoveredConfig.probeBody.substring(0, 100)}`)
        probe = await verifyL402(url, discoveredConfig.method, discoveredConfig.probeBody)
      }
    }

    if (!probe.valid) {
      const response = {
        error: 'L402 verification failed',
        detail: probe.error,
        probe: {
          httpStatus: probe.httpStatus,
          hasWwwAuthenticate: probe.hasWwwAuthenticate,
          scheme: probe.scheme,
          hasMacaroon: probe.hasMacaroon,
          hasInvoice: probe.hasInvoice,
        },
      }
      if (discoveredConfig) {
        response.wellknown_attempted = true
        response.detail += ' (Also attempted .well-known auto-discovery — the constructed probe body did not trigger an L402 challenge. Try providing an explicit probe_body parameter.)'
      }
      return res.status(422).json(response)
    }

    // If discovery succeeded, use the discovered config for the stored record
    if (discoveredConfig && probe.valid) {
      if (!body.http_method) {
        httpMethod = discoveredConfig.method
      }
      if (!body.probe_body) {
        probeBody = discoveredConfig.probeBody
      }
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
      http_method: httpMethod,
      probe_body: probeBody !== '{}' ? probeBody : null,
    }

    const service = registerUpsert().get(params)

    // Fire-and-forget event distribution (webhooks, Nostr, email — only on genuinely new registrations)
    if (service.registered_at === service.updated_at) {
      emit('service.new', service, db)
    }

    const message = service.status === 'active'
      ? 'Service updated (already active)'
      : 'Service registered and pending review'

    return res.status(201).json({
      message,
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

// ─── Demo Endpoints ──────────────────────────────────────────────────────────

import { buildProbeSample } from './pages.js'
import { validateProbeUrl, runProbeSteps } from '../services/probe-live.js'

router.get('/demo/probe-sample', (req, res) => {
  const protocol = req.query.protocol || 'L402'
  const sample = buildProbeSample(db, protocol)
  res.json(sample)
})

// SSE live probe — streams health check steps in real time
const probeLiveRateLimit = new Map()
const PROBE_RATE_LIMIT_MS = 12000 // 5 per minute
const PROBE_RATE_LIMIT_MAX = 5

router.get('/demo/probe-live', async (req, res) => {
  const url = req.query.url
  const validationError = validateProbeUrl(url)
  if (validationError) {
    return res.status(400).json({ error: validationError })
  }

  // Rate limit by IP
  const ip = req.ip || req.connection.remoteAddress
  const now = Date.now()
  const entries = probeLiveRateLimit.get(ip) || []
  const recent = entries.filter(t => now - t < 60000)
  if (recent.length >= PROBE_RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Rate limit exceeded — max 5 probes per minute' })
  }
  recent.push(now)
  probeLiveRateLimit.set(ip, recent)

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  try {
    for await (const step of runProbeSteps(url, db)) {
      if (res.writableEnded) break
      res.write(`data: ${JSON.stringify(step)}\n\n`)
    }
  } catch (err) {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ step: 'error', message: err.message })}\n\n`)
    }
  }

  if (!res.writableEnded) {
    res.end()
  }
})

// ─── Admin Endpoints ──────────────────────────────────────────────────────────

const getPending = () => stmt('getPending', "SELECT * FROM services WHERE status = 'pending' ORDER BY registered_at DESC")

const approveService = () => stmt('approveService', `
  UPDATE services SET status = 'active', updated_at = datetime('now') WHERE id = @id AND status = 'pending'
`)

const rejectService = () => stmt('rejectService', `
  UPDATE services SET status = 'rejected', updated_at = datetime('now') WHERE id = @id AND status = 'pending'
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
  res.json({ message: 'Service rejected', id: req.params.id })
})

router.post('/admin/vacuum', (req, res) => {
  try {
    const before = db.pragma('page_count', { simple: true }) * db.pragma('page_size', { simple: true })
    db.exec('VACUUM')
    const after = db.pragma('page_count', { simple: true }) * db.pragma('page_size', { simple: true })
    const freed = before - after
    res.json({
      message: 'VACUUM complete',
      before_bytes: before,
      after_bytes: after,
      freed_bytes: freed,
      freed_mb: (freed / 1024 / 1024).toFixed(1),
    })
  } catch (err) {
    res.status(500).json({ error: `VACUUM failed: ${err.message}` })
  }
})

// ─── Opportunities ─────────────────────────────────────────────────────────────

router.get('/opportunities', (req, res) => {
  const opportunities = findOpportunities(db, { protocol: req.query.protocol })
  res.json({ opportunities, total: opportunities.length })
})

// ─── Webhooks ──────────────────────────────────────────────────────────────────

router.post('/webhooks', async (req, res) => {
  try {
    const { url, secret, events, protocol_filter } = req.body || {}
    const result = registerWebhook(db, { url, secret, events, protocol_filter })
    res.status(201).json(result)
  } catch (err) {
    const status = err.message.includes('required') || err.message.includes('HTTPS') || err.message.includes('Invalid') ? 400 : 500
    res.status(status).json({ error: err.message })
  }
})

router.get('/webhooks/:id', (req, res) => {
  try {
    const secret = req.headers['x-webhook-secret']
    if (!secret) return res.status(401).json({ error: 'X-Webhook-Secret header required' })
    const result = getWebhook(db, req.params.id, secret)
    res.json(result)
  } catch (err) {
    if (err.message.includes('not found')) return res.status(404).json({ error: err.message })
    if (err.message.includes('Unauthorized')) return res.status(401).json({ error: err.message })
    res.status(500).json({ error: err.message })
  }
})

router.delete('/webhooks/:id', (req, res) => {
  try {
    const secret = req.headers['x-webhook-secret']
    if (!secret) return res.status(401).json({ error: 'X-Webhook-Secret header required' })
    deleteWebhook(db, req.params.id, secret)
    res.json({ deleted: true })
  } catch (err) {
    if (err.message.includes('not found')) return res.status(404).json({ error: err.message })
    if (err.message.includes('Unauthorized')) return res.status(401).json({ error: err.message })
    res.status(500).json({ error: err.message })
  }
})

export default router
