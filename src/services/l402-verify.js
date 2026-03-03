import { isBlockedScheme, resolveAndCheck } from '../health/checker.js'

const TIMEOUT_MS = 10_000

/**
 * Parse the WWW-Authenticate header for L402/LSAT credentials.
 * Accepts formats like:
 *   L402 macaroon="<base64>", invoice="<bolt11>"
 *   LSAT macaroon="<base64>", invoice="<bolt11>"
 * Also handles unquoted values and various whitespace.
 *
 * @param {string|null} header - The WWW-Authenticate header value
 * @returns {{ scheme: string|null, macaroon: string|null, invoice: string|null }}
 */
export function parseWwwAuthenticate(header) {
  if (!header) return { scheme: null, macaroon: null, invoice: null }

  // Check for L402 or LSAT scheme (case-insensitive)
  const schemeMatch = header.match(/^(L402|LSAT)\b/i)
  if (!schemeMatch) return { scheme: null, macaroon: null, invoice: null }

  const scheme = schemeMatch[1].toUpperCase()

  // Extract macaroon — quoted or unquoted
  const macMatch = header.match(/macaroon="?([^",\s]+)"?/i)
  const macaroon = macMatch ? macMatch[1] : null

  // Extract invoice — quoted or unquoted
  const invMatch = header.match(/invoice="?([^",\s]+)"?/i)
  const invoice = invMatch ? invMatch[1] : null

  return { scheme, macaroon, invoice }
}

/**
 * Validate that a string looks like a base64-encoded macaroon.
 * @param {string|null} macaroon
 * @returns {boolean}
 */
export function isValidMacaroon(macaroon) {
  if (!macaroon || macaroon.length < 10) return false
  return /^[A-Za-z0-9+/=_-]+$/.test(macaroon)
}

/**
 * Validate that a string looks like a BOLT11 invoice.
 * @param {string|null} invoice
 * @returns {boolean}
 */
export function isValidInvoice(invoice) {
  if (!invoice) return false
  return /^ln(bc|tb|bcrt)/i.test(invoice)
}

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

export async function verifyL402(url) {
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
      res = await fetch(currentUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'manual',
      })
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
    const hasInvoice = isValidInvoice(invoice)

    return {
      valid: true,
      httpStatus,
      hasWwwAuthenticate: true,
      scheme,
      hasMacaroon,
      hasInvoice,
    }
  }

  return fail('Unexpected state in redirect loop')
}
