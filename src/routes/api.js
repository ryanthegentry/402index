import { Router } from 'express'
import { randomUUID, randomBytes, createHash } from 'crypto'
import { constantTimeEqual } from '../util/constant-time.js'
import db, { logQuery } from '../db.js'
import { queryServices, queryServicesHybrid, buildServiceQuery, API_COLUMNS } from '../queries/services.js'
import { getCachedBtcUsdRate } from '../services/btc-price.js'
import { normalizeUrl, extractHostname } from '../services/url-normalize.js'
import { probeEndpoint } from '../services/probe-endpoint.js'
import { getPrimaryDetection } from '../services/detect-protocol.js'
import { getProvider } from '../services/l402-provider.js'
import { registerWebhook, deleteWebhook, getWebhook } from '../services/webhooks.js'
import { emit } from '../services/events.js'
import { findOpportunities } from '../services/opportunities.js'
import { discoverProbeConfig } from '../services/wellknown-discovery.js'
import { getSnapshots } from '../services/daily-snapshot.js'
import { openapiSpec, generateMarkdownDocs } from '../openapi.js'
import { initiateClaim, verifyClaim, editService, revokeClaim, deleteService, bulkDeleteServices } from '../services/domain-verify.js'
import { decode as decodeBolt11 } from 'light-bolt11-decoder'
import { generateEmbedding, getQueueDepth, getCircuitState } from '../services/embeddings.js'

const router = Router()

// ─── Per-domain probe serialization ─────────────────────────────────────────
// Prevents rapid-fire registration probes from DDoS'ing target servers.
// Each registration for the same hostname waits for the previous one's probe
// to complete, plus a short inter-probe delay.
const PROBE_INTER_DELAY_MS = parseInt(process.env.PROBE_INTER_DELAY_MS) || 500
const domainProbeQueue = new Map() // hostname → Promise<void>

/**
 * Execute fn() after waiting for any in-flight probe to the same hostname.
 * Properly chains even under concurrent burst (N requests).
 */
async function withProbeQueue(hostname, fn) {
  const prev = domainProbeQueue.get(hostname) || Promise.resolve()

  let resolve
  const gate = new Promise(r => { resolve = r })
  domainProbeQueue.set(hostname, gate)

  try {
    await prev.catch(() => {})
    await new Promise(r => setTimeout(r, PROBE_INTER_DELAY_MS))
    return await fn()
  } finally {
    resolve()
    if (domainProbeQueue.get(hostname) === gate) {
      domainProbeQueue.delete(hostname)
    }
  }
}

// ─── OpenAPI Spec + Markdown Docs ───────────────────────────────────────────

router.get('/openapi.json', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400')
  res.json(openapiSpec)
})

const markdownDocs = generateMarkdownDocs(openapiSpec)
router.get('/docs.md', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400')
  res.type('text/markdown').send(markdownDocs)
})

router.get('/services', async (req, res) => {
  const startTime = Date.now()
  try {
    const { limit: rawLimit, offset: rawOffset, ...filters } = req.query
    const result = await queryServicesHybrid(db, { ...filters, rawLimit, rawOffset }, API_COLUMNS)

    // Set degraded header if semantic path failed
    const { degradedReason, semantic_cap, ...responseBody } = result
    if (degradedReason) {
      res.set('X-402index-Search-Degraded', degradedReason)
    }
    res.set('X-402index-Semantic-Cap', String(semantic_cap ?? false))
    res.json(responseBody)

    const { q, ...filterParams } = filters
    logQuery({
      queryText: q || null,
      filters: JSON.stringify(filterParams),
      resultCount: result.total,
      responseTimeMs: Date.now() - startTime,
      userAgent: req.get('User-Agent') || null,
      degradedReason: degradedReason || null,
    })
    if (degradedReason) {
      console.log(`[search] degraded: reason=${degradedReason} q=${q} time=${Date.now() - startTime}ms`)
    }
  } catch (err) {
    console.error('GET /api/v1/services error:', err)
    res.status(500).json({ error: 'Internal Server Error' })
  }
})

