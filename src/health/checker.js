import { randomUUID } from 'crypto'
import dns from 'dns'
import { statfs } from 'fs/promises'
import { isIPv4, isIPv6 } from 'net'
import { dirname } from 'path'
import db, {
  DB_PATH,
  HEALTH_CHECK_STATUSES,
  COUNTER_KEYS,
  incrementCounter,
  setCounter,
} from '../db.js'
import { parseWwwAuthenticate, isValidMacaroon, isValidInvoice } from '../services/l402-utils.js'
import { parsePaymentRequired, parsePaymentRequiredBody, validatePaymentRequirements } from '../services/x402-utils.js'
import { detectProtocol, getPrimaryDetection } from '../services/detect-protocol.js'
import { probeEndpoint } from '../services/probe-endpoint.js'

const TIMEOUT_MS = 5000
const CONCURRENCY = 10
const HEALTH_CHECK_RETENTION_DAYS = 3

// ─── Uptime semantics, pinned per status ─────────────────────────────────────
//
// Up counts toward numerator and denominator; down toward the denominator only; excluded statuses
// carry no availability signal at all and are left out of both. A 429 means the provider throttled
// our prober — scoring that as downtime punished the most popular endpoints in the index.

export const UPTIME_UP_STATUSES = ['healthy', 'degraded']
export const UPTIME_EXCLUDED_STATUSES = ['rate_limited']
export const UPTIME_DOWN_STATUSES = HEALTH_CHECK_STATUSES.filter(
  s => !UPTIME_UP_STATUSES.includes(s) && !UPTIME_EXCLUDED_STATUSES.includes(s)
)

/** Diagnostic stored with a 406 row: the provider rejected the request before the paywall ran. */
export const NOT_ACCEPTABLE_MESSAGE = 'HTTP 406: provider rejected request format before paywall'

const sqlStatusList = statuses => statuses.map(s => `'${s}'`).join(', ')

/**
 * Check if a resolved IP address is private/reserved.
 * @param {string|null} ip - IPv4 or IPv6 address to check
 * @returns {boolean} True if the IP is private, reserved, or malformed
 */
export function isPrivateIp(ip) {
  if (!ip) return true

  // IPv6 checks
  if (isIPv6(ip) || ip.includes(':')) {
    const lower = ip.toLowerCase()
    if (lower === '::1') return true                          // IPv6 loopback
    if (lower.startsWith('fe80:')) return true                // Link-local fe80::/10
    if (lower.startsWith('fd') || lower.startsWith('fc')) return true  // ULA fd00::/8 + fc00::/7
    // IPv4-mapped IPv6 (::ffff:x.x.x.x)
    const v4match = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (v4match) return isPrivateIp(v4match[1])
    return false
  }

  // IPv4 checks — parse octets
  const parts = ip.split('.')
  if (parts.length !== 4) return true // Malformed
  const octets = parts.map(Number)
  if (octets.some(o => isNaN(o) || o < 0 || o > 255)) return true

  const [a, b] = octets
  if (a === 10) return true                           // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true    // 172.16.0.0/12
  if (a === 192 && b === 168) return true             // 192.168.0.0/16
  if (a === 127) return true                          // 127.0.0.0/8
  if (a === 169 && b === 254) return true             // 169.254.0.0/16 (link-local)
  if (a === 0) return true                            // 0.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true   // 100.64.0.0/10 (CGNAT)

  return false
}

// Validate URL scheme only (hostname checked after DNS resolution)
export function isBlockedScheme(urlStr) {
  try {
    const parsed = new URL(urlStr)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return true
    return false
  } catch {
    return true // Malformed URL = blocked
  }
}

/**
 * Resolve hostname and check if it points to a private IP (defeats DNS rebinding).
 * @param {string} urlStr - URL whose hostname will be resolved via DNS
 * @returns {Promise<string|null>} Block reason string if private/unreachable, or null if safe
 */
export async function resolveAndCheck(urlStr) {
  const parsed = new URL(urlStr)
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '') // Strip brackets from IPv6

  // If hostname is already an IP literal, check directly
  if (isIPv4(hostname) || isIPv6(hostname)) {
    return isPrivateIp(hostname) ? 'blocked: private/internal IP' : null
  }

  try {
    const { address } = await dns.promises.lookup(hostname)
    if (isPrivateIp(address)) {
      return `blocked: ${hostname} resolves to private IP ${address}`
    }
    return null
  } catch (err) {
    return `blocked: DNS resolution failed for ${hostname}: ${err.code || err.message}`
  }
}

// Lazy-initialized prepared statements (avoids coupling to db.js import order)
const stmts = {}
function stmt(key, sql) {
  if (!stmts[key]) stmts[key] = db.prepare(sql)
  return stmts[key]
}

const getServices = () => stmt('getServices', "SELECT id, url, protocol, http_method, probe_body, latency_p50_ms, consecutive_failures, consecutive_latency_spikes, registered_at, x402_payment_valid FROM services WHERE (status = 'active' OR status IS NULL) AND (provider_deleted = 0 OR provider_deleted IS NULL) AND (probe_status = 'probeable' OR probe_status IS NULL)")

const insertHealthCheck = () => stmt('insertHealthCheck', `
  INSERT INTO health_checks (service_id, status, response_time_ms, http_status, error_message)
  VALUES (@service_id, @status, @response_time_ms, @http_status, @error_message)
`)

const updateService = () => stmt('updateService', `
  UPDATE services SET
    health_status = @health_status,
    latency_p50_ms = @latency_p50_ms,
    last_checked = datetime('now'),
    last_seen_healthy = CASE WHEN @health_status = 'healthy' THEN datetime('now') ELSE last_seen_healthy END,
    consecutive_failures = @consecutive_failures,
    consecutive_latency_spikes = @consecutive_latency_spikes,
    uptime_30d = @uptime_30d,
    reliability_score = @reliability_score,
    x402_payment_valid = @x402_payment_valid,
    x402_facilitator_reachable = @x402_facilitator_reachable,
    x402_asset_known = @x402_asset_known,
    l402_compliant = @l402_compliant,
    l402_degrade_reason = @l402_degrade_reason,
    l402_format = @l402_format,
    lnget_compatible = @lnget_compatible,
    updated_at = datetime('now')
  WHERE id = @id
`)

