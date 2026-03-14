import { isPrivateIp, isBlockedScheme, resolveAndCheck } from '../health/checker.js'
import { parseWwwAuthenticate } from './l402-utils.js'
import { parsePaymentRequired, parsePaymentRequiredBody } from './x402-utils.js'

const PROBE_TIMEOUT_MS = 10000

/**
 * Validate a URL for the live probe endpoint.
 * @param {string} url
 * @returns {string|null} Error message if invalid, null if valid
 */
export function validateProbeUrl(url) {
  if (!url || typeof url !== 'string') return 'URL is required'

  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return 'Only HTTPS URLs are supported'

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
        message: `L402 protocol detected`,
        headers: { 'WWW-Authenticate': headerVal },
      }
    }
    if (protocol === 'x402') {
      const headerVal = rawHeaders['PAYMENT-REQUIRED'] || rawHeaders['payment-required'] || ''
      return {
        step: 'headers',
        protocol: 'x402',
        message: `x402 protocol detected`,
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
      message: `Probe complete`,
    }
  },

  error(errorMessage) {
    return { step: 'error', message: errorMessage }
  },
}

/**
 * Run a live probe against a URL, yielding SSE-formatted step objects.
 * @param {string} url
 * @yields {{ step: string, message: string, ... }}
 */
export async function* runProbeSteps(url) {
  const startTime = Date.now()

  yield formatProbeSteps.connect(url)

  // DNS / SSRF check
  const blockReason = await resolveAndCheck(url)
  if (blockReason) {
    yield formatProbeSteps.error(`Blocked: ${blockReason}`)
    return
  }

  // Perform HTTP probe
  const method = 'GET'
  yield formatProbeSteps.request(method, url)

  let httpStatus, responseTimeMs, wwwAuthenticate, paymentRequired, responseBody

  try {
    // HEAD first
    const headStart = Date.now()
    const headRes = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: 'manual',
    })
    httpStatus = headRes.status
    responseTimeMs = Date.now() - headStart
    wwwAuthenticate = headRes.headers.get('www-authenticate')
    paymentRequired = headRes.headers.get('payment-required')

    // If not 402, retry with GET
    if (httpStatus !== 402) {
      const getStart = Date.now()
      const getRes = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        redirect: 'manual',
      })
      httpStatus = getRes.status
      responseTimeMs = Date.now() - getStart
      wwwAuthenticate = getRes.headers.get('www-authenticate')
      paymentRequired = getRes.headers.get('payment-required')

      if (httpStatus === 402 && !paymentRequired) {
        try {
          responseBody = await getRes.text()
          if (responseBody.length > 65536) responseBody = null
        } catch { responseBody = null }
      }
    }
  } catch (err) {
    const msg = (err.name === 'TimeoutError' || err.code === 'ABORT_ERR')
      ? 'Connection timed out (10s)'
      : err.message
    yield formatProbeSteps.error(msg)
    return
  }

  yield formatProbeSteps.response(httpStatus, responseTimeMs)

  // Detect protocol from headers
  let detectedProtocol = null
  const rawHeaders = {}

  if (wwwAuthenticate) {
    const parsed = parseWwwAuthenticate(wwwAuthenticate)
    if (parsed.scheme && /L402|LSAT/i.test(parsed.scheme)) {
      detectedProtocol = 'L402'
      rawHeaders['WWW-Authenticate'] = wwwAuthenticate
    }
  }

  if (!detectedProtocol && paymentRequired) {
    const parsed = parsePaymentRequired(paymentRequired)
    if (parsed.valid) {
      detectedProtocol = 'x402'
      rawHeaders['PAYMENT-REQUIRED'] = paymentRequired
    }
  }

  if (!detectedProtocol && responseBody) {
    const bodyParsed = parsePaymentRequiredBody(responseBody)
    if (bodyParsed.valid) {
      detectedProtocol = 'x402'
      rawHeaders['PAYMENT-REQUIRED'] = '(from response body — x402 V1)'
    }
  }

  yield formatProbeSteps.headers(detectedProtocol, rawHeaders)

  // Classify health
  let healthStatus = 'unknown'
  if (httpStatus === 402 && detectedProtocol) {
    healthStatus = 'healthy'
  } else if (httpStatus === 402) {
    healthStatus = 'degraded' // 402 but no recognizable protocol
  } else if (httpStatus === 200) {
    healthStatus = 'degraded' // Paywall not active
  } else if (httpStatus >= 500) {
    healthStatus = 'down'
  } else {
    healthStatus = 'degraded'
  }

  yield formatProbeSteps.analysis(healthStatus, detectedProtocol)

  const totalTime = Date.now() - startTime
  yield formatProbeSteps.done(healthStatus, detectedProtocol, totalTime)
}
