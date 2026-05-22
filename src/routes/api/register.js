import { Router } from 'express'
import { randomUUID } from 'crypto'
import { decode as decodeBolt11 } from 'light-bolt11-decoder'
import { constantTimeEqual } from '../../util/constant-time.js'
import db from '../../db.js'
import { getCachedBtcUsdRate } from '../../services/btc-price.js'
import { normalizeUrl, extractHostname } from '../../services/url-normalize.js'
import { probeEndpoint } from '../../services/probe-endpoint.js'
import { getPrimaryDetection } from '../../services/detect-protocol.js'
import { DEPRECATED_ENV_SECRET, DEPRECATED_HEADER, DEPRECATED_PROVIDER } from '../../services/partner-gateway-aliases.js'
import { emit } from '../../services/events.js'
import { discoverProbeConfig } from '../../services/wellknown-discovery.js'
import { generateEmbedding } from '../../services/embeddings.js'
import { registerUpsert } from '../../services/service-registration.js'

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
    // Requires PARTNER_GATEWAY_SECRET env var + matching X-Partner-Gateway-Secret header
    const gatewaySecret = process.env.PARTNER_GATEWAY_SECRET || process.env[DEPRECATED_ENV_SECRET]
    const gatewayHeader = req.get('x-partner-gateway-secret') || req.get(DEPRECATED_HEADER)
    let gatewaySecretValid = false
    if (gatewaySecret && gatewayHeader) {
      gatewaySecretValid = constantTimeEqual(gatewaySecret, gatewayHeader)
    }
    if (service.status === 'pending' && (body.provider === 'partner-gateway' || body.provider === DEPRECATED_PROVIDER) && gatewaySecretValid) {
      db.prepare(
        "UPDATE services SET status = 'active', approval_reason = 'partner-gateway', updated_at = datetime('now') WHERE id = ? AND status = 'pending'"
      ).run(service.id)
      service = { ...service, status: 'active', approval_reason: 'partner-gateway' }
      console.log(`[register] Auto-approved partner-gateway registration: ${url}`)
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
      if (bonusService.status === 'pending' && (body.provider === 'partner-gateway' || body.provider === DEPRECATED_PROVIDER) && gatewaySecretValid) {
        db.prepare(
          "UPDATE services SET status = 'active', approval_reason = 'partner-gateway', updated_at = datetime('now') WHERE id = ? AND status = 'pending'"
        ).run(bonusService.id)
        bonusService = { ...bonusService, status: 'active', approval_reason: 'partner-gateway' }
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

export { domainProbeQueue, PROBE_INTER_DELAY_MS }
export default router
