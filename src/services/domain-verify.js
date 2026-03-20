import { randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import db from '../db.js'
import { isBlockedScheme, resolveAndCheck } from '../health/checker.js'

const TOKEN_BYTES = 32
const CLAIM_EXPIRY_HOURS = 72
const MAX_RESPONSE_BYTES = 1024
const VERIFY_TIMEOUT_MS = 5000

// Lazy-initialized prepared statements
const stmts = {}
function stmt(key, sql) {
  if (!stmts[key]) stmts[key] = db.prepare(sql)
  return stmts[key]
}

/**
 * Constant-time token comparison to prevent timing attacks.
 */
function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

const MAX_LENGTHS = { name: 200, description: 2000, category: 100, payment_asset: 50, payment_network: 50 }
const EDITABLE_FIELDS = ['name', 'description', 'category', 'price_usd', 'price_sats', 'payment_asset', 'payment_network']

/**
 * Validate domain format — hostname only, no protocol/path/port/IP.
 * @returns {string|null} Error message or null if valid
 */
export function validateDomain(domain) {
  if (!domain || typeof domain !== 'string' || !domain.trim()) {
    return 'domain is required'
  }

  const trimmed = domain.trim().toLowerCase()

  if (trimmed.includes('://')) {
    return 'domain must not include protocol (use "api.example.com" not "https://api.example.com")'
  }
  if (trimmed.includes('/')) {
    return 'domain must not include path'
  }
  if (trimmed.includes(':')) {
    return 'domain must not include port'
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(trimmed)) {
    return 'domain must not be an IP address'
  }
  if (trimmed.includes('[') || trimmed.includes(']')) {
    return 'domain must not be an IP address'
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/.test(trimmed)) {
    return 'invalid domain format'
  }

  return null
}

/**
 * Initiate a domain claim — generates verification token and stores pending claim.
 */
export function initiateClaim(domain, contactEmail) {
  const error = validateDomain(domain)
  if (error) return { error, status: 400 }

  const normalizedDomain = domain.trim().toLowerCase()

  const existing = stmt('getClaimByDomain',
    'SELECT * FROM domain_claims WHERE domain = ?'
  ).get(normalizedDomain)

  if (existing && existing.status === 'verified') {
    return { error: 'Domain already verified', status: 409 }
  }

  const token = randomBytes(TOKEN_BYTES).toString('hex')
  const expiresAt = new Date(Date.now() + CLAIM_EXPIRY_HOURS * 60 * 60 * 1000)
    .toISOString().replace('T', ' ').slice(0, 19)

  const data = {
    domain: normalizedDomain,
    verification_token: token,
    verification_url: `https://${normalizedDomain}/.well-known/402index-verify.txt`,
    instructions: `Place a text file at the URL above containing only this token: ${token}`,
  }

  if (existing && existing.status === 'pending') {
    stmt('updatePendingClaim',
      "UPDATE domain_claims SET verification_token = ?, expires_at = ?, contact_email = ?, claimed_at = datetime('now') WHERE domain = ? AND status = 'pending'"
    ).run(token, expiresAt, contactEmail || null, normalizedDomain)
    return { status: 200, data }
  }

  // Expired or revoked claims get replaced
  if (existing && (existing.status === 'expired' || existing.status === 'revoked')) {
    stmt('replaceExpiredOrRevokedClaim',
      "UPDATE domain_claims SET verification_token = ?, status = 'pending', expires_at = ?, contact_email = ?, claimed_at = datetime('now'), verified_at = NULL WHERE domain = ? AND status IN ('expired', 'revoked')"
    ).run(token, expiresAt, contactEmail || null, normalizedDomain)
    return { status: 201, data }
  }

  // New claim
  stmt('insertClaim',
    'INSERT INTO domain_claims (id, domain, verification_token, status, expires_at, contact_email) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(randomUUID(), normalizedDomain, token, 'pending', expiresAt, contactEmail || null)

  return { status: 201, data }
}

/**
 * Verify a pending domain claim by fetching the well-known file.
 * @param {string} domain
 * @param {object} [opts]
 * @param {Function} [opts.fetchFn] — override fetch for testing
 */
export async function verifyClaim(domain, { fetchFn = fetch } = {}) {
  const error = validateDomain(domain)
  if (error) return { error, status: 400 }

  const normalizedDomain = domain.trim().toLowerCase()

  const claim = stmt('getClaimByDomain',
    'SELECT * FROM domain_claims WHERE domain = ?'
  ).get(normalizedDomain)

  if (!claim) {
    return { error: 'No claim found for this domain', status: 404 }
  }

  if (claim.status === 'verified') {
    return { error: 'Domain already verified', status: 409 }
  }

  // Check expiration for pending claims
  if (claim.status === 'pending') {
    const expiresAt = new Date(claim.expires_at + 'Z')
    if (expiresAt < new Date()) {
      stmt('expireClaim',
        "UPDATE domain_claims SET status = 'expired' WHERE id = ?"
      ).run(claim.id)
      return { error: 'Claim has expired. Please initiate a new claim.', status: 410 }
    }
  }

  if (claim.status === 'expired') {
    return { error: 'Claim has expired. Please initiate a new claim.', status: 410 }
  }

  const verifyUrl = `https://${normalizedDomain}/.well-known/402index-verify.txt`

  // SSRF protection — block non-http(s) schemes and private IPs
  if (isBlockedScheme(verifyUrl)) {
    return { error: 'Blocked URL scheme', status: 422 }
  }

  const blockReason = await resolveAndCheck(verifyUrl)
  if (blockReason) {
    return { error: `SSRF protection: ${blockReason}`, status: 422 }
  }

  // Update last check timestamp
  stmt('updateLastCheck',
    "UPDATE domain_claims SET last_check_at = datetime('now') WHERE id = ?"
  ).run(claim.id)

  // Fetch the verification file
  let response
  try {
    response = await fetchFn(verifyUrl, {
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      redirect: 'manual',
      headers: { 'User-Agent': '402index-verifier/1.0' },
    })
  } catch (err) {
    const msg = (err.name === 'TimeoutError' || err.code === 'ABORT_ERR')
      ? 'Connection timed out'
      : `Connection failed: ${err.message}`
    return { error: msg, status: 422 }
  }

  // Reject redirects — prevents cross-domain verification attacks
  if (response.status >= 300 && response.status < 400) {
    return { error: 'Verification URL returned a redirect. The file must be served directly from the domain, not via redirect.', status: 422 }
  }

  if (response.status !== 200) {
    return { error: `Verification URL returned HTTP ${response.status}`, status: 422 }
  }

  // Pre-check Content-Length if available to avoid reading oversized responses into memory.
  // Note: streaming responses without Content-Length still fall through to the post-read check.
  const contentLength = response.headers?.get?.('content-length')
  if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
    return { error: 'Verification file exceeds maximum size of 1KB', status: 422 }
  }

  // Read response body with size limit
  let body
  try {
    body = await response.text()
  } catch (err) {
    return { error: `Failed to read verification file: ${err.message}`, status: 422 }
  }

  if (body.length > MAX_RESPONSE_BYTES) {
    return { error: 'Verification file exceeds maximum size of 1KB', status: 422 }
  }

  // Compare token — constant-time comparison to prevent timing attacks
  const receivedToken = body.trim()
  if (!tokensMatch(receivedToken, claim.verification_token)) {
    return { error: 'Token mismatch. The verification file content does not match the expected token.', status: 422 }
  }

  // Mark as verified (atomic — single UPDATE with status guard)
  stmt('verifyClaim',
    "UPDATE domain_claims SET status = 'verified', verified_at = datetime('now') WHERE id = ? AND status = 'pending'"
  ).run(claim.id)

  // Count services under this domain
  const serviceCount = db.prepare(
    "SELECT COUNT(*) as c FROM services WHERE url LIKE ? AND (status = 'active' OR status IS NULL)"
  ).get(`%://${normalizedDomain}/%`).c

  return {
    status: 200,
    data: {
      domain: normalizedDomain,
      status: 'verified',
      services_count: serviceCount,
    },
  }
}

/**
 * Edit a service listing using domain verification credentials.
 */
export function editService(serviceId, { domain, verification_token, ...updates }) {
  if (!domain || !verification_token) {
    return { error: 'domain and verification_token are required', status: 400 }
  }

  const normalizedDomain = (typeof domain === 'string' ? domain : '').trim().toLowerCase()

  // Look up verified claim
  const claim = stmt('getVerifiedClaim',
    "SELECT * FROM domain_claims WHERE domain = ? AND status = 'verified'"
  ).get(normalizedDomain)

  if (!claim) {
    return { error: 'No verified claim for this domain', status: 403 }
  }

  // Verify token — constant-time comparison
  if (!tokensMatch(claim.verification_token, verification_token)) {
    return { error: 'Invalid verification token', status: 403 }
  }

  // Look up service
  const service = db.prepare('SELECT * FROM services WHERE id = ?').get(serviceId)
  if (!service) {
    return { error: 'Service not found', status: 404 }
  }

  // Verify domain match — service URL hostname must equal claimed domain
  let serviceHostname
  try {
    serviceHostname = new URL(service.url).hostname
  } catch {
    return { error: 'Service URL is malformed', status: 500 }
  }

  if (serviceHostname !== normalizedDomain) {
    return { error: 'Service URL hostname does not match claimed domain', status: 403 }
  }

  // Validate and collect updates
  const fieldsToUpdate = {}
  for (const field of EDITABLE_FIELDS) {
    if (updates[field] !== undefined) {
      if (MAX_LENGTHS[field] && String(updates[field]).length > MAX_LENGTHS[field]) {
        return { error: `${field} exceeds maximum length of ${MAX_LENGTHS[field]} characters`, status: 400 }
      }
      fieldsToUpdate[field] = updates[field]
    }
  }

  // Numeric validation for price fields
  if (fieldsToUpdate.price_usd !== undefined) {
    if (typeof fieldsToUpdate.price_usd !== 'number' || !Number.isFinite(fieldsToUpdate.price_usd)) {
      return { error: 'price_usd must be a number', status: 400 }
    }
    if (fieldsToUpdate.price_usd < 0) {
      return { error: 'price_usd must be non-negative', status: 400 }
    }
  }
  if (fieldsToUpdate.price_sats !== undefined) {
    if (typeof fieldsToUpdate.price_sats !== 'number' || !Number.isFinite(fieldsToUpdate.price_sats)) {
      return { error: 'price_sats must be a number', status: 400 }
    }
    if (fieldsToUpdate.price_sats < 0) {
      return { error: 'price_sats must be non-negative', status: 400 }
    }
    if (!Number.isInteger(fieldsToUpdate.price_sats)) {
      return { error: 'price_sats must be an integer', status: 400 }
    }
  }

  if (Object.keys(fieldsToUpdate).length === 0) {
    return { error: 'No valid fields to update', status: 400 }
  }

  // Build and execute UPDATE
  const setClauses = Object.keys(fieldsToUpdate).map(f => `${f} = @${f}`)
  setClauses.push("updated_at = datetime('now')")

  db.prepare(`UPDATE services SET ${setClauses.join(', ')} WHERE id = @id`)
    .run({ ...fieldsToUpdate, id: serviceId })

  // Return updated service
  const updated = db.prepare('SELECT * FROM services WHERE id = ?').get(serviceId)

  return { status: 200, data: updated }
}

/**
 * Revoke a verified domain claim. Requires the current token to authorize.
 */
export function revokeClaim(domain, verificationToken) {
  if (!domain || !verificationToken) {
    return { error: 'domain and verification_token are required', status: 400 }
  }

  const error = validateDomain(domain)
  if (error) return { error, status: 400 }

  const normalizedDomain = domain.trim().toLowerCase()

  const claim = stmt('getClaimByDomain',
    'SELECT * FROM domain_claims WHERE domain = ?'
  ).get(normalizedDomain)

  if (!claim) {
    return { error: 'No claim found for this domain', status: 404 }
  }

  if (claim.status !== 'verified') {
    return { error: 'No verified claim for this domain', status: 403 }
  }

  // Constant-time token comparison
  if (!tokensMatch(claim.verification_token, verificationToken)) {
    return { error: 'Invalid verification token', status: 403 }
  }

  stmt('revokeClaim',
    "UPDATE domain_claims SET status = 'revoked' WHERE domain = ? AND status = 'verified'"
  ).run(normalizedDomain)

  return {
    status: 200,
    data: {
      domain: normalizedDomain,
      status: 'revoked',
      message: 'Domain claim revoked. Initiate a new claim to re-verify.',
    },
  }
}