// GET /api/v1/services/:id
router.get('/services/:id', (req, res) => {
  try {
    const service = db.prepare("SELECT * FROM services WHERE id = ? AND (status = 'active' OR status IS NULL) AND (provider_deleted = 0 OR provider_deleted IS NULL)").get(req.params.id)
    if (!service) {
      return res.status(404).json({ error: 'Service not found' })
    }

    const health_checks = db.prepare(
      'SELECT id, checked_at, status, response_time_ms, http_status, error_message FROM health_checks WHERE service_id = ? ORDER BY checked_at DESC LIMIT 20'
    ).all(req.params.id)

    const related_services = db.prepare(
      `SELECT id, protocol, health_status, price_sats, price_usd, payment_asset, payment_network, reliability_score, uptime_30d, latency_p50_ms
       FROM services
       WHERE url = ? AND id != ? AND (status = 'active' OR status IS NULL) AND (provider_deleted = 0 OR provider_deleted IS NULL)`
    ).all(service.url, service.id)

    res.json({ ...service, health_checks, related_services })
  } catch (err) {
    console.error('GET /api/v1/services/:id error:', err)
    res.status(500).json({ error: 'Internal Server Error' })
  }
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


// GET /api/v1/health
router.get('/health', (req, res) => {
  try {
    const ACTIVE_FILTER = "WHERE (status = 'active' OR status IS NULL) AND (provider_deleted = 0 OR provider_deleted IS NULL)"

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
    const hostnameSets = { total: new Set(), L402: new Set(), x402: new Set(), MPP: new Set() }
    const rawProviders = { total: new Set(), L402: new Set(), x402: new Set(), MPP: new Set() }
    const filteredProviders = { total: new Set(), L402: new Set(), x402: new Set(), MPP: new Set() }

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

    const lastMppSync = db.prepare(
      "SELECT MAX(updated_at) as t FROM services WHERE source = 'mpp'"
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
      last_mpp_sync: lastMppSync,
      last_health_check_run: lastHealthCheck,
      embedding_queue_depth: getQueueDepth(),
      ...(() => {
        const cs = getCircuitState()
        return {
          embedding_circuit: cs.circuit,
          embedding_circuit_failures: cs.failures,
          embedding_circuit_opened_at: cs.openedAt ? new Date(cs.openedAt).toISOString() : null,
          embedding_half_open_trial: cs.halfOpenTrialInFlight,
        }
      })(),
    })
  } catch (err) {
    console.error('GET /api/v1/health error:', err)
    res.status(500).json({ error: 'Internal Server Error' })
  }
})

// GET /api/v1/stats/snapshots
router.get('/stats/snapshots', (req, res) => {
  try {
    const days = Math.min(Math.max(1, parseInt(req.query.days) || 30), 365)
    const snapshots = getSnapshots(db, days)
    res.json({ snapshots, count: snapshots.length })
  } catch (err) {
    console.error('GET /api/v1/stats/snapshots error:', err)
    res.status(500).json({ error: 'Internal Server Error' })
  }
})

// GET /api/v1/categories
router.get('/categories', (req, res) => {
  try {
    const rows = db.prepare(
      `SELECT category, protocol, COUNT(*) as count
       FROM services
       WHERE (status = 'active' OR status IS NULL)
         AND (provider_deleted = 0 OR provider_deleted IS NULL)
         AND category IS NOT NULL
         AND is_template = 0 AND is_demo = 0
       GROUP BY category, protocol
       ORDER BY count DESC`
    ).all()

    // Build tree: { "crypto": { L402: 5, x402: 200, MPP: 10, total: 215, subcategories: { "defi": {...} } } }
    const tree = {}
    for (const row of rows) {
      const parts = row.category.split('/')
      const top = parts[0]
      const sub = parts.length > 1 ? parts.slice(1).join('/') : null

      if (!tree[top]) tree[top] = { L402: 0, x402: 0, MPP: 0, total: 0, subcategories: {} }
      tree[top][row.protocol] = (tree[top][row.protocol] || 0) + row.count
      tree[top].total += row.count

      if (sub) {
        if (!tree[top].subcategories[sub]) tree[top].subcategories[sub] = { L402: 0, x402: 0, MPP: 0, total: 0 }
        tree[top].subcategories[sub][row.protocol] = (tree[top].subcategories[sub][row.protocol] || 0) + row.count
        tree[top].subcategories[sub].total += row.count
      }
    }

    res.json({ categories: tree })
  } catch (err) {
    console.error('GET /api/v1/categories error:', err)
    res.status(500).json({ error: 'Internal Server Error' })
  }
})

// Lazy-initialized prepared statements for registration
const stmts = {}
function stmt(key, sql) {
  if (!stmts[key]) stmts[key] = db.prepare(sql)
  return stmts[key]
}

const registerUpsert = () => stmt('registerUpsert', `
  INSERT INTO services (id, name, description, url, protocol, price_sats, price_usd, payment_asset, payment_network, category, provider, source, contact_email, http_method, probe_body, health_status, status, hostname)
  VALUES (@id, @name, @description, @url, @protocol, @price_sats, @price_usd, @payment_asset, @payment_network, @category, @provider, 'self-registered', @contact_email, @http_method, @probe_body, 'healthy', 'pending', @hostname)
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
    hostname = COALESCE(excluded.hostname, services.hostname),
    status = CASE WHEN services.status = 'active' THEN 'active' ELSE 'pending' END,
    updated_at = datetime('now')
  RETURNING *
`)

const VALID_PROTOCOLS = new Set(['L402', 'X402', 'MPP'])
const REQUIRED_FIELDS = ['url', 'name', 'protocol']
const VALID_HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE'])
const MAX_LENGTHS = { name: 200, description: 2000, url: 2000, provider: 200, category: 100, payment_asset: 50, payment_network: 50, contact_email: 254, http_method: 10, probe_body: 4000 }

/**
 * Extract pricing from a bonus protocol detection.
 * Returns { price_sats, price_usd, payment_asset, payment_network }.
 * Never throws — returns all nulls on error.
 */
function extractBonusPricing(detection) {
  const nullPricing = { price_sats: null, price_usd: null, payment_asset: null, payment_network: null }
  try {
    if (detection.protocol === 'x402' && detection.details?.accepts?.[0]) {
      const accept = detection.details.accepts[0]
      // Lightning x402: extract pricing from BOLT11 invoice
      if (accept.extra?.paymentMethod === 'lightning' && accept.extra?.invoice) {
        try {
          const decoded = decodeBolt11(accept.extra.invoice)
          const amountSection = decoded.sections?.find(s => s.name === 'amount')
          const priceSats = amountSection ? Math.floor(Number(amountSection.value) / 1000) : null
          const btcRate = getCachedBtcUsdRate()
          const priceUsd = priceSats && btcRate ? Number(((priceSats / 1e8) * btcRate).toFixed(6)) : null
          return {
            price_sats: priceSats,
            price_usd: priceUsd,
            payment_asset: 'BTC',
            payment_network: accept.network || null,
          }
        } catch {
          return nullPricing
        }
      }
      // Map known asset addresses to symbols
      const asset = accept.asset || null
      const network = accept.network || null
      let priceUsd = null
      if (accept.maxAmountRequired != null || accept.amount != null) {
        const rawAmount = accept.maxAmountRequired ?? accept.amount
        // Default to 6 decimals (USDC)
        const decimals = accept.decimals ?? 6
        priceUsd = Number(rawAmount) / Math.pow(10, decimals)
        if (!Number.isFinite(priceUsd)) priceUsd = null
      }
      return { price_sats: null, price_usd: priceUsd, payment_asset: asset, payment_network: network }
    }

    if (detection.protocol === 'L402' && detection.details?.invoice) {
      try {
        const decoded = decodeBolt11(detection.details.invoice)
        const amountSection = decoded.sections?.find(s => s.name === 'amount')
        const priceSats = amountSection ? Math.floor(Number(amountSection.value) / 1000) : null
        return { price_sats: priceSats, price_usd: null, payment_asset: null, payment_network: null }
      } catch {
        return nullPricing
      }
    }

    if (detection.protocol === 'MPP' && detection.details?.request) {
      try {
        const reqData = JSON.parse(Buffer.from(detection.details.request, 'base64url').toString())
        const priceUsd = reqData.amount != null ? Number(reqData.amount) : null
        return { price_sats: null, price_usd: Number.isFinite(priceUsd) ? priceUsd : null, payment_asset: null, payment_network: null }
      } catch {
        return nullPricing
      }
    }
  } catch {
    // Never fail bonus row creation due to pricing extraction errors
  }
  return nullPricing
}

/**
 * Multi-protocol verification dispatcher.
 * All protocols use the shared probeEndpoint() with redirect following,
 * POST fallback, and unified 8s timeout.
 */
async function verifyEndpoint(url, protocol, httpMethod = 'GET', probeBody = '{}') {
  const result = await probeEndpoint(url, {
    protocol,
    method: httpMethod,
    body: probeBody,
    followRedirects: true,
    postFallback: true,
  })

  if (result.errorMessage) {
    return {
      valid: false,
      protocol,
      httpStatus: result.httpStatus,
      error: result.errorMessage,
      details: {},
      detections: result.detection,
      rawHeaders: {
        wwwAuthenticate: result.wwwAuthenticate,
        paymentRequired: result.paymentRequired,
      },
      bodySnippet: null,
    }
  }

  // Effective status after POST fallback
  const effectiveStatus = result.httpStatus
  const detection = getPrimaryDetection(result.detection, protocol)

  if (effectiveStatus !== 402) {
    return {
      valid: false,
      protocol,
      httpStatus: effectiveStatus,
      error: `Your endpoint returned HTTP ${effectiveStatus} instead of 402. ${protocol} endpoints must return 402 Payment Required for unauthenticated requests.`,
      details: {},
      detections: result.detection,
      rawHeaders: {
        wwwAuthenticate: result.wwwAuthenticate,
        paymentRequired: result.paymentRequired,
      },
      bodySnippet: result.responseBody ? result.responseBody.substring(0, 500) : null,
    }
  }

  // Graceful cross-detection: suggest the right protocol instead of hard-failing
  if (!detection.protocol) {
    // Check if any other protocol was detected — suggest it
    const otherDetection = result.detection.find(d => d.protocol && d.protocol !== protocol)
    if (otherDetection) {
      return {
        valid: false,
        protocol,
        httpStatus: effectiveStatus,
        error: `Your endpoint returns a ${otherDetection.protocol} challenge. Register it as ${otherDetection.protocol} instead.`,
        suggestedProtocol: otherDetection.protocol,
        details: otherDetection.details,
        detections: result.detection,
        rawHeaders: {
          wwwAuthenticate: result.wwwAuthenticate,
          paymentRequired: result.paymentRequired,
        },
        bodySnippet: result.responseBody ? result.responseBody.substring(0, 500) : null,
      }
    }

    return {
      valid: false,
      protocol,
      httpStatus: effectiveStatus,
      error: `Endpoint returned 402 but no valid ${protocol} challenge was detected.`,
      details: detection.details,
      detections: result.detection,
      rawHeaders: {
        wwwAuthenticate: result.wwwAuthenticate,
        paymentRequired: result.paymentRequired,
      },
      bodySnippet: result.responseBody ? result.responseBody.substring(0, 500) : null,
    }
  }

  // L402-specific details for backward compat
  if (protocol === 'L402') {
    return {
      valid: detection.valid,
      protocol,
      httpStatus: effectiveStatus,
      error: detection.valid ? null : (detection.degradeReason || 'Invalid L402 challenge'),
      details: {
        hasWwwAuthenticate: !!result.wwwAuthenticate,
        scheme: detection.details.scheme,
        hasMacaroon: detection.details.macaroonValid ?? false,
        hasInvoice: detection.details.invoiceValid ?? false,
      },
      methodUsed: result.methodUsed,
      detections: result.detection,
      rawHeaders: {
        wwwAuthenticate: result.wwwAuthenticate,
        paymentRequired: result.paymentRequired,
      },
      bodySnippet: result.responseBody ? result.responseBody.substring(0, 500) : null,
    }
  }

  return {
    valid: detection.valid,
    protocol,
    httpStatus: effectiveStatus,
    error: detection.valid ? null : (detection.degradeReason || `Invalid ${protocol} challenge`),
    details: detection.details,
    methodUsed: result.methodUsed,
    detections: result.detection,
    rawHeaders: {
      wwwAuthenticate: result.wwwAuthenticate,
      paymentRequired: result.paymentRequired,
    },
    bodySnippet: result.responseBody ? result.responseBody.substring(0, 500) : null,
  }
}

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

    // Validate protocol — L402, x402, MPP accepted (case-insensitive)
    const protocolUpper = String(body.protocol).toUpperCase()
    if (!VALID_PROTOCOLS.has(protocolUpper)) {
      return res.status(400).json({
        error: `Invalid protocol "${body.protocol}". Must be one of: L402, x402, MPP`,
      })
    }
    const protocol = protocolUpper === 'X402' ? 'x402' : protocolUpper

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

    // Probe with the raw submitted URL — preserve original scheme.
    // normalizeUrl forces http→https which breaks HTTP-only tunnels (e.g. ngrok --scheme http).
    const probeUrl = body.url.trim()

    // Run verification probe, serialized per-domain to avoid DDoS'ing target servers
    const probeHostname = parsedUrl.hostname.toLowerCase()
    let discoveredConfig = null
    let probe = await withProbeQueue(probeHostname, async () => {
      let result = await verifyEndpoint(probeUrl, protocol, httpMethod, probeBody)

      // If L402 probe failed with 400 or 406, try .well-known auto-discovery
      if (protocol === 'L402' && !result.valid && [400, 406].includes(result.httpStatus)) {
        discoveredConfig = await discoverProbeConfig(probeUrl)
        if (discoveredConfig) {
          console.log(`[register] .well-known discovery found config for ${probeUrl}: method=${discoveredConfig.method}, body=${discoveredConfig.probeBody.substring(0, 100)}`)
          result = await verifyEndpoint(probeUrl, protocol, discoveredConfig.method, discoveredConfig.probeBody)
        }
      }

      return result
    })

    // Normalize URL for storage: lowercase hostname, strip trailing slashes,
    // but preserve the original scheme so health checks probe the correct protocol.
    // (normalizeUrl forces http→https, which breaks HTTP-only endpoints like ngrok tunnels)
    const url = normalizeUrl(body.url, { preserveScheme: true })

    if (!probe.valid) {
      // Log probe failure to registration_attempts (skip pure validation failures)
      try {
        db.prepare(
          `INSERT INTO registration_attempts (id, url, protocol, name, provider, contact_email, http_method, probe_body, failure_reason, probe_http_status, probe_error, suggested_protocol, ip_address)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          randomUUID(), url, protocol,
          body.name || null, body.provider || null, body.contact_email || null,
          httpMethod, probeBody !== '{}' ? probeBody : null,
          probe.error || 'Probe failed',
          probe.httpStatus || null, probe.error || null,
          probe.suggestedProtocol || null,
          req.ip || req.connection?.remoteAddress || null
        )
      } catch (logErr) {
        console.warn('[register] Failed to log registration attempt:', logErr.message)
      }

      const response = {
        error: `${protocol} verification failed`,
        detail: probe.error,
        probe: {
          httpStatus: probe.httpStatus,
          ...probe.details,
          headersPresent: {
            'WWW-Authenticate': !!(probe.rawHeaders?.wwwAuthenticate),
            'PAYMENT-REQUIRED': !!(probe.rawHeaders?.paymentRequired),
          },
          bodySnippet: probe.bodySnippet || null,
          detectedProtocols: (probe.detections || []).map(d => ({
            protocol: d.protocol,
            valid: d.valid,
          })),
        },
      }
      if (probe.suggestedProtocol) {
        response.suggestedProtocol = probe.suggestedProtocol
      }
      if (discoveredConfig) {
        response.wellknown_attempted = true
        response.detail += ` (Also attempted .well-known auto-discovery — the constructed probe body did not trigger an ${protocol} challenge. Try providing an explicit probe_body parameter.)`
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

    // If POST fallback fired during verification, persist the detected method
    if (probe.methodUsed && probe.methodUsed !== httpMethod && !body.http_method) {
      httpMethod = probe.methodUsed
    }

    // Insert with status='pending' for admin review
    const params = {
      id: randomUUID(),
      name: body.name,
      description: body.description || null,
      url,
      protocol,
      price_sats: body.price_sats != null ? Number(body.price_sats) : null,
      price_usd: body.price_usd != null ? Number(body.price_usd) : null,
      payment_asset: body.payment_asset || null,
      payment_network: body.payment_network || null,
      category: body.category || 'uncategorized',
      provider: body.provider || null,
      contact_email: body.contact_email || null,
      http_method: httpMethod,
      probe_body: probeBody !== '{}' ? probeBody : null,
      hostname: extractHostname(url),
    }

    // Block re-registration of soft-deleted URLs
    const softDeleted = db.prepare(
      "SELECT id FROM services WHERE url = @url AND protocol = @protocol AND provider_deleted = 1"
    ).get({ url, protocol })
    if (softDeleted) {
      return res.status(409).json({
        error: 'This endpoint was recently removed by its domain owner. Contact admin to restore.',
      })
    }

    // Per-domain rate limit: tiered by domain verification status
    const regHostname = parsedUrl.hostname.toLowerCase()
    const domainRegCount = db.prepare(
      `SELECT COUNT(*) as c FROM services
       WHERE source = 'self-registered'
         AND registered_at > datetime('now', '-1 hour')
         AND (hostname = @host
           OR (hostname IS NULL AND (
             url LIKE 'https://' || @host || '/%' OR url LIKE 'https://' || @host
             OR url LIKE 'http://' || @host || '/%' OR url LIKE 'http://' || @host)))`
      // NOTE: The hostname IS NULL fallback handles rows not yet backfilled.
      // TODO: Remove the NULL fallback after confirming backfill is complete on production.
    ).get({ host: regHostname }).c

    const isVerifiedDomain = !!db.prepare(
      "SELECT 1 FROM domain_claims WHERE domain = ? AND status = 'verified'"
    ).get(regHostname)

    const domainLimit = isVerifiedDomain ? 100 : 20
    if (domainRegCount >= domainLimit) {
      return res.status(429).json({
        error: `Rate limit: maximum ${domainLimit} registrations per domain per hour.${
          !isVerifiedDomain ? ' Verify your domain for a higher limit (100/hr).' : ''
        }`,
      })
    }

    let service = registerUpsert().get(params)

    // Auto-approve trusted providers — probe already validated compliance above
    // Requires GOLEM_GATEWAY_SECRET env var + matching X-Golem-Gateway-Secret header
    const golemSecret = process.env.GOLEM_GATEWAY_SECRET
    const golemHeader = req.get('x-golem-gateway-secret')
    let golemSecretValid = false
    if (golemSecret && golemHeader) {
      golemSecretValid = constantTimeEqual(golemSecret, golemHeader)
    }
    if (service.status === 'pending' && body.provider === 'golem-gateway' && golemSecretValid) {
      db.prepare(
        "UPDATE services SET status = 'active', approval_reason = 'golem-gateway', updated_at = datetime('now') WHERE id = ? AND status = 'pending'"
      ).run(service.id)
      service = { ...service, status: 'active', approval_reason: 'golem-gateway' }
      console.log(`[register] Auto-approved golem-gateway registration: ${url}`)
    }

    // Auto-approve if registering domain is verified (reuse lookup from rate limit check)
    if (service.status === 'pending' && isVerifiedDomain) {
      db.prepare(
        "UPDATE services SET status = 'active', approval_reason = 'domain-verified', updated_at = datetime('now') WHERE id = ?"
      ).run(service.id)
      service = { ...service, status: 'active', approval_reason: 'domain-verified' }
      console.log(`[register] Auto-approved domain-verified registration: ${url}`)
    }

    // Fire-and-forget event distribution (webhooks, Nostr, email — only on genuinely new registrations)
    if (service.registered_at === service.updated_at) {
      emit('service.new', service, db)
      setImmediate(() => generateEmbedding(service.id).catch(() => {}))
    }

    // ── Bonus row creation for additional detected protocols ──────────────
    const alsoRegistered = []
    const bonusDetections = (probe.detections || []).filter(
      d => d.valid && d.protocol !== protocol
    )

    // Check if rate limit can accommodate bonus rows
    const currentRegCount = domainRegCount + 1 // primary already counted
    const bonusBudget = domainLimit - currentRegCount

    for (const bonusDet of bonusDetections) {
      if (alsoRegistered.length >= bonusBudget) break

      // Skip if (url, bonusProtocol) is soft-deleted
      const bonusSoftDeleted = db.prepare(
        "SELECT id FROM services WHERE url = @url AND protocol = @protocol AND provider_deleted = 1"
      ).get({ url, protocol: bonusDet.protocol })
      if (bonusSoftDeleted) continue

      const pricing = extractBonusPricing(bonusDet)
      const bonusParams = {
        id: randomUUID(),
        name: `${body.name} (${bonusDet.protocol})`,
        description: body.description || null,
        url,
        protocol: bonusDet.protocol,
        price_sats: pricing.price_sats,
        price_usd: pricing.price_usd,
        payment_asset: pricing.payment_asset,
        payment_network: pricing.payment_network,
        category: body.category || 'uncategorized',
        provider: body.provider || null,
        contact_email: body.contact_email || null,
        http_method: httpMethod,
        probe_body: probeBody !== '{}' ? probeBody : null,
        hostname: extractHostname(url),
      }

      let bonusService = registerUpsert().get(bonusParams)

      // Apply same auto-approval logic to bonus row
      if (bonusService.status === 'pending' && body.provider === 'golem-gateway' && golemSecretValid) {
        db.prepare(
          "UPDATE services SET status = 'active', approval_reason = 'golem-gateway', updated_at = datetime('now') WHERE id = ? AND status = 'pending'"
        ).run(bonusService.id)
        bonusService = { ...bonusService, status: 'active', approval_reason: 'golem-gateway' }
      }

      if (bonusService.status === 'pending' && isVerifiedDomain) {
        db.prepare(
          "UPDATE services SET status = 'active', approval_reason = 'domain-verified', updated_at = datetime('now') WHERE id = ?"
        ).run(bonusService.id)
        bonusService = { ...bonusService, status: 'active', approval_reason: 'domain-verified' }
      }

      // Fire event for genuinely new bonus registrations
      if (bonusService.registered_at === bonusService.updated_at) {
        emit('service.new', bonusService, db)
        setImmediate(() => generateEmbedding(bonusService.id).catch(() => {}))
      }

      alsoRegistered.push(bonusService)
      console.log(`[register] Bonus ${bonusDet.protocol} row created for ${url}`)
    }

    const message = service.status === 'active'
      ? (service.approval_reason === 'domain-verified'
        ? 'Service registered and live (domain verified).'
        : 'Service registered and live')
      : 'Service registered and pending review. Verify your domain for instant approval.'

    const responseBody = {
      message,
      service,
      also_registered: alsoRegistered,
      verification: {
        protocol,
        httpStatus: probe.httpStatus,
        ...probe.details,
      },
    }

    // Nudge unverified providers toward domain verification
    if (service.status === 'pending') {
      responseBody.domain_verification = {
        domain: regHostname,
        claim_url: 'POST /api/v1/claim',
        verify_url: 'POST /api/v1/claim/verify',
        guide: 'https://402index.io/verify',
        note: 'Domain verification enables instant approval for all future registrations from this domain, plus self-service editing.',
      }
    }

    return res.status(201).json(responseBody)
  } catch (err) {
    console.error('[register] Error:', err.message)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// ─── Digest Endpoint ─────────────────────────────────────────────────────────

function classifyAgent(ua) {
  if (!ua || ua === '') return 'api'
  if (ua.includes('402index-mcp')) return 'mcp'
  if (ua.includes('Mozilla') || ua.includes('Chrome') || ua.includes('Safari')) return 'browser'
  return 'api'
}

router.get('/digest', (req, res) => {
  try {
    const ACTIVE = "(status = 'active' OR status IS NULL) AND (provider_deleted = 0 OR provider_deleted IS NULL)"

    // ── Totals ──
    const totalEndpoints = db.prepare(`SELECT COUNT(*) as c FROM services WHERE ${ACTIVE}`).get().c

    const byProtocol = {}
    db.prepare(`SELECT protocol, COUNT(*) as c FROM services WHERE ${ACTIVE} GROUP BY protocol`).all()
      .forEach(r => { byProtocol[r.protocol] = r.c })

    const byHealth = {}
    db.prepare(`SELECT health_status, COUNT(*) as c FROM services WHERE ${ACTIVE} GROUP BY health_status`).all()
      .forEach(r => { byHealth[r.health_status] = r.c })

    // Providers via JS hostname extraction (same approach as /health)
    const allUrls = db.prepare(`SELECT url, is_template, is_demo FROM services WHERE ${ACTIVE}`).all()
    const providerSet = new Set()
    for (const svc of allUrls) {
      if (svc.is_template || svc.is_demo) continue
      try { providerSet.add(new URL(svc.url).hostname) } catch { /* skip */ }
    }

    const paymentVerified = db.prepare(`SELECT COUNT(*) as c FROM services WHERE ${ACTIVE} AND x402_payment_valid = 1`).get().c
    const domainVerifiedProviders = db.prepare("SELECT COUNT(DISTINCT domain) as c FROM domain_claims WHERE status = 'verified'").get().c

    const l402Formats = db.prepare(`
      SELECT l402_format, COUNT(*) as count
      FROM services
      WHERE protocol = 'L402' AND l402_format IS NOT NULL AND ${ACTIVE}
      GROUP BY l402_format
    `).all()

    const l402FormatCounts = {}
    let l402CompliantCount = 0
    let l402NonCompliantCount = 0
    for (const row of l402Formats) {
      l402FormatCounts[row.l402_format] = row.count
      if (row.l402_format === 'v2_tlv' || row.l402_format === 'v1_binary') {
        l402CompliantCount += row.count
      } else {
        l402NonCompliantCount += row.count
      }
    }

    // ── Registrations ──
    const last24h = db.prepare(`
      SELECT id, name, url, protocol, provider, source, registered_at as created_at
      FROM services
      WHERE source = 'self-registered'
        AND registered_at > datetime('now', '-24 hours')
        AND ${ACTIVE}
      ORDER BY registered_at DESC
    `).all()

    const last7dCount = db.prepare(`
      SELECT COUNT(*) as c FROM services
      WHERE registered_at > datetime('now', '-7 days') AND ${ACTIVE}
    `).get().c

    const pendingApproval = db.prepare("SELECT COUNT(*) as c FROM services WHERE status = 'pending'").get().c

    const selfRegisteredTotal = db.prepare(`
      SELECT COUNT(*) as c FROM services WHERE source = 'self-registered' AND ${ACTIVE}
    `).get().c

    // ── Traffic ──
    const queriesToday = db.prepare(
      "SELECT COUNT(*) as c FROM query_log WHERE timestamp > date('now')"
    ).get().c

    const queries7d = db.prepare(
      "SELECT COUNT(*) as c FROM query_log WHERE timestamp > datetime('now', '-7 days')"
    ).get().c

    const uniqueAgentsToday = db.prepare(
      "SELECT COUNT(DISTINCT user_agent) as c FROM query_log WHERE timestamp > date('now')"
    ).get().c

    const mcpToday = db.prepare(
      "SELECT COUNT(*) as c FROM query_log WHERE timestamp > date('now') AND user_agent LIKE '%402index-mcp%'"
    ).get().c

    const mcpSummary = db.prepare(
      `SELECT COUNT(*) as total, COUNT(DISTINCT date(timestamp)) as activeDays
       FROM query_log WHERE user_agent LIKE '%402index-mcp%'`
    ).get()

    // ── Search Intelligence ──
    const topSearches = db.prepare(
      `SELECT query_text as term, COUNT(*) as count
       FROM query_log
       WHERE query_text IS NOT NULL AND query_text != ''
         AND timestamp > datetime('now', '-7 days')
       GROUP BY query_text
       ORDER BY count DESC LIMIT 20`
    ).all()

    const zeroResults = db.prepare(
      `SELECT query_text as term, filters, COUNT(*) as count
       FROM query_log
       WHERE result_count = 0
         AND query_text IS NOT NULL AND query_text != ''
         AND timestamp > datetime('now', '-7 days')
       GROUP BY query_text
       ORDER BY count DESC LIMIT 10`
    ).all()

    const topAgents = db.prepare(
      `SELECT user_agent as agent, COUNT(*) as count
       FROM query_log
       WHERE timestamp > datetime('now', '-7 days')
       GROUP BY user_agent
       ORDER BY count DESC LIMIT 15`
    ).all().map(r => ({ ...r, type: classifyAgent(r.agent) }))

    // ── Health Changes (approximate — based on current status + last_checked) ──
    const newlyDegraded = db.prepare(`
      SELECT id, name, url, protocol, provider, health_status, last_checked
      FROM services
      WHERE health_status = 'degraded'
        AND last_checked > datetime('now', '-24 hours')
        AND ${ACTIVE}
      ORDER BY last_checked DESC LIMIT 10
    `).all()

    const newlyDown = db.prepare(`
      SELECT id, name, url, protocol, provider, health_status, last_checked
      FROM services
      WHERE health_status = 'down'
        AND last_checked > datetime('now', '-24 hours')
        AND ${ACTIVE}
      ORDER BY last_checked DESC LIMIT 10
    `).all()

    // Recovered: currently healthy but had a down/degraded check in last 48h
    const recovered = db.prepare(`
      SELECT s.id, s.name, s.url, s.protocol, s.provider, s.health_status, s.last_checked
      FROM services s
      WHERE s.health_status = 'healthy'
        AND s.last_checked > datetime('now', '-24 hours')
        AND EXISTS (
          SELECT 1 FROM health_checks hc
          WHERE hc.service_id = s.id
            AND hc.status IN ('down', 'degraded')
            AND hc.checked_at > datetime('now', '-48 hours')
        )
        AND (s.status = 'active' OR s.status IS NULL)
        AND (s.provider_deleted = 0 OR s.provider_deleted IS NULL)
      ORDER BY s.last_checked DESC LIMIT 10
    `).all()

    res.json({
      generated_at: new Date().toISOString(),
      totals: {
        endpoints: totalEndpoints,
        providers: providerSet.size,
        by_protocol: byProtocol,
        by_health: byHealth,
        payment_verified: paymentVerified,
        domain_verified_providers: domainVerifiedProviders,
        l402_format_counts: l402FormatCounts,
        l402_compliant_count: l402CompliantCount,
        l402_non_compliant_count: l402NonCompliantCount,
      },
      registrations: {
        last_24h: last24h,
        last_7d_count: last7dCount,
        pending_approval: pendingApproval,
        self_registered_total: selfRegisteredTotal,
      },
      traffic: {
        queries_today: queriesToday,
        queries_7d: queries7d,
        unique_agents_today: uniqueAgentsToday,
        mcp_queries_today: mcpToday,
        mcp_queries_total: mcpSummary.total,
        mcp_active_days: mcpSummary.activeDays,
      },
      search_intelligence: {
        top_searches_7d: topSearches,
        zero_results_7d: zeroResults,
        top_user_agents_7d: topAgents,
      },
      health_changes: {
        newly_degraded_24h: newlyDegraded,
        newly_down_24h: newlyDown,
        recovered_24h: recovered,
      },
    })
  } catch (err) {
    console.error('GET /api/v1/digest error:', err)
    res.status(500).json({ error: 'Internal Server Error' })
  }
})

// ─── Demo Endpoints ──────────────────────────────────────────────────────────

import { buildProbeSample } from './pages.js'
import { validateProbeUrl, runProbeSteps } from '../services/probe-live.js'

router.get('/demo/probe-sample', (req, res) => {
  try {
    const protocol = req.query.protocol || 'L402'
    const sample = buildProbeSample(db, protocol)
    res.json(sample)
  } catch (err) {
    console.error('GET /api/v1/demo/probe-sample error:', err)
    res.status(500).json({ error: 'Internal Server Error' })
  }
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

const ADMIN_COLUMNS = `id, name, url, status, protocol, provider, category,
  price_sats, payment_asset, payment_network, contact_email,
  health_status, verified, domain_verified, approval_reason, registered_at`

const getPending = () => stmt('getPending', "SELECT * FROM services WHERE status = 'pending' ORDER BY registered_at DESC")

const getRecent = () => stmt('getRecent', `
  SELECT ${ADMIN_COLUMNS} FROM services ORDER BY registered_at DESC LIMIT @limit
`)

const searchServices = () => stmt('searchServices', `
  SELECT ${ADMIN_COLUMNS} FROM services
  WHERE (name LIKE @q ESCAPE '\\' OR url LIKE @q ESCAPE '\\' OR provider LIKE @q ESCAPE '\\' OR category LIKE @q ESCAPE '\\')
  ORDER BY registered_at DESC
  LIMIT @limit
`)

const deleteServiceTxn = db.transaction((id) => {
  db.prepare('DELETE FROM health_checks WHERE service_id = ?').run(id)
  return db.prepare('DELETE FROM services WHERE id = ?').run(id)
})

const approveService = () => stmt('approveService', `
  UPDATE services SET status = 'active', approval_reason = 'admin-manual', updated_at = datetime('now') WHERE id = @id AND status = 'pending'
`)

const rejectService = () => stmt('rejectService', `
  UPDATE services SET status = 'rejected', updated_at = datetime('now') WHERE id = @id AND status = 'pending'
`)

router.get('/admin/pending', (req, res) => {
  const services = getPending().all()
  res.json({ services, total: services.length })
})

router.get('/admin/recent', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100)
  const services = getRecent().all({ limit })
  res.json({ services, total: services.length })
})

router.get('/admin/search', (req, res) => {
  const q = (req.query.q || '').trim()
  if (!q) {
    return res.status(400).json({ error: 'q param is required' })
  }
  const limit = Math.min(parseInt(req.query.limit) || 20, 100)
  const escaped = q.replace(/[%_\\]/g, '\\$&')
  const services = searchServices().all({ q: `%${escaped}%`, limit })
  res.json({ services, total: services.length })
})

router.delete('/admin/services/:id', (req, res) => {
  try {
    const result = deleteServiceTxn(req.params.id)
    if (result.changes === 0) {
      return res.status(404).json({ error: 'No service with that ID' })
    }
    res.json({ deleted: true, id: req.params.id })
  } catch (err) {
    console.error('[admin] Delete failed:', err.message)
    res.status(500).json({ error: 'Failed to delete service' })
  }
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

// POST /admin/services/:id/restore — Restore a soft-deleted service (admin only)
router.post('/admin/services/:id/restore', (req, res) => {
  const service = db.prepare('SELECT * FROM services WHERE id = ? AND provider_deleted = 1').get(req.params.id)
  if (!service) {
    return res.status(404).json({ error: 'No soft-deleted service with that ID' })
  }
  db.prepare(
    "UPDATE services SET provider_deleted = 0, deleted_at = NULL, updated_at = datetime('now') WHERE id = ?"
  ).run(req.params.id)
  console.log(`[admin/restore] RESTORED: service=${req.params.id} name=${service.name}`)
  res.json({ restored: true, id: req.params.id, name: service.name })
})

// ─── Admin Domain Verification Funnel ─────────────────────────────────────

router.get('/admin/domains', (req, res) => {
  const domains = db.prepare(`
    SELECT dc.*,
      (SELECT COUNT(*) FROM services s
       WHERE s.hostname = dc.domain
         AND (s.status = 'active' OR s.status IS NULL)
         AND (s.provider_deleted = 0 OR s.provider_deleted IS NULL)) as endpoint_count
    FROM domain_claims dc
    ORDER BY COALESCE(dc.verified_at, dc.claimed_at) DESC
  `).all()
  res.json({ domains, total: domains.length })
})

// ─── Admin Domain Token Reset ─────────────────────────────────────────────

router.post('/admin/domains/:domain/reset', (req, res) => {
  const domain = (req.params.domain || '').trim().toLowerCase()
  if (!domain) return res.status(400).json({ error: 'domain param is required' })

  const claim = db.prepare('SELECT * FROM domain_claims WHERE domain = ?').get(domain)
  if (!claim) return res.status(404).json({ error: 'No claim found for this domain' })

  const token = randomBytes(32).toString('hex')
  const hash = createHash('sha256').update(token).digest('hex')
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000)
    .toISOString().replace('T', ' ').slice(0, 19)

  db.prepare(
    `UPDATE domain_claims SET verification_token = ?, token_hashed = 1, status = 'pending',
     expires_at = ?, verified_at = NULL WHERE domain = ?`
  ).run(hash, expiresAt, domain)

  console.log(`[admin/domain-reset] RESET: domain=${domain} old_status=${claim.status}`)

  res.json({
    reset: true,
    domain,
    new_status: 'pending',
    expires_at: expiresAt,
    verification_token: token,
    verification_hash: hash,
    verification_url: `https://${domain}/.well-known/402index-verify.txt`,
    instructions: 'Send the token to the provider. They must place the hash at the verification URL, then call POST /api/v1/claim/verify.',
  })
})

