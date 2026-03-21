/**
 * Shared endpoint probe — single entry point for registration, health checks,
 * and live demo probes. Handles SSRF checks, redirect following, timeout,
 * protocol detection, and optional POST fallback.
 */

import { isBlockedScheme, resolveAndCheck } from '../health/checker.js'
import { detectProtocol } from './detect-protocol.js'

const PROBE_TIMEOUT_MS = 8000
const MAX_BODY_SIZE = 65536

/**
 * @param {string} url
 * @param {object} options
 * @param {string}  options.protocol     - Expected protocol: 'L402'|'x402'|'MPP'|null
 * @param {string}  options.method       - HTTP method: 'GET'|'POST' (default 'GET')
 * @param {string}  options.body         - Request body for POST (default '{}')
 * @param {number}  options.timeoutMs    - Timeout in ms (default 8000)
 * @param {boolean} options.followRedirects - Follow 3xx redirects with per-hop SSRF (default true)
 * @param {number}  options.maxRedirects - Max redirect hops (default 3)
 * @param {boolean} options.postFallback - Try POST if GET yields 405/400/200 (default false)
 * @returns {Promise<ProbeResult>}
 */
export async function probeEndpoint(url, {
  protocol = null,
  method = 'GET',
  body = '{}',
  timeoutMs = PROBE_TIMEOUT_MS,
  followRedirects = true,
  maxRedirects = 3,
  postFallback = false,
} = {}) {
  const empty = {
    httpStatus: null,
    responseTimeMs: null,
    errorMessage: null,
    finalUrl: url,
    redirectCount: 0,
    methodUsed: method,
    wwwAuthenticate: null,
    paymentRequired: null,
    responseBody: null,
    detection: { protocol: null, valid: false, degradeReason: null, details: {}, rawHeaders: {} },
    postFallback: null,
  }

  // SSRF: block non-http(s) schemes
  if (isBlockedScheme(url)) {
    return { ...empty, errorMessage: 'blocked: non-http(s) scheme' }
  }

  // SSRF: resolve hostname and check against private IP ranges
  const blockReason = await resolveAndCheck(url)
  if (blockReason) {
    return { ...empty, errorMessage: blockReason }
  }

  // ─── Primary probe ────────────────────────────────────────────────────
  const primaryResult = await fetchWithRedirects(url, method, body, timeoutMs, followRedirects, maxRedirects)

  if (primaryResult.errorMessage) {
    return { ...empty, errorMessage: primaryResult.errorMessage }
  }

  // Run protocol detection
  const detection = detectProtocol({
    wwwAuthenticate: primaryResult.wwwAuthenticate,
    paymentRequired: primaryResult.paymentRequired,
    responseBody: primaryResult.responseBody,
  })

  const result = {
    httpStatus: primaryResult.httpStatus,
    responseTimeMs: primaryResult.responseTimeMs,
    errorMessage: null,
    finalUrl: primaryResult.finalUrl,
    redirectCount: primaryResult.redirectCount,
    methodUsed: method,
    wwwAuthenticate: primaryResult.wwwAuthenticate,
    paymentRequired: primaryResult.paymentRequired,
    responseBody: primaryResult.responseBody,
    detection,
    postFallback: null,
  }

  // ─── POST fallback ────────────────────────────────────────────────────
  // Only try POST if: postFallback enabled, original method is GET,
  // and status is 405/400/200 (not 402, not 5xx)
  const shouldTryPost = postFallback &&
    method === 'GET' &&
    [405, 400, 200].includes(primaryResult.httpStatus)

  if (shouldTryPost) {
    const postResult = await fetchWithRedirects(url, 'POST', body, timeoutMs, followRedirects, maxRedirects)

    const postDetection = postResult.errorMessage
      ? { protocol: null, valid: false, degradeReason: null, details: {}, rawHeaders: {} }
      : detectProtocol({
          wwwAuthenticate: postResult.wwwAuthenticate,
          paymentRequired: postResult.paymentRequired,
          responseBody: postResult.responseBody,
        })

    result.postFallback = {
      attempted: true,
      httpStatus: postResult.httpStatus,
      detection: postDetection,
    }

    // If POST yielded 402 + valid protocol detection, promote it
    if (postResult.httpStatus === 402 && postDetection.valid) {
      result.httpStatus = postResult.httpStatus
      result.responseTimeMs = postResult.responseTimeMs
      result.methodUsed = 'POST'
      result.wwwAuthenticate = postResult.wwwAuthenticate
      result.paymentRequired = postResult.paymentRequired
      result.responseBody = postResult.responseBody
      result.detection = postDetection
    }
  }

  return result
}