const getUptime = () => stmt('getUptime', `
  SELECT
    COUNT(*) as total,
    SUM(CASE WHEN status IN (${sqlStatusList(UPTIME_UP_STATUSES)}) THEN 1 ELSE 0 END) as up
  FROM health_checks
  WHERE service_id = ?
    AND checked_at > datetime('now', '-${HEALTH_CHECK_RETENTION_DAYS} days')
    AND status NOT IN (${sqlStatusList(UPTIME_EXCLUDED_STATUSES)})
`)

const getRecentLatencies = () => stmt('getRecentLatencies', `
  SELECT response_time_ms FROM health_checks
  WHERE service_id = ? AND response_time_ms IS NOT NULL
  ORDER BY checked_at DESC
  LIMIT 20
`)

const persistHttpMethod = () => stmt('persistHttpMethod', `
  UPDATE services SET http_method = @http_method, updated_at = datetime('now')
  WHERE id = @id AND (http_method IS NULL OR http_method = 'GET')
`)

// Protocol change detection statements
const getExistingProtocols = () => stmt('getExistingProtocols',
  "SELECT protocol FROM services WHERE url = ? AND provider_deleted = 0 AND status != 'rejected'"
)

const upsertProtocolChange = () => stmt('upsertProtocolChange', `
  INSERT INTO protocol_changes (id, url, hostname, service_id, registered_protocol, detected_protocol, type, contact_email)
  VALUES (@id, @url, @hostname, @service_id, @registered_protocol, @detected_protocol, @type, @contact_email)
  ON CONFLICT(url, detected_protocol, type) DO UPDATE SET
    last_detected_at = datetime('now'),
    detection_count = detection_count + 1,
    service_id = excluded.service_id
  WHERE status != 'dismissed'
`)

const getDomainEmail = () => stmt('getDomainEmail',
  "SELECT contact_email FROM domain_claims WHERE domain = ? AND status = 'verified'"
)

function calculateP50(serviceId) {
  const rows = getRecentLatencies().all(serviceId)
  if (rows.length === 0) return null
  const sorted = rows.map(r => r.response_time_ms).sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/**
 * Perform the HTTP check.
 * For GET (default): HEAD → fallback GET.
 * For POST: sends POST with empty JSON body (L402 middleware fires before body validation).
 * @param {string} url
 * @param {string} [httpMethod='GET']
 * @returns {{ httpStatus: number|null, responseTimeMs: number|null, errorMessage: string|null, wwwAuthenticate: string|null, paymentRequired: string|null, responseBody: string|null }}
 */
export async function performHttpCheck(url, httpMethod = 'GET', probeBody = '{}') {
  const empty = { httpStatus: null, responseTimeMs: null, errorMessage: null, wwwAuthenticate: null, paymentRequired: null, responseBody: null }

  // SSRF protection: block non-http(s) schemes
  if (isBlockedScheme(url)) {
    return { ...empty, errorMessage: 'blocked: non-http(s) scheme' }
  }

  // SSRF protection: resolve hostname and check against private IP ranges
  const blockReason = await resolveAndCheck(url)
  if (blockReason) {
    return { ...empty, errorMessage: blockReason }
  }

  try {
    if (httpMethod === 'POST') {
      const startPost = Date.now()
      const postRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: probeBody,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'manual',
      })
      return {
        httpStatus: postRes.status,
        responseTimeMs: Date.now() - startPost,
        errorMessage: null,
        wwwAuthenticate: postRes.headers.get('www-authenticate'),
        paymentRequired: postRes.headers.get('payment-required'),
        responseBody: null,
      }
    }

    // Default: HEAD → fallback GET
    const startHead = Date.now()
    const headRes = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'manual',
    })
    let httpStatus = headRes.status
    let responseTimeMs = Date.now() - startHead
    let wwwAuthenticate = headRes.headers.get('www-authenticate')
    let paymentRequired = headRes.headers.get('payment-required')

    // If not 402, retry with GET (some endpoints only return 402 on GET)
    let responseBody = null
    if (httpStatus !== 402) {
      const startGet = Date.now()
      const getRes = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'manual',
      })
      httpStatus = getRes.status
      responseTimeMs = Date.now() - startGet
      wwwAuthenticate = getRes.headers.get('www-authenticate')
      paymentRequired = getRes.headers.get('payment-required')

      // Capture response body for V1 x402 parsing (limit 64KB)
      if (httpStatus === 402 && !paymentRequired) {
        try {
          responseBody = await getRes.text()
          if (responseBody.length > 65536) responseBody = null
        } catch {
          responseBody = null
        }
      }
    }

    return { httpStatus, responseTimeMs, errorMessage: null, wwwAuthenticate, paymentRequired, responseBody }
  } catch (err) {
    const errorMessage = (err.name === 'TimeoutError' || err.code === 'ABORT_ERR') ? 'timeout' : err.message
    return { ...empty, errorMessage }
  }
}

/**
 * Classify HTTP result into two status domains:
 * - checkStatus: raw result for health_checks table ('healthy'|'degraded'|'down'|'timeout'|'error')
 * - healthStatus: derived aggregate for services table ('healthy'|'degraded'|'down'|'unknown')
 */
export function classifyHealthStatus(httpStatus, errorMessage, prevFailures, historicalP50, responseTimeMs, prevLatencySpikes = 0) {
  if (errorMessage) {
    const newFailures = (prevFailures || 0) + 1
    return {
      healthStatus: newFailures >= 3 ? 'down' : 'unknown',
      checkStatus: errorMessage === 'timeout' ? 'timeout' : 'error',
      consecutiveFailures: newFailures,
      consecutiveLatencySpikes: 0,
    }
  }

  if (httpStatus === 402) {
    // 402 = paywall active = healthy (unless sustained latency degradation)
    if (historicalP50 && responseTimeMs > historicalP50 * 2) {
      const newSpikes = (prevLatencySpikes || 0) + 1
      return {
        healthStatus: newSpikes >= 3 ? 'degraded' : 'healthy',
        checkStatus: newSpikes >= 3 ? 'degraded' : 'healthy',
        consecutiveFailures: 0,
        consecutiveLatencySpikes: newSpikes,
      }
    }
    return { healthStatus: 'healthy', checkStatus: 'healthy', consecutiveFailures: 0, consecutiveLatencySpikes: 0 }
  }

  if (httpStatus === 200) {
    // 200 on a paywall = possible misconfiguration
    return { healthStatus: 'degraded', checkStatus: 'degraded', consecutiveFailures: prevFailures || 0, consecutiveLatencySpikes: 0 }
  }

  if (httpStatus >= 500) {
    const newFailures = (prevFailures || 0) + 1
    return {
      healthStatus: newFailures >= 3 ? 'down' : 'degraded',
      checkStatus: 'down',
      consecutiveFailures: newFailures,
      consecutiveLatencySpikes: 0,
    }
  }

  // 429 = rate limited by provider. Don't punish — preserve previous health state.
  if (httpStatus === 429) {
    return { healthStatus: 'degraded', checkStatus: 'rate_limited', consecutiveFailures: prevFailures || 0, consecutiveLatencySpikes: 0 }
  }

  // 405 = Method Not Allowed. Signal for http_method auto-detection (future).
  if (httpStatus === 405) {
    return { healthStatus: 'degraded', checkStatus: 'method_not_allowed', consecutiveFailures: prevFailures || 0, consecutiveLatencySpikes: 0 }
  }

  // 406 = Not Acceptable. Provider rejected the request body before reaching the paywall.
  if (httpStatus === 406) {
    return { healthStatus: 'degraded', checkStatus: 'not_acceptable', consecutiveFailures: prevFailures || 0, consecutiveLatencySpikes: 0 }
  }

  // Other status codes (3xx, 4xx except 402/429/405/406)
  return { healthStatus: 'degraded', checkStatus: 'degraded', consecutiveFailures: prevFailures || 0, consecutiveLatencySpikes: 0 }
}