// ─── Admin Failed Registrations ──────────────────────────────────────────

router.get('/admin/failed-registrations', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200)
  const attempts = db.prepare(
    'SELECT * FROM registration_attempts ORDER BY attempted_at DESC LIMIT ?'
  ).all(limit)
  const total = db.prepare('SELECT COUNT(*) as c FROM registration_attempts').get().c
  res.json({ attempts, total })
})

// ─── Admin Traffic Dashboard ──────────────────────────────────────────────

router.get('/admin/traffic', (req, res) => {
  const today = db.prepare(
    `SELECT COUNT(*) as c FROM query_log WHERE timestamp > date('now')`
  ).get().c

  const week = db.prepare(
    `SELECT COUNT(*) as c FROM query_log WHERE timestamp > datetime('now', '-7 days')`
  ).get().c

  const uniqueAgentsToday = db.prepare(
    `SELECT COUNT(DISTINCT user_agent) as c FROM query_log WHERE timestamp > date('now')`
  ).get().c

  const mcpToday = db.prepare(
    `SELECT COUNT(*) as c FROM query_log WHERE timestamp > date('now') AND user_agent LIKE '%402index-mcp%'`
  ).get().c

  const hourly = db.prepare(
    `SELECT strftime('%Y-%m-%d %H:00', timestamp) as hour,
            COUNT(*) as total,
            SUM(CASE WHEN user_agent LIKE '%402index-mcp%' THEN 1 ELSE 0 END) as mcp_count
     FROM query_log
     WHERE timestamp > datetime('now', '-24 hours')
     GROUP BY hour
     ORDER BY hour`
  ).all()

  const topSearches = db.prepare(
    `SELECT query_text, COUNT(*) as count
     FROM query_log
     WHERE query_text IS NOT NULL AND query_text != ''
       AND timestamp > datetime('now', '-7 days')
     GROUP BY query_text
     ORDER BY count DESC
     LIMIT 20`
  ).all()

  const topAgents = db.prepare(
    `SELECT user_agent, COUNT(*) as count
     FROM query_log
     WHERE timestamp > datetime('now', '-7 days')
     GROUP BY user_agent
     ORDER BY count DESC
     LIMIT 15`
  ).all()

  const zeroResults = db.prepare(
    `SELECT query_text, filters, COUNT(*) as count
     FROM query_log
     WHERE result_count = 0
       AND query_text IS NOT NULL AND query_text != ''
       AND timestamp > datetime('now', '-7 days')
     GROUP BY query_text
     ORDER BY count DESC
     LIMIT 10`
  ).all()

  const mcpSummary = db.prepare(
    `SELECT COUNT(*) as total,
            COUNT(DISTINCT date(timestamp)) as activeDays,
            MIN(timestamp) as firstSeen,
            MAX(timestamp) as lastSeen
     FROM query_log
     WHERE user_agent LIKE '%402index-mcp%'`
  ).get()

  res.json({
    summary: { today, week, uniqueAgentsToday, mcpToday },
    hourly,
    topSearches,
    topAgents,
    zeroResults,
    mcpSummary,
  })
})