/**
 * Fetch a URL with optional redirect following, SSRF checks on each hop,
 * and HEAD-then-GET fallback for GET method.
 */
async function fetchWithRedirects(startUrl, method, body, timeoutMs, followRedirects, maxRedirects) {
  let currentUrl = startUrl
  let redirectCount = 0

  for (let hop = 0; hop <= maxRedirects; hop++) {
    // SSRF check on redirect hops (first hop already checked by caller)
    if (hop > 0) {
      if (isBlockedScheme(currentUrl)) {
        return { errorMessage: 'blocked: redirect to non-http(s) scheme' }
      }
      const blockReason = await resolveAndCheck(currentUrl)
      if (blockReason) {
        return { errorMessage: blockReason }
      }
    }

    let result
    try {
      result = await doFetch(currentUrl, method, body, timeoutMs)
    } catch (err) {
      const errorMessage = (err.name === 'TimeoutError' || err.code === 'ABORT_ERR')
        ? 'timeout'
        : err.message
      return { errorMessage, httpStatus: null, responseTimeMs: null, finalUrl: currentUrl, redirectCount, wwwAuthenticate: null, paymentRequired: null, responseBody: null }
    }

    // Handle redirects
    if (followRedirects && [301, 302, 307, 308].includes(result.httpStatus)) {
      const location = result.headers.get('location')
      if (!location) {
        return { errorMessage: `Redirect ${result.httpStatus} with no Location header`, httpStatus: result.httpStatus, responseTimeMs: result.responseTimeMs, finalUrl: currentUrl, redirectCount, wwwAuthenticate: null, paymentRequired: null, responseBody: null }
      }
      try {
        currentUrl = new URL(location, currentUrl).href
      } catch {
        return { errorMessage: `Invalid redirect Location: ${location}`, httpStatus: result.httpStatus, responseTimeMs: result.responseTimeMs, finalUrl: currentUrl, redirectCount, wwwAuthenticate: null, paymentRequired: null, responseBody: null }
      }
      redirectCount++

      if (hop === maxRedirects) {
        return { errorMessage: `Too many redirects (>${maxRedirects})`, httpStatus: result.httpStatus, responseTimeMs: result.responseTimeMs, finalUrl: currentUrl, redirectCount, wwwAuthenticate: null, paymentRequired: null, responseBody: null }
      }
      continue
    }

    // Non-redirect response — extract headers + optional body
    const wwwAuthenticate = result.headers.get('www-authenticate')
    const paymentRequired = result.headers.get('payment-required')

    // Capture response body for x402 V1 parsing (only on GET with 402 and no payment-required header)
    let responseBody = null
    if (result.httpStatus === 402 && !paymentRequired && result.hasBody) {
      try {
        responseBody = await result.text()
        if (responseBody.length > MAX_BODY_SIZE) responseBody = null
      } catch {
        responseBody = null
      }
    }

    return {
      httpStatus: result.httpStatus,
      responseTimeMs: result.responseTimeMs,
      errorMessage: null,
      finalUrl: currentUrl,
      redirectCount,
      wwwAuthenticate,
      paymentRequired,
      responseBody,
    }
  }

  return { errorMessage: 'Unexpected state in redirect loop' }
}

/**
 * Execute a single HTTP fetch. For GET method, tries HEAD first;
 * falls back to GET if HEAD doesn't return 402.
 */
async function doFetch(url, method, body, timeoutMs) {
  const baseHeaders = { 'ngrok-skip-browser-warning': 'true' }

  if (method === 'POST') {
    const start = Date.now()
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...baseHeaders, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    })
    return {
      httpStatus: res.status,
      responseTimeMs: Date.now() - start,
      headers: res.headers,
      text: () => res.text(),
      hasBody: true,
    }
  }

  // GET method: try HEAD first
  const startHead = Date.now()
  const headRes = await fetch(url, {
    method: 'HEAD',
    headers: baseHeaders,
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'manual',
  })

  // If HEAD returns 402 or a redirect, use it directly
  if (headRes.status === 402 || [301, 302, 307, 308].includes(headRes.status)) {
    return {
      httpStatus: headRes.status,
      responseTimeMs: Date.now() - startHead,
      headers: headRes.headers,
      text: () => headRes.text(),
      hasBody: false, // HEAD responses have no body
    }
  }

  // HEAD didn't return 402 — fallback to GET
  const startGet = Date.now()
  const getRes = await fetch(url, {
    method: 'GET',
    headers: baseHeaders,
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'manual',
  })

  return {
    httpStatus: getRes.status,
    responseTimeMs: Date.now() - startGet,
    headers: getRes.headers,
    text: () => getRes.text(),
    hasBody: true,
  }
}