/**
 * Compute a 0-100 reliability score based on trailing health data.
 * Weights: uptime 50%, latency 25%, streak 15%, age 10%.
 */
export function computeReliabilityScore(service) {
  let score = 0

  // Uptime (50%)
  if (service.uptime_30d != null) {
    score += service.uptime_30d * 100 * 0.5
  }

  // Latency (25%)
  const p50 = service.latency_p50_ms
  if (p50 != null) {
    if (p50 < 200) score += 25
    else if (p50 < 500) score += 20
    else if (p50 < 1000) score += 15
    else if (p50 < 2000) score += 10
    else score += 5
  }

  // Streak (15%)
  const failures = service.consecutive_failures || 0
  if (failures === 0) score += 15
  else if (failures === 1) score += 10
  else if (failures === 2) score += 5

  // Age (10%)
  if (service.registered_at) {
    const ageMs = Date.now() - new Date(service.registered_at + 'Z').getTime()
    const ageDays = ageMs / (1000 * 60 * 60 * 24)
    if (ageDays > 7) score += 10
    else if (ageDays > 3) score += 7
    else if (ageDays > 1) score += 5
    else score += 2
  }

  return Math.round(score * 10) / 10
}

// ─── Per-host rate limiting & dedup ──────────────────────────────────────────

const PER_HOST_MIN_INTERVAL_MS = 1000

const hostLastProbe = new Map()
const checkedThisCycle = new Set()

export function getHostname(url) {
  try { return new URL(url).hostname } catch { return url }
}

export function shuffleArray(arr) {
  const shuffled = [...arr]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}

async function waitForHost(hostname) {
  const lastProbe = hostLastProbe.get(hostname)
  if (lastProbe) {
    const elapsed = Date.now() - lastProbe
    if (elapsed < PER_HOST_MIN_INTERVAL_MS) {
      await new Promise(r => setTimeout(r, PER_HOST_MIN_INTERVAL_MS - elapsed))
    }
  }
  hostLastProbe.set(hostname, Date.now())
}

// Facilitator reachability cache (15-minute TTL)
const facilitatorCache = new Map()
const FACILITATOR_CACHE_TTL_MS = 15 * 60 * 1000

/**
 * Check if a facilitator URL is reachable (cached).
 * @param {string} url
 * @returns {Promise<boolean>}
 */
async function checkFacilitatorReachable(url) {
  const cached = facilitatorCache.get(url)
  if (cached && Date.now() - cached.ts < FACILITATOR_CACHE_TTL_MS) {
    return cached.reachable
  }

  let reachable = false
  try {
    const blockReason = await resolveAndCheck(url)
    if (!blockReason) {
      const res = await fetch(url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'follow',
      })
      // Any non-error response means the facilitator is up
      reachable = res.status < 500
    }
  } catch {
    reachable = false
  }

  facilitatorCache.set(url, { reachable, ts: Date.now() })
  return reachable
}

/** Row-level diagnostic for statuses whose HTTP code alone does not explain the failure. */
function diagnosticMessage(checkStatus, httpStatus) {
  if (checkStatus === 'not_acceptable') return NOT_ACCEPTABLE_MESSAGE
  if (httpStatus >= 500) return `HTTP ${httpStatus}`
  return null
}

/**
 * Run one persist attempt in isolation.
 *
 * A failed write must not abort the remaining rows for this URL, nor the cycle. Failures are
 * counted in the DB (so the count survives restarts and the scripts/healthcheck.js process
 * boundary) and reported in their own category — a rejected write is not a probe error.
 */
function persistIsolated(persist, serviceId, payload, { role, protocol, url }, failures) {
  try {
    persist(serviceId, payload)
    return true
  } catch (err) {
    failures.push({
      category: 'persist',
      role,
      serviceId,
      protocol: protocol || null,
      url: url || null,
      status: payload.checkStatus ?? null,
      error: err.message,
    })
    incrementCounter(COUNTER_KEYS.HEALTH_WRITE_FAILURES, 1)
    console.error(
      `[health] persist failed (${role}) service=${serviceId} protocol=${protocol || '?'} ` +
      `status=${payload.checkStatus ?? '?'} url=${url || '?'}: ${err.message}`
    )
    return false
  }
}