// ─── Protocol Changes ──────────────────────────────────────────────────────

const getProtocolChanges = () => stmt('getProtocolChanges',
  'SELECT * FROM protocol_changes WHERE status = @status ORDER BY last_detected_at DESC'
)

const getAllProtocolChanges = () => stmt('getAllProtocolChanges',
  'SELECT * FROM protocol_changes ORDER BY last_detected_at DESC'
)

router.get('/admin/protocol-changes', (req, res) => {
  const status = req.query.status
  if (status === 'all') {
    const changes = getAllProtocolChanges().all()
    return res.json({ changes, total: changes.length })
  }
  const changes = getProtocolChanges().all({ status: status || 'pending' })
  res.json({ changes, total: changes.length })
})

router.post('/admin/protocol-changes/:id/approve', (req, res) => {
  const pc = db.prepare('SELECT * FROM protocol_changes WHERE id = ?').get(req.params.id)
  if (!pc) {
    return res.status(404).json({ error: 'Protocol change not found' })
  }
  if (pc.type !== 'addition') {
    return res.status(400).json({ error: 'Only addition type can be approved' })
  }
  if (pc.status === 'approved') {
    return res.status(409).json({ error: 'Already approved' })
  }
  if (pc.status === 'dismissed') {
    return res.status(409).json({ error: 'Already dismissed' })
  }

  // Read the triggering service to copy fields
  const originalService = db.prepare('SELECT * FROM services WHERE id = ?').get(pc.service_id)
  if (!originalService) {
    return res.status(404).json({ error: 'Triggering service not found' })
  }

  // Conflict guard: check if an active sibling already exists at (url, detected_protocol)
  const existingSibling = db.prepare(
    "SELECT id FROM services WHERE url = ? AND protocol = ? AND status = 'active' AND (provider_deleted = 0 OR provider_deleted IS NULL)"
  ).get(pc.url, pc.detected_protocol)
  if (existingSibling) {
    return res.status(409).json({ error: 'Sibling service already exists', existing_service_id: existingSibling.id })
  }

  // Create sibling via registerUpsert with null pricing
  const newId = randomUUID()
  const bonusParams = {
    id: newId,
    name: `${originalService.name} (${pc.detected_protocol})`,
    description: originalService.description || null,
    url: pc.url,
    protocol: pc.detected_protocol,
    price_sats: null,
    price_usd: null,
    payment_asset: null,
    payment_network: null,
    category: originalService.category || 'uncategorized',
    provider: originalService.provider || null,
    contact_email: originalService.contact_email || pc.contact_email || null,
    http_method: originalService.http_method || 'GET',
    probe_body: originalService.probe_body || null,
    hostname: extractHostname(pc.url),
  }

  const newService = registerUpsert().get(bonusParams)

  // Fire embedding for genuinely new protocol-change rows
  if (newService.registered_at === newService.updated_at) {
    setImmediate(() => generateEmbedding(newService.id).catch(() => {}))
  }

  // Set to active with admin-protocol-change approval reason and correct source
  db.prepare(
    "UPDATE services SET status = 'active', approval_reason = 'admin-protocol-change', source = 'protocol-change', updated_at = datetime('now') WHERE id = ?"
  ).run(newService.id)

  // Update protocol_changes row
  db.prepare(
    "UPDATE protocol_changes SET status = 'approved', reviewed_at = datetime('now'), created_service_id = ? WHERE id = ?"
  ).run(newService.id, pc.id)

  res.json({ message: 'Protocol change approved', id: pc.id, created_service_id: newService.id })
})

