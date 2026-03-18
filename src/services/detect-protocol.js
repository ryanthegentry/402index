/**
 * Shared protocol detection for L402, x402, and MPP.
 * Single source of truth — called by both health/checker.js and probe-live.js.
 */

import { parseWwwAuthenticate, isValidMacaroon, isValidInvoice } from './l402-utils.js'
import { parsePaymentRequired, parsePaymentRequiredBody, validatePaymentRequirements } from './x402-utils.js'

/**
 * Parse the WWW-Authenticate header for MPP Payment scheme.
 * @param {string|null} wwwAuth - The WWW-Authenticate header value
 * @returns {object|null} Parsed fields, or null if not a Payment challenge
 */
export function parseMppChallenge(wwwAuth) {
  if (!wwwAuth || !wwwAuth.startsWith('Payment ')) return null

  const extract = (key) => {
    const m = wwwAuth.match(new RegExp(`\\b${key}="([^"]*)"`, 'i'))
    return m ? m[1] : null
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
    const padded = requestB64 + '='.repeat((4 - requestB64.length % 4) % 4)
    return JSON.parse(Buffer.from(padded, 'base64url').toString())
  } catch {
    return null
  }
}

const MPP_REQUIRED_FIELDS = ['id', 'realm', 'method', 'intent', 'request']

/**
 * Detect and validate the payment protocol from an HTTP probe result.
 *
 * Detection precedence:
 * 1. WWW-Authenticate L402/LSAT → L402
 * 2. WWW-Authenticate Payment → MPP
 * 3. PAYMENT-REQUIRED header → x402 V2
 * 4. Response body → x402 V1
 * 5. None → { protocol: null }
 *
 * @param {object} httpResult - { httpStatus, wwwAuthenticate, paymentRequired, responseBody, errorMessage, responseTimeMs }
 * @returns {{ protocol: string|null, valid: boolean, degradeReason: string|null, details: object, rawHeaders: object }}
 */
export function detectProtocol(httpResult) {
  const { wwwAuthenticate, paymentRequired, responseBody } = httpResult

  // 1. L402/LSAT detection
  if (wwwAuthenticate) {
    const parsed = parseWwwAuthenticate(wwwAuthenticate)
    if (parsed.scheme && /L402|LSAT/i.test(parsed.scheme)) {
      const macaroonValid = isValidMacaroon(parsed.macaroon)
      const invoiceValid = isValidInvoice(parsed.invoice)
      const valid = macaroonValid && invoiceValid

      return {
        protocol: 'L402',
        valid,
        degradeReason: valid ? null
          : !macaroonValid ? 'invalid macaroon'
          : 'invalid invoice',
        details: {
          scheme: parsed.scheme,
          macaroon: parsed.macaroon,
          macaroonValid,
          invoice: parsed.invoice,
          invoiceValid,
        },
        rawHeaders: { 'WWW-Authenticate': wwwAuthenticate },
      }
    }

    // 2. MPP detection (also uses WWW-Authenticate)
    const mpp = parseMppChallenge(wwwAuthenticate)
    if (mpp) {
      const missingField = MPP_REQUIRED_FIELDS.find(f => !mpp[f])
      const valid = !missingField

      return {
        protocol: 'MPP',
        valid,
        degradeReason: valid ? null : `missing required MPP field: ${missingField}`,
        details: mpp,
        rawHeaders: { 'WWW-Authenticate': wwwAuthenticate },
      }
    }
  }

  // 3. x402 V2 header
  const headerParsed = parsePaymentRequired(paymentRequired)
  if (headerParsed.valid) {
    const validation = validatePaymentRequirements(headerParsed.accepts)
    return {
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
    }
  }

  // 4. x402 V1 body fallback
  if (responseBody) {
    const bodyParsed = parsePaymentRequiredBody(responseBody)
    if (bodyParsed.valid) {
      const validation = validatePaymentRequirements(bodyParsed.accepts)
      return {
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
      }
    }
  }

  // 5. Nothing detected
  return { protocol: null, valid: false, degradeReason: null, details: {}, rawHeaders: {} }
}