/** Persist health check result and update service record. */
export function persistHealthResult(serviceId, { checkStatus, healthStatus, httpStatus, responseTimeMs, errorMessage, consecutiveFailures, consecutiveLatencySpikes, historicalP50, registeredAt, x402PaymentValid, x402FacilitatorReachable, x402AssetKnown, l402Compliant, l402DegradeReason, l402Format, lngetCompatible }) {
  try {
    // Read current status before update (for event emission)
    const oldStatus = db.prepare('SELECT health_status FROM services WHERE id = ?').get(serviceId)?.health_status

    insertHealthCheck().run({
      service_id: serviceId,
      status: checkStatus,
      response_time_ms: responseTimeMs,
      http_status: httpStatus,
      error_message: errorMessage || diagnosticMessage(checkStatus, httpStatus),
    })

    const newP50 = errorMessage ? (historicalP50 || null) : (calculateP50(serviceId) ?? responseTimeMs)
    const uptime = calculateUptime(serviceId)

    const reliability = computeReliabilityScore({
      uptime_30d: uptime,
      latency_p50_ms: newP50,
      consecutive_failures: consecutiveFailures,
      registered_at: registeredAt,
    })

    updateService().run({
      id: serviceId,
      health_status: healthStatus,
      latency_p50_ms: newP50,
      consecutive_failures: consecutiveFailures,
      consecutive_latency_spikes: consecutiveLatencySpikes ?? 0,
      uptime_30d: uptime,
      reliability_score: reliability,
      x402_payment_valid: x402PaymentValid ?? null,
      x402_facilitator_reachable: x402FacilitatorReachable ?? null,
      x402_asset_known: x402AssetKnown ?? null,
      l402_compliant: l402Compliant ?? null,
      l402_degrade_reason: l402DegradeReason ?? null,
      l402_format: l402Format ?? null,
      lnget_compatible: lngetCompatible ?? null,
    })

    // Emit events on health status change (fire-and-forget)
    if (oldStatus && oldStatus !== healthStatus) {
      import('../services/events.js').then(({ emit }) => {
        const serviceData = db.prepare('SELECT id, name, url, protocol, category, health_status FROM services WHERE id = ?').get(serviceId)
        if (!serviceData) return
        emit('service.health_changed', { ...serviceData, old_status: oldStatus }, db)
        if (healthStatus === 'down' && oldStatus !== 'down') {
          emit('service.down', serviceData, db)
        }
      }).catch(err => console.error('[health] Event emission error:', err.message))
    }
  } catch (err) {
    if (err.message && err.message.includes('FOREIGN KEY constraint failed')) {
      console.warn(`[health] Service ${serviceId} was deleted during check — skipping persist`)
      return
    }
    throw err
  }
}

/**
 * Build protocol-specific fields for persistHealthResult.
 * Extracted from checkService to enable reuse for sibling updates.
 *
 * @param {string} protocol - 'L402'|'x402'|'MPP'
 * @param {object} detection - Primary detection for this protocol from getPrimaryDetection()
 * @param {object} result - Probe result from probeEndpoint()
 * @param {object} service - Service row (needs x402_payment_valid, http_method)
 * @returns {Promise<{x402PaymentValid, x402FacilitatorReachable, x402AssetKnown, l402Format, lngetCompatible, l402DegradeReason, l402Compliant}>}
 */
async function buildProtocolFields(protocol, detection, result, service) {
  let x402PaymentValid = null
  let x402FacilitatorReachable = null
  let x402AssetKnown = null
  let l402Format = null

  if (protocol === 'x402' && result.httpStatus === 402) {
    const currentPaymentValid = service.x402_payment_valid
    if (currentPaymentValid != null && !result.paymentRequired) {
      x402PaymentValid = currentPaymentValid
    } else {
      let paymentRequiredHeader = result.paymentRequired
      let v1BodyText = result.responseBody

      // x402 GET retry — some servers only include payment headers on content-bearing responses
      if (!paymentRequiredHeader && !v1BodyText && (service.http_method || 'GET') !== 'POST') {
        try {
          const getRes = await fetch(service.url || result.finalUrl, {
            method: 'GET',
            signal: AbortSignal.timeout(TIMEOUT_MS),
            redirect: 'manual',
          })
          if (getRes.status === 402) {
            paymentRequiredHeader = getRes.headers.get('payment-required')
            if (!paymentRequiredHeader) {
              try {
                v1BodyText = await getRes.text()
                if (v1BodyText.length > 65536) v1BodyText = null
              } catch {
                v1BodyText = null
              }
            }
          }
        } catch {
          // GET retry failed
        }
      }

      const parsed = parsePaymentRequired(paymentRequiredHeader)
      let accepts = null

      if (parsed.valid) {
        accepts = parsed.accepts
      } else if (v1BodyText) {
        const bodyParsed = parsePaymentRequiredBody(v1BodyText)
        if (bodyParsed.valid) {
          accepts = bodyParsed.accepts
        }
      }

      if (accepts) {
        const validation = validatePaymentRequirements(accepts)
        x402PaymentValid = validation.valid ? 1 : 0
        x402AssetKnown = validation.assetKnown ? 1 : 0

        if (validation.facilitatorUrls.length > 0) {
          const reachResults = await Promise.all(
            validation.facilitatorUrls.map(u => checkFacilitatorReachable(u))
          )
          x402FacilitatorReachable = reachResults.some(r => r) ? 1 : 0
        } else {
          x402FacilitatorReachable = null
        }
      } else {
        x402PaymentValid = 0
      }
    }
  }

  // Gap 1: x402 endpoints that don't return 402 should get payment_valid=0, not NULL
  if (protocol === 'x402' && x402PaymentValid === null && !result.errorMessage) {
    x402PaymentValid = 0
  }

  // Extract L402 macaroon format for metadata (no health impact)
  if (protocol === 'L402') {
    const postL402 = getPrimaryDetection(result.postFallback?.detection || [], protocol)
    const det = postL402.valid
      ? postL402
      : getPrimaryDetection(result.detection, protocol)
    if (det?.details?.format) {
      l402Format = det.details.format
    }
  }

  return {
    x402PaymentValid,
    x402FacilitatorReachable,
    x402AssetKnown,
    l402Format,
    lngetCompatible: protocol === 'L402' ? (l402Format === 'v2_tlv' ? 1 : (l402Format ? 0 : null)) : null,
    l402Compliant: null,
  }
}

/**
 * Detect new/removed protocols from probe results and record in protocol_changes table.
 * Extracted from checkService() for independent testability.
 *
 * @param {string} url - The endpoint URL
 * @param {string} serviceId - The service ID being checked
 * @param {string} protocol - The service's registered protocol
 * @param {Map<string, object>} allDetections - Map of protocol → valid detection (already deduped)
 * @param {number|null} httpStatus - HTTP status code from the probe
 */
export function detectProtocolChanges(url, serviceId, protocol, allDetections, httpStatus) {
  const existingRows = getExistingProtocols().all(url)
  const existingProtocols = new Set(existingRows.map(r => r.protocol))

  const hostname = getHostname(url)
  const domainClaim = getDomainEmail().get(hostname)
  const contactEmail = domainClaim?.contact_email || null

  // Additions: detected protocols not in existing service rows
  for (const [detectedProto] of allDetections) {
    if (!existingProtocols.has(detectedProto)) {
      upsertProtocolChange().run({
        id: randomUUID(),
        url,
        hostname,
        service_id: serviceId,
        registered_protocol: protocol,
        detected_protocol: detectedProto,
        type: 'addition',
        contact_email: contactEmail,
      })
    }
  }

  // Removals: existing sibling protocols not in valid detection array
  // Only trigger on HTTP 402 responses — non-402/error indicates endpoint issues, not protocol removal
  if (httpStatus === 402) {
    for (const existingProto of existingProtocols) {
      if (existingProto === protocol) continue
      if (!allDetections.has(existingProto)) {
        upsertProtocolChange().run({
          id: randomUUID(),
          url,
          hostname,
          service_id: serviceId,
          registered_protocol: protocol,
          detected_protocol: existingProto,
          type: 'removal',
          contact_email: contactEmail,
        })
      }
    }
  }
}