router.post('/admin/protocol-changes/:id/dismiss', (req, res) => {
  const result = db.prepare(
    "UPDATE protocol_changes SET status = 'dismissed', reviewed_at = datetime('now') WHERE id = ? AND status = 'pending'"
  ).run(req.params.id)
  if (result.changes === 0) {
    return res.status(404).json({ error: 'No pending protocol change with that ID' })
  }
  res.json({ message: 'Protocol change dismissed', id: req.params.id })
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
  try {
    const opportunities = findOpportunities(db, { protocol: req.query.protocol })
    res.json({ opportunities, total: opportunities.length })
  } catch (err) {
    console.error('GET /api/v1/opportunities error:', err)
    res.status(500).json({ error: 'Internal Server Error' })
  }
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

// ─── Domain Verification ────────────────────────────────────────────────────

// POST /api/v1/claim — Initiate a domain claim
router.post('/claim', (req, res) => {
  try {
    const { domain, contact_email } = req.body || {}
    const result = initiateClaim(domain, contact_email)
    if (result.error) {
      return res.status(result.status).json({ error: result.error })
    }
    return res.status(result.status).json(result.data)
  } catch (err) {
    console.error('[claim] Error:', err.message)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/v1/claim/verify — Verify a pending domain claim
router.post('/claim/verify', async (req, res) => {
  try {
    const { domain } = req.body || {}
    const result = await verifyClaim(domain)
    if (result.error) {
      return res.status(result.status).json({ error: result.error })
    }
    return res.status(result.status).json(result.data)
  } catch (err) {
    console.error('[claim/verify] Error:', err.message)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/v1/claim/revoke — Revoke a verified domain claim
router.post('/claim/revoke', (req, res) => {
  try {
    const { domain, verification_token } = req.body || {}
    const result = revokeClaim(domain, verification_token)
    if (result.error) {
      return res.status(result.status).json({ error: result.error })
    }
    return res.status(result.status).json(result.data)
  } catch (err) {
    console.error('[claim/revoke] Error:', err.message)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// PATCH /api/v1/services/:id — Edit a listing by verified domain owner
router.patch('/services/:id', (req, res) => {
  try {
    const result = editService(req.params.id, req.body || {})
    if (result.error) {
      return res.status(result.status).json({ error: result.error })
    }
    const editedFields = Object.keys(req.body || {}).filter(k => !['domain', 'verification_token'].includes(k))
    console.log(`[services/patch] EDIT: service=${req.params.id} domain=${req.body?.domain} fields=${editedFields.join(',')}`)
    return res.status(result.status).json(result.data)
  } catch (err) {
    console.error('[services/patch] Error:', err.message)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/v1/services/:id — Soft-delete a listing by verified domain owner
router.delete('/services/:id', (req, res) => {
  try {
    const result = deleteService(req.params.id, req.body || {})
    if (result.error) {
      return res.status(result.status).json({ error: result.error })
    }
    console.log(`[services/delete] SOFT-DELETE: service=${req.params.id} domain=${req.body?.domain}`)
    return res.status(result.status).json(result.data)
  } catch (err) {
    console.error('[services/delete] Error:', err.message)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/v1/services/bulk-delete — Soft-delete multiple listings by verified domain owner
router.post('/services/bulk-delete', (req, res) => {
  try {
    const { domain, verification_token, service_ids } = req.body || {}
    const result = bulkDeleteServices(service_ids, { domain, verification_token })
    if (result.error) {
      return res.status(result.status).json({ error: result.error })
    }
    console.log(`[services/bulk-delete] SOFT-DELETE: domain=${domain} deleted=${result.data.deleted.length} skipped=${result.data.skipped.length}`)
    return res.status(result.status).json(result.data)
  } catch (err) {
    console.error('[services/bulk-delete] Error:', err.message)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
export { domainProbeQueue, PROBE_INTER_DELAY_MS }
