import { isBlockedScheme, resolveAndCheck } from '../health/checker.js'
import { parseWwwAuthenticate, isValidMacaroon, isValidInvoice } from './l402-utils.js'

// Re-export for backward compatibility
export { parseWwwAuthenticate, isValidMacaroon, isValidInvoice }

const TIMEOUT_MS = 10_000

/**
 * Probe a URL to verify it's L402-compliant.
 *
 * @param {string} url - The endpoint URL to verify
 * @returns {Promise<{
 *   valid: boolean,
 *   httpStatus: number|null,
 *   hasWwwAuthenticate: boolean,
 *   scheme: string|null,
 *   hasMacaroon: boolean,
 *   hasInvoice: boolean,
 *   error?: string
 * }>}
 */
const MAX_REDIRECTS = 3

export async function verifyL402(url, httpMethod = 'GET', probeBody = '{}') {
  const fail = (error, overrides = {}) => ({
    valid: false,
    httpStatus: null,
    hasWwwAuthenticate: false,
    scheme: null,
    hasMacaroon: false,
    hasInvoice: false,
    error,
    ...overrides,
  })

  let currentUrl = url

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    // SSRF protection on every hop
    if (isBlockedScheme(currentUrl)) {
      return fail('URL must use http or https scheme')
    }
    const blockReason = await resolveAndCheck(currentUrl)
    if (blockReason) {
      return fail(blockReason)
    }

    let res
    try {
      const fetchOptions = {
        method: httpMethod,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'manual',
        headers: {
          // Bypass ngrok free-tier interstitial page (harmless for non-ngrok endpoints)
          'ngrok-skip-browser-warning': 'true',
        },
      }
      if (httpMethod === 'POST') {
        fetchOptions.headers['Content-Type'] = 'application/json'
        fetchOptions.body = probeBody
      }
      res = await fetch(currentUrl, fetchOptions)
    } catch (err) {
      const msg = (err.name === 'TimeoutError' || err.code === 'ABORT_ERR')
        ? 'Connection timed out after 10 seconds'
        : `Connection failed: ${err.message}`
      return fail(msg)
    }

    const httpStatus = res.status

    // Follow redirects (301, 302, 307, 308)
    if ([301, 302, 307, 308].includes(httpStatus)) {
      const location = res.headers.get('location')
      if (!location) {
        return fail(`Redirect ${httpStatus} with no Location header`, { httpStatus })
      }
      try {
        currentUrl = new URL(location, currentUrl).href
      } catch {
        return fail(`Invalid redirect Location: ${location}`, { httpStatus })
      }
      if (i === MAX_REDIRECTS) {
        return fail(`Too many redirects (>${MAX_REDIRECTS})`, { httpStatus })
      }
      continue
    }

    if (httpStatus !== 402) {
      return fail(
        `Your endpoint returned HTTP ${httpStatus} instead of 402. L402 endpoints must return 402 Payment Required for unauthenticated requests.`,
        { httpStatus }
      )
    }

    // Got 402 — check WWW-Authenticate header
    const wwwAuth = res.headers.get('www-authenticate')
    if (!wwwAuth) {
      return fail(
        'Your endpoint returned 402 but is missing the WWW-Authenticate header. L402 requires a WWW-Authenticate header with scheme L402 or LSAT.',
        { httpStatus }
      )
    }

    const { scheme, macaroon, invoice } = parseWwwAuthenticate(wwwAuth)

    if (!scheme) {
      return fail(
        `Your endpoint returned 402 with a WWW-Authenticate header, but the scheme is not L402 or LSAT. Got: "${wwwAuth.substring(0, 100)}"`,
        { httpStatus, hasWwwAuthenticate: true }
      )
    }

    const hasMacaroon = isValidMacaroon(macaroon)
    const invoiceValid = isValidInvoice(invoice)
    const hasInvoice = invoiceValid
    const invoiceLengthOk = invoiceValid

    // Gate on macaroon + invoice validity (aligned with detectProtocol)
    if (!hasMacaroon || !invoiceValid) {
      const reasons = []
      if (!hasMacaroon) {
        reasons.push(`Invalid macaroon/token: got "${(macaroon || '').substring(0, 50)}" (${macaroon ? macaroon.length : 0} chars). Must be base64-encoded, minimum 10 characters.`)
      }
      if (!invoiceValid) {
        if (!invoice) {
          reasons.push('Invoice is missing from WWW-Authenticate header.')
        } else if (!/^ln(bc|tb|bcrt)/i.test(invoice)) {
          reasons.push(`Invalid invoice prefix: got "${invoice.substring(0, 30)}". Must start with lnbc, lntb, or lnbcrt.`)
        } else if (invoice.length < 100) {
          reasons.push(`Invoice too short: got ${invoice.length} chars. BOLT11 invoices must be at least 100 characters.`)
        } else {
          reasons.push('Invalid invoice format: contains non-alphanumeric characters.')
        }
      }
      return fail(reasons.join(' '), {
        httpStatus,
        hasWwwAuthenticate: true,
        scheme,
        hasMacaroon,
        hasInvoice,
      })
    }

    return {
      valid: true,
      httpStatus,
      hasWwwAuthenticate: true,
      scheme,
      hasMacaroon: true,
      hasInvoice: true,
      invoiceValid: true,
      invoiceLengthOk: true,
    }
  }

  return fail('Unexpected state in redirect loop')
}