const getSiblings = () => stmt('getSiblings', "SELECT id, url, protocol, http_method, probe_body, latency_p50_ms, consecutive_failures, consecutive_latency_spikes, registered_at, x402_payment_valid, probe_status FROM services WHERE url = ? AND id != ? AND (status = 'active' OR status IS NULL) AND (provider_deleted = 0 OR provider_deleted IS NULL)")

/**
 * Check a single service: HTTP probe, classify result, persist.
 *
 * @param {object} service - Service row
 * @param {object} [options]
 * @param {Function} [options.persist=persistHealthResult] - Injectable persist (tests)
 * @returns {Promise<{id: string, healthStatus: string, httpStatus: number|null, skipReason?: 'unprobeable'|'dedup',
 *   persisted: boolean, persistFailures: object[], siblingsUpdated: {id: string, protocol: string}[]}>}
 */
export async function checkService(service, { persist = persistHealthResult } = {}) {
  const { id, url, protocol, http_method, probe_body, latency_p50_ms: historicalP50, consecutive_failures: prevFailures, consecutive_latency_spikes: prevLatencySpikes, x402_payment_valid: currentPaymentValid } = service

  const persistFailures = []
  const siblingsUpdated = []
  const skipped = reason => ({
    id,
    healthStatus: 'skipped',
    httpStatus: null,
    skipReason: reason,
    persisted: false,
    persistFailures,
    siblingsUpdated,
  })

  // Skip unprobeable services — their health_status is managed via admin endpoint
  if (service.probe_status === 'unprobeable') return skipped('unprobeable')

  // Dedup guard: skip if already checked by a sibling in this cycle
  if (checkedThisCycle.has(id)) return skipped('dedup')
  checkedThisCycle.add(id)

  // Per-host rate limiting: wait if we probed this host recently
  await waitForHost(getHostname(url))

  const result = await probeEndpoint(url, {
    protocol,
    method: http_method || 'GET',
    body: probe_body || '{}',
    followRedirects: true,
    postFallback: (!http_method || http_method === 'GET'),
  })

  const classification = classifyHealthStatus(
    result.httpStatus, result.errorMessage, prevFailures, historicalP50, result.responseTimeMs, prevLatencySpikes
  )

  // L402/MPP validation: only degrade for invalid detection or payment hash mismatch
  // Per BLIP-0026, token format is agnostic — format-only issues are metadata, not health degradation
  if ((protocol === 'L402' || protocol === 'MPP') && result.httpStatus === 402 && classification.healthStatus === 'healthy') {
    const primaryDetection = getPrimaryDetection(result.detection, protocol)
    if (!primaryDetection.valid) {
      classification.healthStatus = 'degraded'
      classification.checkStatus = 'degraded'
    } else if (protocol === 'L402' && primaryDetection.details?.paymentHashMatch === false) {
      classification.healthStatus = 'degraded'
      classification.checkStatus = 'degraded'
      classification.degradeReason = primaryDetection.degradeReason || 'payment hash mismatch between macaroon and invoice'
    }
  }

  // POST fallback persistence — if probeEndpoint detected POST works, save it
  if (result.postFallback?.attempted) {
    const postPrimary = getPrimaryDetection(result.postFallback.detection, protocol)
    if (postPrimary.valid) {
      const postDetails = postPrimary.details
      if (protocol === 'L402' && postDetails?.paymentHashMatch === false) {
        classification.healthStatus = 'degraded'
        classification.checkStatus = 'degraded'
        classification.degradeReason = postPrimary.degradeReason || 'payment hash mismatch between macaroon and invoice'
      } else {
        classification.healthStatus = 'healthy'
        classification.checkStatus = 'healthy'
        classification.consecutiveFailures = 0
      }
      persistHttpMethod().run({ id, http_method: 'POST' })
    }
  }

  // Build protocol-specific fields via extracted helper
  const protoFields = await buildProtocolFields(protocol, getPrimaryDetection(result.detection, protocol), result, service)

  const persisted = persistIsolated(persist, id, {
    ...classification,
    httpStatus: result.httpStatus,
    responseTimeMs: result.responseTimeMs,
    errorMessage: result.errorMessage,
    historicalP50,
    registeredAt: service.registered_at,
    ...protoFields,
    l402DegradeReason: protocol === 'L402'
      ? (classification.degradeReason?.includes('payment hash') ? classification.degradeReason : null)
      : null,
  }, { role: 'primary', protocol, url }, persistFailures)

  // ─── Sibling lookup and update ──────────────────────────────────────────
  const siblings = getSiblings().all(url, id)

  for (const sibling of siblings) {
    // Skip unprobeable siblings — do not overwrite their health_status
    if (sibling.probe_status === 'unprobeable') continue

    // Mark sibling as checked synchronously (before any await) to prevent race conditions
    checkedThisCycle.add(sibling.id)

    const siblingDetection = getPrimaryDetection(result.detection, sibling.protocol)
    // Also check POST fallback detection for siblings
    const siblingPostDetection = result.postFallback?.detection
      ? getPrimaryDetection(result.postFallback.detection, sibling.protocol)
      : { valid: false }
    const hasSiblingProtocol = siblingDetection.protocol === sibling.protocol || siblingPostDetection.protocol === sibling.protocol

    if (result.errorMessage || (result.httpStatus && result.httpStatus !== 402)) {
      // Non-402 and error responses: apply same classification uniformly to siblings
      const sibClassification = classifyHealthStatus(
        result.httpStatus, result.errorMessage,
        sibling.consecutive_failures || 0, sibling.latency_p50_ms,
        result.responseTimeMs, sibling.consecutive_latency_spikes || 0
      )
      if (persistIsolated(persist, sibling.id, {
        ...sibClassification,
        httpStatus: result.httpStatus,
        responseTimeMs: result.responseTimeMs,
        errorMessage: result.errorMessage,
        historicalP50: sibling.latency_p50_ms,
        registeredAt: sibling.registered_at,
        x402PaymentValid: null,
        x402FacilitatorReachable: null,
        x402AssetKnown: null,
        l402Compliant: null,
        l402DegradeReason: null,
        l402Format: null,
        lngetCompatible: null,
      }, { role: 'sibling', protocol: sibling.protocol, url }, persistFailures)) {
        siblingsUpdated.push({ id: sibling.id, protocol: sibling.protocol })
      }
    } else if (hasSiblingProtocol) {
      // Sibling's protocol detected — run protocol-specific validation
      const sibClassification = classifyHealthStatus(
        result.httpStatus, result.errorMessage,
        sibling.consecutive_failures || 0, sibling.latency_p50_ms,
        result.responseTimeMs, sibling.consecutive_latency_spikes || 0
      )

      // L402/MPP validation adjustments for sibling
      if ((sibling.protocol === 'L402' || sibling.protocol === 'MPP') && result.httpStatus === 402 && sibClassification.healthStatus === 'healthy') {
        const det = siblingDetection.protocol === sibling.protocol ? siblingDetection : siblingPostDetection
        if (!det.valid) {
          sibClassification.healthStatus = 'degraded'
          sibClassification.checkStatus = 'degraded'
        } else if (sibling.protocol === 'L402' && det.details?.paymentHashMatch === false) {
          sibClassification.healthStatus = 'degraded'
          sibClassification.checkStatus = 'degraded'
          sibClassification.degradeReason = det.degradeReason || 'payment hash mismatch between macaroon and invoice'
        }
      }

      const sibProtoFields = await buildProtocolFields(sibling.protocol, siblingDetection, result, sibling)
      if (persistIsolated(persist, sibling.id, {
        ...sibClassification,
        httpStatus: result.httpStatus,
        responseTimeMs: result.responseTimeMs,
        errorMessage: result.errorMessage,
        historicalP50: sibling.latency_p50_ms,
        registeredAt: sibling.registered_at,
        ...sibProtoFields,
        l402DegradeReason: sibling.protocol === 'L402'
          ? (sibClassification.degradeReason?.includes('payment hash') ? sibClassification.degradeReason : null)
          : null,
      }, { role: 'sibling', protocol: sibling.protocol, url }, persistFailures)) {
        siblingsUpdated.push({ id: sibling.id, protocol: sibling.protocol })
      }
    } else {
      // Sibling's protocol NOT in detection array — mark degraded
      if (persistIsolated(persist, sibling.id, {
        healthStatus: 'degraded',
        checkStatus: 'degraded',
        httpStatus: result.httpStatus,
        responseTimeMs: result.responseTimeMs,
        errorMessage: null,
        consecutiveFailures: sibling.consecutive_failures || 0,
        consecutiveLatencySpikes: sibling.consecutive_latency_spikes || 0,
        historicalP50: sibling.latency_p50_ms,
        registeredAt: sibling.registered_at,
        x402PaymentValid: null,
        x402FacilitatorReachable: null,
        x402AssetKnown: null,
        l402Compliant: null,
        l402DegradeReason: sibling.protocol === 'x402' ? null : 'protocol not detected in probe response',
        l402Format: null,
        lngetCompatible: null,
      }, { role: 'sibling', protocol: sibling.protocol, url }, persistFailures)) {
        siblingsUpdated.push({ id: sibling.id, protocol: sibling.protocol })
      }
    }
  }

  // ─── Protocol change detection ───────────────────────────────────────────
  // Detect new/removed protocols after sibling loop, using already-collected detection data.
  // No additional HTTP requests — purely post-probe analysis.
  try {
    // Union result.detection and result.postFallback?.detection, dedup by protocol, valid only
    const allDetections = new Map()
    for (const d of (result.detection || [])) {
      if (d.valid && !allDetections.has(d.protocol)) allDetections.set(d.protocol, d)
    }
    for (const d of (result.postFallback?.detection || [])) {
      if (d.valid && !allDetections.has(d.protocol)) allDetections.set(d.protocol, d)
    }

    detectProtocolChanges(url, id, protocol, allDetections, result.httpStatus)
  } catch (err) {
    console.warn(`[health] Protocol change detection failed for ${url}: ${err.message}`)
  }

  return {
    id,
    healthStatus: classification.healthStatus,
    httpStatus: result.httpStatus,
    persisted,
    persistFailures,
    siblingsUpdated,
  }
}

