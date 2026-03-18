import { isPrivateIp, resolveAndCheck, performHttpCheck, classifyHealthStatus } from '../health/checker.js'
import { parseWwwAuthenticate, isValidMacaroon, isValidInvoice } from './l402-utils.js'
import { parsePaymentRequired, parsePaymentRequiredBody, validatePaymentRequirements } from './x402-utils.js'

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
    "SELECT protocol, http_method, probe_body, consecutive_failures, latency_p50_ms FROM services WHERE url = ? AND (status = 'active' OR status IS NULL) LIMIT 1"
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

  postRetry(method, resultStatus) {
    return {
      step: 'post_retry',
      message: `Retrying with ${method} — got HTTP ${resultStatus}`,
    }
  },

  x402Validation(valid, details) {
    const parts = []
    if (details.assetKnown) parts.push('known asset (USDC)')
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
 * Run a live probe against a URL using the same logic as the health checker.
 * Looks up the service in DB for http_method, probe_body, protocol context.
 * Yields SSE-formatted step objects as each phase completes.
 * @param {string} url
 * @param {object} db - better-sqlite3 database instance
 * @yields {{ step: string, message: string, ... }}
 */
export async function* runProbeSteps(url, db) {
  const startTime = Date.now()

  yield formatProbeSteps.connect(url)

  // DNS / SSRF check (same as health checker)
  const blockReason = await resolveAndCheck(url)
  if (blockReason) {
    yield formatProbeSteps.error(`Blocked: ${blockReason}`)
    return
  }

  // Look up service config from DB
  const config = buildProbeConfig(db, url)
  const method = config.httpMethod

  yield formatProbeSteps.request(method, url)

  // Use the real performHttpCheck from the health checker
  const httpResult = await performHttpCheck(url, method, config.probeBody)

  if (httpResult.errorMessage) {
    yield formatProbeSteps.error(httpResult.errorMessage === 'timeout' ? 'Connection timed out (10s)' : httpResult.errorMessage)
    return
  }

  yield formatProbeSteps.response(httpResult.httpStatus, httpResult.responseTimeMs)

  // Classify using the real health classifier
  const classification = classifyHealthStatus(
    httpResult.httpStatus,
    httpResult.errorMessage,
    config.consecutiveFailures,
    config.historicalP50,
    httpResult.responseTimeMs
  )

  // ─── Protocol detection + validation ─────────────────────────────────

  let detectedProtocol = config.protocol // Trust DB if known
  const rawHeaders = {}

  // L402 detection + compliance validation
  if (httpResult.wwwAuthenticate) {
    const parsed = parseWwwAuthenticate(httpResult.wwwAuthenticate)
    if (parsed.scheme && /L402|LSAT/i.test(parsed.scheme)) {
      detectedProtocol = 'L402'
      rawHeaders['WWW-Authenticate'] = httpResult.wwwAuthenticate

      // L402 compliance check (same as checker.js lines 446-456)
      const macaroonValid = isValidMacaroon(parsed.macaroon)
      const invoiceValid = isValidInvoice(parsed.invoice)
      const isCompliant = macaroonValid && invoiceValid

      yield formatProbeSteps.headers('L402', rawHeaders)
      yield formatProbeSteps.l402Validation(isCompliant, {
        scheme: parsed.scheme,
        macaroon: macaroonValid ? 'valid' : null,
        invoice: invoiceValid ? 'valid' : null,
      })

      if (!isCompliant) {
        classification.healthStatus = 'degraded'
        classification.checkStatus = 'degraded'
      }
    }
  }

  // L402 POST auto-detection (same as checker.js lines 458-487)
  // If L402 (known or suspected) and initial probe wasn't healthy, try POST
  if (
    (detectedProtocol === 'L402' || config.protocol === 'L402') &&
    (!method || method === 'GET') &&
    classification.healthStatus !== 'healthy'
  ) {
    const shouldTryPost = (
      classification.checkStatus === 'method_not_allowed' ||
      httpResult.httpStatus === 400 ||
      httpResult.httpStatus === 200 ||
      httpResult.httpStatus === 405
    )

    if (shouldTryPost) {
      const postResult = await performHttpCheck(url, 'POST', config.probeBody)
      yield formatProbeSteps.postRetry('POST', postResult.httpStatus || 0)

      if (postResult.httpStatus === 402) {
        const postParsed = parseWwwAuthenticate(postResult.wwwAuthenticate)
        if (postParsed.scheme && /L402|LSAT/i.test(postParsed.scheme) &&
            isValidMacaroon(postParsed.macaroon) && isValidInvoice(postParsed.invoice)) {
          // POST works! Update classification
          classification.healthStatus = 'healthy'
          classification.checkStatus = 'healthy'
          classification.consecutiveFailures = 0
          detectedProtocol = 'L402'

          // Show the real headers from POST
          rawHeaders['WWW-Authenticate'] = postResult.wwwAuthenticate
          yield formatProbeSteps.headers('L402', rawHeaders)
          yield formatProbeSteps.l402Validation(true, {
            scheme: postParsed.scheme,
            macaroon: 'valid',
            invoice: 'valid',
          })
        }
      }
    }
  }

  // x402 detection + payment validation
  if (!detectedProtocol || detectedProtocol === 'x402') {
    let paymentRequiredHeader = httpResult.paymentRequired
    let v1BodyText = httpResult.responseBody

    // x402 V2 header parsing
    const parsed = parsePaymentRequired(paymentRequiredHeader)
    let accepts = null

    if (parsed.valid) {
      accepts = parsed.accepts
      detectedProtocol = 'x402'
      rawHeaders['PAYMENT-REQUIRED'] = paymentRequiredHeader
    } else if (v1BodyText) {
      // V1 body fallback
      const bodyParsed = parsePaymentRequiredBody(v1BodyText)
      if (bodyParsed.valid) {
        accepts = bodyParsed.accepts
        detectedProtocol = 'x402'
        rawHeaders['PAYMENT-REQUIRED'] = '(from response body — x402 V1)'
      }
    }

    if (detectedProtocol === 'x402') {
      // Only emit headers step if we haven't already (L402 path emits its own)
      if (!rawHeaders['WWW-Authenticate']) {
        yield formatProbeSteps.headers('x402', rawHeaders)
      }

      if (accepts) {
        const validation = validatePaymentRequirements(accepts)
        yield formatProbeSteps.x402Validation(validation.valid, {
          assetKnown: validation.assetKnown,
          facilitatorReachable: null, // Skip live facilitator check for speed in demo
        })
      }
    }
  }

  // If we still haven't emitted a headers step, emit one now
  if (!rawHeaders['WWW-Authenticate'] && !rawHeaders['PAYMENT-REQUIRED']) {
    yield formatProbeSteps.headers(detectedProtocol, rawHeaders)
  }

  yield formatProbeSteps.analysis(classification.healthStatus, detectedProtocol)

  const totalTime = Date.now() - startTime
  yield formatProbeSteps.done(classification.healthStatus, detectedProtocol, totalTime)
}
