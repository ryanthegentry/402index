import fetch from 'node-fetch'
import dns from 'dns'
import { isIPv4, isIPv6 } from 'net'
import db from '../db.js'

const TIMEOUT_MS = 5000
const CONCURRENCY = 10
const HEALTH_CHECK_RETENTION_DAYS = 30

// Check if a resolved IP address is private/reserved
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

// Resolve hostname and check if it points to a private IP (defeats DNS rebinding)
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

const getServices = db.prepare('SELECT id, url, protocol, latency_p50_ms, consecutive_failures FROM services')

const insertHealthCheck = db.prepare(`
  INSERT INTO health_checks (service_id, status, response_time_ms, http_status, error_message)
  VALUES (@service_id, @status, @response_time_ms, @http_status, @error_message)
`)

const updateService = db.prepare(`
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

const getUptime = db.prepare(`
  SELECT
    COUNT(*) as total,
    SUM(CASE WHEN status IN ('healthy', 'degraded') THEN 1 ELSE 0 END) as up
  FROM health_checks
  WHERE service_id = ?
    AND checked_at > datetime('now', '-30 days')
`)

const getRecentLatencies = db.prepare(`
  SELECT response_time_ms FROM health_checks
  WHERE service_id = ? AND response_time_ms IS NOT NULL
  ORDER BY checked_at DESC
  LIMIT 20
`)

function calculateP50(serviceId) {
  const rows = getRecentLatencies.all(serviceId)
  if (rows.length === 0) return null
  const sorted = rows.map(r => r.response_time_ms).sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

async function checkService(service) {
  const { id, url, protocol, latency_p50_ms: historicalP50, consecutive_failures: prevFailures } = service

  let httpStatus = null
  let responseTimeMs = null
  let errorMessage = null
  let checkStatus = 'error'

  // SSRF protection: block non-http(s) schemes
  if (isBlockedScheme(url)) {
    errorMessage = 'blocked: non-http(s) scheme'
    checkStatus = 'error'
    insertHealthCheck.run({
      service_id: id, status: checkStatus, response_time_ms: null, http_status: null, error_message: errorMessage,
    })
    updateService.run({
      id, health_status: 'down', latency_p50_ms: historicalP50 || null,
      consecutive_failures: (prevFailures || 0) + 1, uptime_30d: calculateUptime(id),
    })
    return { id, healthStatus: 'down', httpStatus: null }
  }

  // SSRF protection: resolve hostname and check against private IP ranges (defeats DNS rebinding)
  const blockReason = await resolveAndCheck(url)
  if (blockReason) {
    errorMessage = blockReason
    checkStatus = 'error'
    insertHealthCheck.run({
      service_id: id, status: checkStatus, response_time_ms: null, http_status: null, error_message: errorMessage,
    })
    updateService.run({
      id, health_status: 'down', latency_p50_ms: historicalP50 || null,
      consecutive_failures: (prevFailures || 0) + 1, uptime_30d: calculateUptime(id),
    })
    return { id, healthStatus: 'down', httpStatus: null }
  }

  try {
    // Step 1: Try HEAD first (manual redirect to prevent SSRF via redirects)
    const startHead = Date.now()
    const headRes = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'manual',
    })
    httpStatus = headRes.status
    responseTimeMs = Date.now() - startHead

    // Step 2: If not 402, retry with GET (some endpoints only return 402 on GET)
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
  } catch (err) {
    errorMessage = err.name === 'TimeoutError' || err.code === 'ABORT_ERR'
      ? 'timeout'
      : err.message

    if (errorMessage === 'timeout') {
      checkStatus = 'timeout'
    }
  }

  // Determine health status
  let healthStatus = 'unknown'

  if (errorMessage) {
    // Failed to connect
    const newFailures = (prevFailures || 0) + 1
    checkStatus = checkStatus === 'timeout' ? 'timeout' : 'error'
    healthStatus = newFailures >= 3 ? 'down' : 'unknown'

    insertHealthCheck.run({
      service_id: id,
      status: checkStatus,
      response_time_ms: null,
      http_status: null,
      error_message: errorMessage,
    })

    updateService.run({
      id,
      health_status: healthStatus,
      latency_p50_ms: historicalP50 || null,
      consecutive_failures: newFailures,
      uptime_30d: calculateUptime(id),
    })

    return { id, healthStatus, httpStatus: null }
  }

  // Got a response
  if (httpStatus === 402) {
    // 402 = paywall active = healthy
    checkStatus = 'healthy'
    healthStatus = 'healthy'

    // Check for latency degradation
    if (historicalP50 && responseTimeMs > historicalP50 * 2) {
      checkStatus = 'degraded'
      healthStatus = 'degraded'
    }
  } else if (httpStatus === 200) {
    // 200 on a paywall service = possible misconfiguration
    checkStatus = 'degraded'
    healthStatus = 'degraded'
  } else if (httpStatus >= 500) {
    checkStatus = 'down'
    const newFailures = (prevFailures || 0) + 1
    healthStatus = newFailures >= 3 ? 'down' : 'degraded'

    insertHealthCheck.run({
      service_id: id,
      status: checkStatus,
      response_time_ms: responseTimeMs,
      http_status: httpStatus,
      error_message: `HTTP ${httpStatus}`,
    })

    updateService.run({
      id,
      health_status: healthStatus,
      latency_p50_ms: calculateP50(id) ?? historicalP50,
      consecutive_failures: newFailures,
      uptime_30d: calculateUptime(id),
    })

    return { id, healthStatus, httpStatus }
  } else {
    // Other status codes (3xx, 4xx except 402) — treat as degraded
    checkStatus = 'degraded'
    healthStatus = 'degraded'
  }

  insertHealthCheck.run({
    service_id: id,
    status: checkStatus,
    response_time_ms: responseTimeMs,
    http_status: httpStatus,
    error_message: null,
  })

  const newP50 = calculateP50(id) ?? responseTimeMs

  updateService.run({
    id,
    health_status: healthStatus,
    latency_p50_ms: newP50,
    consecutive_failures: healthStatus === 'healthy' ? 0 : (prevFailures || 0),
    uptime_30d: calculateUptime(id),
  })

  return { id, healthStatus, httpStatus }
}

function calculateUptime(serviceId) {
  const row = getUptime.get(serviceId)
  if (!row || row.total === 0) return null
  return Math.round((row.up / row.total) * 10000) / 10000
}

function pruneOldHealthChecks() {
  const result = db.prepare(
    `DELETE FROM health_checks WHERE checked_at < datetime('now', '-${HEALTH_CHECK_RETENTION_DAYS} days')`
  ).run()
  if (result.changes > 0) {
    console.log(`[health] Pruned ${result.changes} health checks older than ${HEALTH_CHECK_RETENTION_DAYS} days`)
    // Reclaim disk space after pruning
    db.pragma('incremental_vacuum')
  }
}

export async function runHealthChecks() {
  // Prune old records before running new checks
  pruneOldHealthChecks()

  const services = getServices.all()
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