export function calculateUptime(serviceId) {
  const row = getUptime().get(serviceId)
  if (!row || row.total === 0) return null
  return Math.round((row.up / row.total) * 10000) / 10000
}

function pruneOldHealthChecks() {
  const result = db.prepare(
    "DELETE FROM health_checks WHERE checked_at < datetime('now', @retention)"
  ).run({ retention: `-${HEALTH_CHECK_RETENTION_DAYS} days` })
  if (result.changes > 0) {
    console.log(`[health] Pruned ${result.changes} health checks older than ${HEALTH_CHECK_RETENTION_DAYS} days`)
    // Reclaim disk space after pruning
    db.pragma('incremental_vacuum')
  }
}

/**
 * Check disk usage and decide whether this health-check run may proceed.
 *
 * Above 90% the run is skipped after an emergency prune. It used to prune and then continue into
 * a full pass over every endpoint — hundreds of thousands of writes against the volume that just
 * reported itself nearly full, which is how the 2026-07-22 crash loop kept its footing.
 *
 * @returns {Promise<'continue'|'skip'>}
 */
export async function checkDiskSpace({ statfsFn = statfs, database = db } = {}) {
  try {
    const stats = await statfsFn(dirname(DB_PATH))
    const totalBytes = stats.blocks * stats.bsize
    const freeBytes = stats.bfree * stats.bsize
    const usedPct = ((totalBytes - freeBytes) / totalBytes) * 100

    if (usedPct > 90) {
      console.warn(`[health] CRITICAL: Disk ${usedPct.toFixed(1)}% full — emergency prune (1 day retention), skipping run`)
      try {
        const result = database.prepare(
          "DELETE FROM health_checks WHERE checked_at < datetime('now', '-1 day')"
        ).run()
        console.warn(`[health] Emergency prune deleted ${result.changes} rows`)
        database.pragma('incremental_vacuum')
      } catch (pruneErr) {
        // On a genuinely full volume even DELETE fails — it needs rollback-journal space.
        console.error(`[health] Emergency prune failed: ${pruneErr.message}`)
      }
      return 'skip'
    }

    if (usedPct > 80) {
      console.warn(`[health] WARNING: Disk ${usedPct.toFixed(1)}% full — skipping health check run`)
      return 'skip'
    }

    return 'continue'
  } catch (err) {
    // A full volume surfaces here as SQLITE_FULL; anything else is treated as a benign
    // statfs failure and must not stop health checks from running.
    if (err.code === 'SQLITE_FULL' || /disk is full/i.test(err.message || '')) {
      console.error(`[health] Disk full while checking space: ${err.message} — skipping run`)
      return 'skip'
    }
    console.warn(`[health] Could not check disk space: ${err.message} — continuing anyway`)
    return 'continue'
  }
}

