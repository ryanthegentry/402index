import { isPrivateIp, classifyHealthStatus } from '../health/checker.js'
import { decodeMppRequest, getPrimaryDetection } from './detect-protocol.js'
import { probeEndpoint } from './probe-endpoint.js'
import { liveProbeWithThrottle } from './live-probe-cache.js'

/**
 * Validate a URL for the live probe endpoint.
 * @param {string} url
 * @returns {string|null} Error message if invalid, null if valid
 */
export function validateProbeUrl(url) {
  if (!url || typeof url !== 'string') return 'URL is required'

  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return 'Only HTTP/HTTPS URLs are supported'

    const hostname = parsed.hostname.replace(/^\[|\]$/g, '')
    if (hostname === 'localhost') return 'Cannot probe localhost'

    // Sync check for IP literals — DNS-based check happens async in the SSE handler
    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) && isPrivateIp(hostname)) {
      return 'Cannot probe private/internal IP addresses'
    }
    if (hostname === '127.0.0.1' || hostname === '::1') {
      return 'Cannot probe loopback addresses'
    }
  } catch {
    return 'Invalid URL format'
  }

  return null
}

/**
 * Look up a URL in the services DB to get probe configuration.
 * Falls back to defaults for unknown URLs.
 * @param {object} db - better-sqlite3 database instance
 * @param {string} url
 * @returns {{ protocol: string|null, httpMethod: string, probeBody: string, consecutiveFailures: number, historicalP50: number|null }}
 */
export function buildProbeConfig(db, url) {
  const row = db.prepare(
    "SELECT protocol, http_method, probe_body, consecutive_failures, latency_p50_ms FROM services WHERE url = ? LIMIT 1"
  ).get(url)

  if (!row) {
    return { protocol: null, httpMethod: 'GET', probeBody: '{}', consecutiveFailures: 0, historicalP50: null }
  }

  return {
    protocol: row.protocol,
    httpMethod: row.http_method || 'GET',
    probeBody: row.probe_body || '{}',
    consecutiveFailures: row.consecutive_failures || 0,
    historicalP50: row.latency_p50_ms,
  }
}

/**
 * Step formatters for SSE probe events.
 * Each returns a plain object suitable for JSON serialization.
 */
export const formatProbeSteps = {
  connect(url) {
    const hostname = new URL(url).hostname
    return { step: 'connect', message: `Connecting to ${hostname}...` }
  },

  request(method, url) {
    return { step: 'request', message: `${method} ${url}` }
  },

  response(status, timeMs) {
    const statusText = status === 402 ? 'Payment Required'
      : status === 200 ? 'OK'
      : status === 405 ? 'Method Not Allowed'
      : status === 400 ? 'Bad Request'
      : status === 500 ? 'Internal Server Error'
      : status === 404 ? 'Not Found'
      : status >= 500 ? 'Server Error'
      : status >= 400 ? 'Client Error'
      : `Status ${status}`
    return { step: 'response', status, time_ms: timeMs, message: `HTTP ${status} ${statusText} (${timeMs}ms)` }
  },

  headers(protocol, rawHeaders) {
    if (protocol === 'L402') {
      const headerVal = rawHeaders['WWW-Authenticate'] || rawHeaders['www-authenticate'] || ''
      return {
        step: 'headers',
        protocol: 'L402',
        message: 'L402 protocol detected',
        headers: { 'WWW-Authenticate': headerVal },
      }
    }
    if (protocol === 'x402') {
      const headerVal = rawHeaders['PAYMENT-REQUIRED'] || rawHeaders['payment-required'] || ''
      return {
        step: 'headers',
        protocol: 'x402',
        message: 'x402 protocol detected',
        headers: { 'PAYMENT-REQUIRED': headerVal },
      }
    }
    if (protocol === 'MPP') {
      const headerVal = rawHeaders['WWW-Authenticate'] || rawHeaders['www-authenticate'] || ''
      return {
        step: 'headers',
        protocol: 'MPP',
        message: 'MPP protocol detected',
        headers: { 'WWW-Authenticate': headerVal },
      }
    }
    return {
      step: 'headers',
      protocol: null,
      message: 'No payment protocol headers detected',
      headers: {},
    }
  },

  l402Validation(valid, details) {
    const msg = valid
      ? `L402 compliance: valid (scheme=${details.scheme}, macaroon=${details.macaroon ? 'valid' : 'missing'}, invoice=${details.invoice ? 'valid' : 'missing'})`
      : `L402 compliance: failed (${!details.scheme ? 'missing scheme' : !details.macaroon ? 'invalid macaroon' : 'invalid invoice'})`
    return { step: 'l402_validation', valid, details, message: msg }
  },

  mppValidation(valid, details, degradeReason) {
    if (valid) {
      const parts = [`${details.method || '?'}/${details.intent || '?'}`]
      if (details.request) {
        const decoded = decodeMppRequest(details.request)
        if (decoded?.amount) {
          const decimals = decoded.methodDetails?.decimals || 6
          parts.push(`$${(parseFloat(decoded.amount) / Math.pow(10, decimals)).toFixed(4)}`)
        }
      }
      return {
        step: 'mpp_validation',
        valid: true,
        details,
        message: `MPP challenge valid — ${parts.join(', ')}`,
      }
    }
    return {
      step: 'mpp_validation',
      valid: false,
      details,
      message: `MPP challenge incomplete — ${degradeReason || 'missing fields'}`,
    }
  },

  postRetry(method, resultStatus) {
    return {
      step: 'post_retry',
      message: `Retrying with ${method} — got HTTP ${resultStatus}`,
    }
  },

  x402Validation(valid, details) {
    const parts = []
    if (details.assetKnown) parts.push(details.paymentMethod === 'lightning' ? 'known asset (BTC)' : 'known asset (USDC)')
    if (details.facilitatorReachable) parts.push('facilitator reachable')
    if (details.facilitatorReachable === false) parts.push('facilitator unreachable')
    const msg = valid
      ? `x402 payment validation: valid (${parts.join(', ') || 'basic structure valid'})`
      : `x402 payment validation: failed (invalid payment requirements)`
    return { step: 'x402_validation', valid, details, message: msg }
  },

  analysis(healthStatus, protocol) {
    const protoLabel = protocol || 'Unknown protocol'
    return {
      step: 'analysis',
      health_status: healthStatus,
      protocol,
      message: `${protoLabel} endpoint — status: ${healthStatus}`,
    }
  },

  done(healthStatus, protocol, timeMs) {
    return {
      step: 'done',
      health_status: healthStatus,
      protocol,
      total_time_ms: timeMs,
      message: 'Probe complete',
    }
  },

  error(errorMessage) {
    return { step: 'error', message: errorMessage }
  },
}

