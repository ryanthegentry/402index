import dns from 'dns'
import { statfs } from 'fs/promises'
import { isIPv4, isIPv6 } from 'net'
import { dirname } from 'path'
import db, { DB_PATH } from '../db.js'

const TIMEOUT_MS = 5000
const CONCURRENCY = 10
const HEALTH_CHECK_RETENTION_DAYS = 3

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
function isBlockedScheme(urlStr) {
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

const getServices = () => stmt('getServices', 'SELECT id, url, protocol, latency_p50_ms, consecutive_failures FROM services')

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
    uptime_30d = @uptime_30d,
    updated_at = datetime('now')
  WHERE id = @id
`)

const getUptime = () => stmt('getUptime', `
  SELECT
    COUNT(*) as total,
    SUM(CASE WHEN status IN ('healthy', 'degraded') THEN 1 ELSE 0 END) as up
  FROM health_checks
  WHERE service_id = ?
    AND checked_at > datetime('now', '-30 days')
`)

const getRecentLatencies = () => stmt('getRecentLatencies', `
  SELECT response_time_ms FROM health_checks
  WHERE service_id = ? AND response_time_ms IS NOT NULL
  ORDER BY checked_at DESC
  LIMIT 20
`)

function calculateP50(serviceId) {
  const rows = getRecentLatencies().all(serviceId)
  if (rows.length === 0) return null
  const sorted = rows.map(r => r.response_time_ms).sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/**
 * Perform the HTTP check (HEAD then GET if needed).
 * @returns {{ httpStatus: number|null, responseTimeMs: number|null, errorMessage: string|null }}
 */
async function performHttpCheck(url) {
  // SSRF protection: block non-http(s) schemes
  if (isBlockedScheme(url)) {
    return { httpStatus: null, responseTimeMs: null, errorMessage: 'blocked: non-http(s) scheme' }
  }

  // SSRF protection: resolve hostname and check against private IP ranges
  const blockReason = await resolveAndCheck(url)
  if (blockReason) {
    return { httpStatus: null, responseTimeMs: null, errorMessage: blockReason }
  }

  try {
    // Try HEAD first (manual redirect to prevent SSRF via redirects)
    const startHead = Date.now()
    const headRes = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'manual',
    })
    let httpStatus = headRes.status
    let responseTimeMs = Date.now() - startHead

    // If not 402, retry with GET (some endpoints only return 402 on GET)
    if (httpStatus !== 402) {
      const startGet = Date.now()
      const getRes = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'manual',
      })
      httpStatus = getRes.status
      responseTimeMs = Date.now() - startGet
    }

    return { httpStatus, responseTimeMs, errorMessage: null }
  } catch (err) {
    const errorMessage = (err.name === 'TimeoutError' || err.code === 'ABORT_ERR') ? 'timeout' : err.message
    return { httpStatus: null, responseTimeMs: null, errorMessage }
  }
}

/**
 * Classify HTTP result into two status domains:
 * - checkStatus: raw result for health_checks table ('healthy'|'degraded'|'down'|'timeout'|'error')
 * - healthStatus: derived aggregate for services table ('healthy'|'degraded'|'down'|'unknown')
 */
export function classifyHealthStatus(httpStatus, errorMessage, prevFailures, historicalP50, responseTimeMs) {
  if (errorMessage) {
    const newFailures = (prevFailures || 0) + 1
    return {
      healthStatus: newFailures >= 3 ? 'down' : 'unknown',
      checkStatus: errorMessage === 'timeout' ? 'timeout' : 'error',
      consecutiveFailures: newFailures,
    }
  }

  if (httpStatus === 402) {
    // 402 = paywall active = healthy (unless latency degraded)
    if (historicalP50 && responseTimeMs > historicalP50 * 2) {
      return { healthStatus: 'degraded', checkStatus: 'degraded', consecutiveFailures: 0 }
    }
    return { healthStatus: 'healthy', checkStatus: 'healthy', consecutiveFailures: 0 }
  }

  if (httpStatus === 200) {
    // 200 on a paywall = possible misconfiguration
    return { healthStatus: 'degraded', checkStatus: 'degraded', consecutiveFailures: prevFailures || 0 }
  }

  if (httpStatus >= 500) {
    const newFailures = (prevFailures || 0) + 1
    return {
      healthStatus: newFailures >= 3 ? 'down' : 'degraded',
      checkStatus: 'down',
      consecutiveFailures: newFailures,
    }
  }

  // Other status codes (3xx, 4xx except 402)
  return { healthStatus: 'degraded', checkStatus: 'degraded', consecutiveFailures: prevFailures || 0 }
}

/** Persist health check result and update service record. */
function persistHealthResult(serviceId, { checkStatus, healthStatus, httpStatus, responseTimeMs, errorMessage, consecutiveFailures, historicalP50 }) {
  insertHealthCheck().run({
    service_id: serviceId,
    status: checkStatus,
    response_time_ms: responseTimeMs,
    http_status: httpStatus,
    error_message: errorMessage || (httpStatus >= 500 ? `HTTP ${httpStatus}` : null),
  })

  const newP50 = errorMessage ? (historicalP50 || null) : (calculateP50(serviceId) ?? responseTimeMs)

  updateService().run({
    id: serviceId,
    health_status: healthStatus,
    latency_p50_ms: newP50,
    consecutive_failures: consecutiveFailures,
    uptime_30d: calculateUptime(serviceId),
  })
}

/** Check a single service: HTTP probe, classify result, persist. */
async function checkService(service) {
  const { id, url, latency_p50_ms: historicalP50, consecutive_failures: prevFailures } = service

  const httpResult = await performHttpCheck(url)
  const classification = classifyHealthStatus(
    httpResult.httpStatus, httpResult.errorMessage, prevFailures, historicalP50, httpResult.responseTimeMs
  )

  persistHealthResult(id, {
    ...classification,
    httpStatus: httpResult.httpStatus,
    responseTimeMs: httpResult.responseTimeMs,
    errorMessage: httpResult.errorMessage,
    historicalP50,
  })

  return { id, healthStatus: classification.healthStatus, httpStatus: httpResult.httpStatus }
}

function calculateUptime(serviceId) {
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

/** Check disk usage and take action if volume is filling up. */
async function checkDiskSpace() {
  try {
    const stats = await statfs(dirname(DB_PATH))
    const totalBytes = stats.blocks * stats.bsize
    const freeBytes = stats.bfree * stats.bsize
    const usedPct = ((totalBytes - freeBytes) / totalBytes) * 100

    if (usedPct > 90) {
      console.warn(`[health] CRITICAL: Disk ${usedPct.toFixed(1)}% full — emergency prune (1 day retention)`)
      const result = db.prepare(
        "DELETE FROM health_checks WHERE checked_at < datetime('now', '-1 day')"
      ).run()
      console.warn(`[health] Emergency prune deleted ${result.changes} rows`)
      db.pragma('incremental_vacuum')
      return 'continue'
    }

    if (usedPct > 80) {
      console.warn(`[health] WARNING: Disk ${usedPct.toFixed(1)}% full — skipping health check run`)
      return 'skip'
    }

    return 'continue'
  } catch (err) {
    console.warn(`[health] Could not check disk space: ${err.message} — continuing anyway`)
    return 'continue'
  }
}

/**
 * Run health checks for all services (prunes old records first).
 * @returns {Promise<{healthy: number, degraded: number, down: number, unknown: number, error: number}>} Counts by status
 */
export async function runHealthChecks() {
  // Check disk space — skip run if volume is too full
  const diskCheck = await checkDiskSpace()
  if (diskCheck === 'skip') {
    return { healthy: 0, degraded: 0, down: 0, unknown: 0, error: 0 }
  }

  // Prune old records before running new checks
  pruneOldHealthChecks()

  const services = getServices().all()
  console.log(`[health] Checking ${services.length} services...`)

  const results = { healthy: 0, degraded: 0, down: 0, unknown: 0, error: 0 }
  let checked = 0

  // Process in batches for concurrency control
  for (let i = 0; i < services.length; i += CONCURRENCY) {
    const batch = services.slice(i, i + CONCURRENCY)
    const batchResults = await Promise.allSettled(
      batch.map(s => checkService(s))
    )

    for (const result of batchResults) {
      checked++
      if (result.status === 'fulfilled') {
        const status = result.value.healthStatus
        results[status] = (results[status] || 0) + 1
      } else {
        results.error++
      }
    }

    if (checked % 100 === 0 || checked === services.length) {
      console.log(`[health] Progress: ${checked}/${services.length}`)
    }
  }

  console.log(`[health] Done. healthy=${results.healthy} degraded=${results.degraded} down=${results.down} unknown=${results.unknown}`)
  return results
}