// Rows a cycle never probes, classified exactly the way getServices selects them. getServices'
// exclusions are intentional (#236) and unchanged — reconciliation only has to account for them
// honestly, which means mirroring its predicates rather than approximating them.
const ACTIVE_PREDICATE = "(status = 'active' OR status IS NULL) AND (provider_deleted = 0 OR provider_deleted IS NULL)"
const PROBEABLE_PREDICATE = "(probe_status = 'probeable' OR probe_status IS NULL)"

const emptyProbedBreakdown = () => ({ healthy: 0, degraded: 0, down: 0, unknown: 0, error: 0 })

/**
 * Every services row as it stood when the cycle started.
 *
 * Reconciling a cycle-start probe set against end-of-cycle counts is not reconciliation: the
 * pollers run on the same hourly interval and insert with status defaulting to 'active', so a
 * multi-minute cycle routinely races inserts, deactivations and purges. Buckets are a partition of
 * this fixed id set, which is the only thing that can make `unaccounted` reliably 0 — and which
 * stops a row deactivated after being probed from landing in two buckets at once.
 *
 * @returns {{id: string, protocol: string, active: number, unprobeable: number}[]}
 */
export function snapshotServicesForCycle(database = db) {
  return database.prepare(
    `SELECT id,
            COALESCE(protocol, 'unknown') AS protocol,
            CASE WHEN ${ACTIVE_PREDICATE} THEN 1 ELSE 0 END AS active,
            CASE WHEN ${PROBEABLE_PREDICATE} THEN 0 ELSE 1 END AS unprobeable
     FROM services`
  ).all()
}

/**
 * Account for every services row carrying each protocol.
 *
 * The denominator is every row with that protocol in the cycle-start snapshot — the number the
 * digest calls "1,218". Buckets partition it: probed (by result status, including unknown and
 * error), sibling_updated (deduped but health-updated: checked, never "skipped"),
 * skipped_unprobeable, excluded_inactive, and persist_failed. `unaccounted` is the residual and
 * must be 0.
 *
 * Rows that appear or disappear while the cycle runs are reported in their own symmetric counters
 * — added_mid_cycle and vanished_mid_cycle — and never folded into the partition, because neither
 * one had a full cycle's worth of chances to land in a bucket.
 *
 * @returns {{byProtocol: Object<string, object>, vanished: number, added: number}}
 */
function buildReconciliation({ snapshot, probedById, siblingUpdatedIds, persistFailedIds, database = db }) {
  const recon = {}
  const bucketFor = protocol => {
    const key = protocol || 'unknown'
    if (!recon[key]) {
      recon[key] = {
        denominator: 0,
        probed: emptyProbedBreakdown(),
        probed_total: 0,
        sibling_updated: 0,
        skipped_unprobeable: 0,
        excluded_inactive: 0,
        persist_failed: 0,
        unaccounted: 0,
        added_mid_cycle: 0,
        vanished_mid_cycle: 0,
      }
    }
    return recon[key]
  }

  // Precedence, applied to a fixed id set so no row can be counted twice: what actually happened
  // to the row outranks what the table says about it now. A row probed at 00:05 and deactivated at
  // 00:30 was probed — reporting it as excluded_inactive as well is the double-count.
  const snapshotIds = new Set()
  for (const row of snapshot) {
    snapshotIds.add(row.id)
    const bucket = bucketFor(row.protocol)
    bucket.denominator++

    if (probedById.has(row.id)) {
      const status = probedById.get(row.id)
      bucket.probed[status] = (bucket.probed[status] || 0) + 1
      bucket.probed_total++
    } else if (siblingUpdatedIds.has(row.id)) {
      bucket.sibling_updated++
    } else if (persistFailedIds.has(row.id)) {
      bucket.persist_failed++
    } else if (!row.active) {
      bucket.excluded_inactive++
    } else if (row.unprobeable) {
      bucket.skipped_unprobeable++
    }
  }

  let added = 0
  let vanished = 0
  const endIds = new Set()
  for (const row of database.prepare(
    "SELECT id, COALESCE(protocol, 'unknown') AS protocol FROM services"
  ).all()) {
    endIds.add(row.id)
    if (!snapshotIds.has(row.id)) {
      added++
      bucketFor(row.protocol).added_mid_cycle++
    }
  }
  for (const row of snapshot) {
    if (!endIds.has(row.id)) {
      vanished++
      bucketFor(row.protocol).vanished_mid_cycle++
    }
  }

  for (const bucket of Object.values(recon)) {
    bucket.unaccounted = bucket.denominator - (
      bucket.probed_total + bucket.sibling_updated + bucket.skipped_unprobeable +
      bucket.excluded_inactive + bucket.persist_failed
    )
  }

  return { byProtocol: recon, vanished, added }
}

/**
 * One-line cycle summary, shared by both callers so the scheduler and scripts/healthcheck.js
 * report identically.
 * @param {object} result - runHealthChecks() return value
 * @returns {string}
 */
export function formatCycleSummary(result) {
  const recon = result?.reconciliation || {}
  const unaccounted = Object.values(recon).reduce((sum, r) => sum + (r.unaccounted || 0), 0)
  const perProtocol = Object.entries(recon).map(([proto, r]) =>
    `${proto}[denominator=${r.denominator} probed=${r.probed_total} sibling_updated=${r.sibling_updated} ` +
    `unprobeable=${r.skipped_unprobeable} inactive=${r.excluded_inactive} ` +
    `persist_failed=${r.persist_failed} unaccounted=${r.unaccounted}]`
  ).join(' ')

  return [
    `cycle: healthy=${result?.healthy ?? 0} degraded=${result?.degraded ?? 0} down=${result?.down ?? 0}`,
    `unknown=${result?.unknown ?? 0} error=${result?.error ?? 0}`,
    `persist_failed=${result?.persistFailed ?? 0} unaccounted=${unaccounted}`,
    `added_mid_cycle=${result?.cycle?.added_mid_cycle ?? 0} vanished_mid_cycle=${result?.cycle?.vanished_mid_cycle ?? 0}`,
    perProtocol,
  ].join(' ').trim()
}