/**
 * Run a live probe against a URL using the shared probeEndpoint.
 * Looks up the service in DB for http_method, probe_body, protocol context.
 * Yields SSE-formatted step objects as each phase completes.
 * @param {string} url
 * @param {object} db - better-sqlite3 database instance
 * @yields {{ step: string, message: string, ... }}
 */
export async function* runProbeSteps(url, db) {
  const startTime = Date.now()

  yield formatProbeSteps.connect(url)

  // Look up service config from DB
  const config = buildProbeConfig(db, url)
  const method = config.httpMethod

  yield formatProbeSteps.request(method, url)

  // Use the shared probeEndpoint with redirect following + POST fallback
  // Wrapped in per-host debounce to prevent hammering same host on rapid probes
  const result = await liveProbeWithThrottle(url, probeEndpoint, {
    protocol: config.protocol,
    method,
    body: config.probeBody,
    followRedirects: true,
    postFallback: (!method || method === 'GET'),
  })

  if (result.errorMessage) {
    yield formatProbeSteps.error(result.errorMessage === 'timeout' ? 'Connection timed out (8s)' : result.errorMessage)
    return
  }

  yield formatProbeSteps.response(result.httpStatus, result.responseTimeMs)

  // Classify using the real health classifier
  const classification = classifyHealthStatus(
    result.httpStatus,
    result.errorMessage,
    config.consecutiveFailures,
    config.historicalP50,
    result.responseTimeMs
  )

  // ─── Protocol detection + validation ─────────────────────────────────
  const detection = getPrimaryDetection(result.detection, config.protocol || result.detection[0]?.protocol)
  let detectedProtocol = detection.protocol || config.protocol

  // Emit headers + protocol-specific validation for each detected protocol
  for (const det of result.detection) {
    yield formatProbeSteps.headers(det.protocol, det.rawHeaders)

    if (det.protocol === 'L402') {
      yield formatProbeSteps.l402Validation(det.valid, {
        scheme: det.details.scheme,
        macaroon: det.details.macaroonValid ? 'valid' : null,
        invoice: det.details.invoiceValid ? 'valid' : null,
      })
      if (!det.valid && det.protocol === detection.protocol) {
        classification.healthStatus = 'degraded'
        classification.checkStatus = 'degraded'
      }
    }

    if (det.protocol === 'MPP') {
      yield formatProbeSteps.mppValidation(det.valid, det.details, det.degradeReason)
      if (!det.valid && det.protocol === detection.protocol) {
        classification.healthStatus = 'degraded'
        classification.checkStatus = 'degraded'
      }
    }

    if (det.protocol === 'x402') {
      yield formatProbeSteps.x402Validation(det.valid, {
        assetKnown: det.details.assetKnown,
        facilitatorReachable: null, // Skip live facilitator check for speed in demo
      })
    }
  }

  // POST fallback results from probeEndpoint
  if (result.postFallback?.attempted) {
    yield formatProbeSteps.postRetry('POST', result.postFallback.httpStatus || 0)

    const postPrimary = getPrimaryDetection(result.postFallback.detection, config.protocol || result.postFallback.detection[0]?.protocol)
    if (postPrimary.valid) {
      classification.healthStatus = 'healthy'
      classification.checkStatus = 'healthy'
      classification.consecutiveFailures = 0
      detectedProtocol = postPrimary.protocol

      yield formatProbeSteps.headers(postPrimary.protocol, postPrimary.rawHeaders)
      if (postPrimary.protocol === 'L402') {
        yield formatProbeSteps.l402Validation(true, {
          scheme: postPrimary.details.scheme,
          macaroon: 'valid',
          invoice: 'valid',
        })
      } else if (postPrimary.protocol === 'MPP') {
        yield formatProbeSteps.mppValidation(true, postPrimary.details, null)
      } else if (postPrimary.protocol === 'x402') {
        yield formatProbeSteps.x402Validation(true, {
          assetKnown: postPrimary.details.assetKnown,
          facilitatorReachable: null,
        })
      }
    }
  }

  // Emit fallback headers step if nothing was detected
  const postPrimaryProtocol = getPrimaryDetection(result.postFallback?.detection || [], config.protocol || '').protocol
  if (result.detection.length === 0 && !postPrimaryProtocol) {
    yield formatProbeSteps.headers(detectedProtocol, {})
  }

  yield formatProbeSteps.analysis(classification.healthStatus, detectedProtocol)

  const totalTime = Date.now() - startTime
  yield formatProbeSteps.done(classification.healthStatus, detectedProtocol, totalTime)
}
