/**
 * Shared protocol detection for L402, x402, and MPP.
 * Single source of truth — called by both health/checker.js and probe-live.js.
 */

import { parseWwwAuthenticate, isValidMacaroon, isValidInvoice, validateL402Challenge } from './l402-utils.js'
import { parsePaymentRequired, parsePaymentRequiredBody, validatePaymentRequirements } from './x402-utils.js'

/**
 * Parse the WWW-Authenticate header for MPP Payment scheme.
 * @param {string|null} wwwAuth - The WWW-Authenticate header value
 * @returns {object|null} Parsed fields, or null if not a Payment challenge
 */
export function parseMppChallenge(wwwAuth) {
  if (!wwwAuth || !wwwAuth.startsWith('Payment ')) return null

  const extract = (key) => {
    const m = wwwAuth.match(new RegExp(`\\b${key}="((?:[^"\\\\]|\\\\.)*)"`, 'i'))
    return m ? m[1].replace(/\\(.)/g, '$1') : null
  }

  return {
    id: extract('id'),
    realm: extract('realm'),
    method: extract('method'),
    intent: extract('intent'),
    request: extract('request'),
    expires: extract('expires'),
    description: extract('description'),
  }
}

/**
 * Decode the base64url-encoded request field from an MPP challenge.
 * @param {string} requestB64 - base64url-encoded JSON
 * @returns {object|null} Decoded JSON, or null on failure
 */
export function decodeMppRequest(requestB64) {
  try {
    return JSON.parse(Buffer.from(requestB64, 'base64url').toString())
  } catch {
    return null
  }
}

const MPP_REQUIRED_FIELDS = ['id', 'realm', 'method', 'intent', 'request']

/** Null-protocol sentinel — returned by getPrimaryDetection when no match is found */
const NULL_DETECTION = { protocol: null, valid: false, degradeReason: null, details: {}, rawHeaders: {} }

/**
 * Detect and validate all payment protocols from an HTTP probe result.
 *
 * Runs all detection checks regardless of earlier matches, collecting
 * results into an array. Each protocol appears at most once.
 *
 * @param {object} httpResult - { httpStatus, wwwAuthenticate, paymentRequired, responseBody, errorMessage, responseTimeMs }
 * @returns {Array<{ protocol: string, valid: boolean, degradeReason: string|null, details: object, rawHeaders: object }>}
 */
export function detectProtocol(httpResult) {
  const { wwwAuthenticate, paymentRequired, responseBody } = httpResult
  const results = []

  // 1. L402/LSAT detection (WWW-Authenticate)
  if (wwwAuthenticate) {
    const parsed = parseWwwAuthenticate(wwwAuthenticate)
    if (parsed.scheme && /L402|LSAT/i.test(parsed.scheme)) {
      const macaroonValid = isValidMacaroon(parsed.macaroon)
      const invoiceValid = isValidInvoice(parsed.invoice)
      const valid = macaroonValid && invoiceValid
      const validation = validateL402Challenge(parsed.macaroon, parsed.invoice)

      results.push({
        protocol: 'L402',
        valid,
        degradeReason: valid
          ? (validation.specCompliant === false ? (validation.degradeReason || 'non-standard macaroon format') : null)
          : (!macaroonValid ? 'invalid macaroon' : 'invalid invoice'),
        details: {
          scheme: parsed.scheme,
          macaroon: parsed.macaroon,
          macaroonValid,
          invoice: parsed.invoice,
          invoiceValid,
          specCompliant: validation.specCompliant,
          paymentHashMatch: validation.paymentHashMatch,
          format: validation.format || null,
        },
        rawHeaders: { 'WWW-Authenticate': wwwAuthenticate },
      })
    } else {
      // 2. MPP detection (also uses WWW-Authenticate — mutually exclusive with L402)
      const mpp = parseMppChallenge(wwwAuthenticate)
      if (mpp) {
        const missingField = MPP_REQUIRED_FIELDS.find(f => !mpp[f])
        const valid = !missingField

        results.push({
          protocol: 'MPP',
          valid,
          degradeReason: valid ? null : `missing required MPP field: ${missingField}`,
          details: mpp,
          rawHeaders: { 'WWW-Authenticate': wwwAuthenticate },
        })
      }
    }
  }

  // 3. x402 V2 header — check independently of WWW-Authenticate
  const headerParsed = parsePaymentRequired(paymentRequired)
  if (headerParsed.valid) {
    const validation = validatePaymentRequirements(headerParsed.accepts)
    results.push({
      protocol: 'x402',
      valid: validation.valid,
      degradeReason: validation.valid ? null : 'invalid payment requirements',
      details: {
        accepts: headerParsed.accepts,
        assetKnown: validation.assetKnown,
        facilitatorReachable: null,
        version: 2,
      },
      rawHeaders: { 'PAYMENT-REQUIRED': paymentRequired },
    })
  } else if (responseBody) {
    // 4. x402 V1 body fallback — only if V2 header not present (V2 takes precedence)
    const bodyParsed = parsePaymentRequiredBody(responseBody)
    if (bodyParsed.valid) {
      const validation = validatePaymentRequirements(bodyParsed.accepts)
      results.push({
        protocol: 'x402',
        valid: validation.valid,
        degradeReason: validation.valid ? null : 'invalid payment requirements',
        details: {
          accepts: bodyParsed.accepts,
          assetKnown: validation.assetKnown,
          facilitatorReachable: null,
          version: 1,
        },
        rawHeaders: { 'PAYMENT-REQUIRED': '(from response body — x402 V1)' },
      })
    }
  }

  return results
}

/**
 * Extract the detection matching a specific protocol from a detections array.
 * Returns the null-protocol sentinel when no match is found, so callers can
 * safely access .valid, .protocol, .details without null checks.
 *
 * @param {Array} detections - Array returned by detectProtocol()
 * @param {string} protocol - Protocol to find ('L402'|'x402'|'MPP')
 * @returns {{ protocol: string|null, valid: boolean, degradeReason: string|null, details: object, rawHeaders: object }}
 */
export function getPrimaryDetection(detections, protocol) {
  return detections.find(d => d.protocol === protocol) || NULL_DETECTION
}