/**
 * Run health checks for all services (prunes old records first).
 *
 * @param {object} [options]
 * @param {number} [options.concurrency=10] - Endpoints probed in parallel per batch
 * @returns {Promise<{healthy: number, degraded: number, down: number, unknown: number, error: number,
 *   skipped: number, persistFailed: number, byProtocol: object, reconciliation: object,
 *   persistFailures: object[], cycle: object|null}>}
 */
export async function runHealthChecks({ concurrency = CONCURRENCY } = {}) {
  // Check disk space — skip run if volume is too full
  const diskCheck = await checkDiskSpace()
  if (diskCheck === 'skip') {
    return {
      healthy: 0, degraded: 0, down: 0, unknown: 0, error: 0, skipped: 0, persistFailed: 0,
      byProtocol: {}, reconciliation: {}, persistFailures: [], cycle: null,
    }
  }

  // Prune old records before running new checks
  pruneOldHealthChecks()

  // Reset per-cycle state
  hostLastProbe.clear()
  checkedThisCycle.clear()

  // Snapshot first, then select: a row inserted between the two calls is reported as
  // added_mid_cycle rather than becoming an unaccounted residual.
  const snapshot = snapshotServicesForCycle()

  // Shuffle to distribute same-host endpoints across the full check cycle
  const services = shuffleArray(getServices().all())
  console.log(`[health] Checking ${services.length} services...`)

  const results = { healthy: 0, degraded: 0, down: 0, unknown: 0, error: 0, skipped: 0, persistFailed: 0 }
  const byProtocol = {}
  const errors = []
  const persistFailures = []
  const probedById = new Map()          // service id → result status bucket
  const siblingUpdatedIds = new Set()   // deduped rows whose health was updated by a sibling pass
  const persistFailedIds = new Set()
  let checked = 0
  const startTime = Date.now()

  // Process in batches for concurrency control
  for (let i = 0; i < services.length; i += concurrency) {
    const batch = services.slice(i, i + concurrency)
    const batchResults = await Promise.allSettled(
      batch.map(s => checkService(s))
    )

    for (let j = 0; j < batchResults.length; j++) {
      checked++
      const result = batchResults[j]
      const service = batch[j]
      const proto = service.protocol || 'unknown'

      if (!byProtocol[proto]) byProtocol[proto] = emptyProbedBreakdown()

      if (result.status === 'fulfilled') {
        const status = result.value.healthStatus

        for (const sibling of result.value.siblingsUpdated || []) {
          siblingUpdatedIds.add(sibling.id)
        }

        for (const failure of result.value.persistFailures || []) {
          persistFailures.push(failure)
          persistFailedIds.add(failure.serviceId)
          results.persistFailed++
        }

        if (status === 'skipped') {
          results.skipped++
        } else if (result.value.persisted) {
          results[status] = (results[status] || 0) + 1
          byProtocol[proto][status] = (byProtocol[proto][status] || 0) + 1
          probedById.set(service.id, status)
        }
        // A probed row whose write was rejected is reported under persist_failed, not as a result.
      } else {
        results.error++
        byProtocol[proto].error++
        probedById.set(service.id, 'error')
        if (errors.length < 10) {
          errors.push({ url: service.url, protocol: proto, error: result.reason?.message || 'unknown' })
        }
      }
    }

    if (checked % 500 === 0 || checked === services.length) {
      console.log(`[health] Progress: ${checked}/${services.length}`)
    }
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1)
  const { byProtocol: reconciliation, vanished, added } = buildReconciliation({
    snapshot, probedById, siblingUpdatedIds, persistFailedIds,
  })
  const unaccounted = Object.values(reconciliation).reduce((sum, r) => sum + r.unaccounted, 0)

  const cycle = {
    finished_at: new Date().toISOString(),
    duration_sec: Number(durationSec),
    concurrency,
    dispatched: services.length,
    results: { ...results },
    persist_failed: results.persistFailed,
    unaccounted,
    // The two directions the table can move under a running cycle. Reported, never folded into the
    // snapshot's partition — that is what keeps `unaccounted` an integrity signal instead of noise.
    vanished_mid_cycle: vanished,
    added_mid_cycle: added,
    by_protocol: reconciliation,
  }
  if (vanished > 0 || added > 0) {
    console.log(
      `[health] table changed under the cycle: ${added} row(s) added, ${vanished} row(s) deleted — ` +
      'reported separately, outside the cycle-start denominator'
    )
  }

  // Written from whichever process ran the cycle, so the digest reports the real last cycle.
  setCounter(COUNTER_KEYS.LAST_HEALTH_CYCLE, JSON.stringify(cycle))

  console.log(`[health] Done in ${durationSec}s. healthy=${results.healthy} degraded=${results.degraded} down=${results.down} unknown=${results.unknown}`)

  // Per-protocol reconciliation — the full breakdown, not just healthy/degraded/down
  for (const [proto, r] of Object.entries(reconciliation)) {
    console.log(
      `[health] ${proto}: denominator=${r.denominator} probed=${r.probed_total} ` +
      `(healthy=${r.probed.healthy} degraded=${r.probed.degraded} down=${r.probed.down} ` +
      `unknown=${r.probed.unknown} error=${r.probed.error}) sibling_updated=${r.sibling_updated} ` +
      `skipped_unprobeable=${r.skipped_unprobeable} excluded_inactive=${r.excluded_inactive} ` +
      `persist_failed=${r.persist_failed} unaccounted=${r.unaccounted} ` +
      `added_mid_cycle=${r.added_mid_cycle} vanished_mid_cycle=${r.vanished_mid_cycle}`
    )
  }

  // Persist failures are their own category — never folded into the probe-error count
  if (persistFailures.length > 0) {
    const shown = persistFailures.slice(0, 10)
    const truncated = persistFailures.length > shown.length ? ' — list truncated' : ''
    console.error(`[health] Persist failures (${persistFailures.length} total, showing ${shown.length}${truncated}):`)
    for (const f of shown) {
      console.error(`[health]   ${f.role} ${f.protocol || '?'} service=${f.serviceId} status=${f.status}: ${f.error}`)
    }
  }

  // First N errors for debugging
  if (errors.length > 0) {
    console.log(`[health] Errors (${results.error} total, first ${errors.length}):`)
    for (const e of errors) {
      console.log(`[health]   ${e.protocol} ${e.url}: ${e.error}`)
    }
  }

  return { ...results, byProtocol, reconciliation, persistFailures, cycle }
}
