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
  const macMatch = header.match(/(?:macaroon|token)="?([^",\s]+)"?/i)
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
  return /^[A-Za-z0-9+/=_.-]+$/.test(macaroon)
}

/**
 * Validate that a string looks like a BOLT11 invoice.
 * Checks prefix, minimum length (real invoices are 200+ chars), and character set.
 * @param {string|null} invoice
 * @returns {boolean}
 */
export function isValidInvoice(invoice) {
  if (!invoice) return false
  // Must start with ln prefix
  if (!/^ln(bc|tb|bcrt)/i.test(invoice)) return false
  // Must be at least 100 chars (real invoices are 200+)
  if (invoice.length < 100) return false
  // Must be valid bech32-ish (alphanumeric)
  if (!/^[a-zA-Z0-9]+$/.test(invoice)) return false
  return true
}
