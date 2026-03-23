import { decode as decodeBolt11 } from 'light-bolt11-decoder'

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

// ─── V2 TLV / V1 Binary Macaroon Parsing ─────────────────────────────────────

/**
 * Read a varint (unsigned LEB128) from a buffer at offset.
 * @param {Buffer} buf
 * @param {number} offset
 * @returns {{ value: number, bytesRead: number }}
 */
function readVarint(buf, offset) {
  let value = 0
  let shift = 0
  let bytesRead = 0
  const maxBytes = 5 // varints for values up to 2^35 need at most 5 bytes
  while (offset + bytesRead < buf.length && bytesRead < maxBytes) {
    const byte = buf[offset + bytesRead]
    bytesRead++
    value |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) break
    shift += 7
  }
  return { value: value >>> 0, bytesRead } // >>> 0 ensures unsigned 32-bit
}

/**
 * Validate the inner L402 identifier structure (66 bytes: version 0 + payment_hash + token_id).
 */
function validateL402Identifier(identifier, caveats) {
  if (identifier.length < 66) {
    return { compliant: false, reason: 'identifier too short (need 66 bytes for L402)' }
  }
  const version = identifier.readUInt16BE(0)
  if (version !== 0) {
    return { compliant: false, reason: 'unsupported identifier version' }
  }
  return {
    compliant: true,
    paymentHash: Buffer.from(identifier.subarray(2, 34)),
    tokenId: Buffer.from(identifier.subarray(34, 66)),
    caveats,
  }
}

/**
 * Parse V2 TLV macaroon envelope and extract the L402 identifier.
 * Field types: 0x00=EOS, 0x01=location, 0x02=identifier/caveat-id, 0x04=vid, 0x06=signature
 */
function parseV2TLV(buf) {
  let i = 1 // skip version marker byte (0x02)
  let identifier = null
  const caveats = []

  while (i < buf.length) {
    const tag = buf[i]

    if (tag === 0x00) {
      i++ // EOS marker (bare byte, no data)
      continue
    }

    i++ // move past tag byte
    if (i >= buf.length) break

    const { value: len, bytesRead } = readVarint(buf, i)
    i += bytesRead
    if (i + len > buf.length) break // truncated — use what we found

    const data = buf.subarray(i, i + len)
    i += len

    if (tag === 0x02) {
      if (!identifier) {
        identifier = data // first 0x02 field = macaroon identifier
      } else {
        caveats.push(data.toString('utf8')) // subsequent = caveat ids
      }
    }
    // tags 0x01 (location), 0x04 (vid), 0x06 (signature) are skipped
  }

  if (!identifier) {
    return { compliant: false, reason: 'no identifier found in V2 TLV structure' }
  }

  return validateL402Identifier(identifier, caveats)
}

/**
 * Parse V1 binary macaroon: uint32 BE version (=1) + varint(id_len) + id bytes.
 */
function parseV1Binary(buf) {
  if (buf.length < 8) {
    return { compliant: false, reason: 'too short for V1 binary macaroon' }
  }
  let i = 4 // skip uint32 version
  const { value: idLen, bytesRead } = readVarint(buf, i)
  i += bytesRead
  if (i + idLen > buf.length) {
    return { compliant: false, reason: 'truncated V1 macaroon identifier' }
  }
  const identifier = buf.subarray(i, i + idLen)
  return validateL402Identifier(identifier, [])
}

// ─── Exported Functions ──────────────────────────────────────────────────────

/**
 * Check if a base64-encoded macaroon has a spec-compliant binary structure
 * with a valid 66-byte L402 identifier (version 0 + payment_hash + token_id).
 * Checks V2 TLV and V1 binary formats. Does NOT validate cryptographic signatures.
 *
 * @param {string} macaroonB64
 * @returns {{ compliant: boolean, reason?: string, paymentHash?: Buffer, tokenId?: Buffer, caveats?: string[] }}
 */
export function isSpecCompliantMacaroon(macaroonB64) {
  if (!macaroonB64 || typeof macaroonB64 !== 'string' || macaroonB64.length < 4) {
    return { compliant: false, reason: 'empty or invalid input' }
  }

  if (!/^[A-Za-z0-9+/=_-]+$/.test(macaroonB64)) {
    return { compliant: false, reason: 'invalid base64 encoding' }
  }

  let buf
  try {
    buf = Buffer.from(macaroonB64, 'base64')
  } catch {
    return { compliant: false, reason: 'invalid base64 encoding' }
  }

  if (buf.length < 3) {
    return { compliant: false, reason: 'decoded data too short' }
  }

  // Detect JSON format (llm402.ai style — base64-encoded JSON object)
  if (buf[0] === 0x7B) {
    return { compliant: false, reason: 'JSON-encoded macaroon (non-standard — spec requires binary V2 TLV, see github.com/lightninglabs/L402)' }
  }

  // Try V2 TLV (first byte = 0x02 version marker)
  if (buf[0] === 0x02) {
    return parseV2TLV(buf)
  }

  // Try V1 binary (first 4 bytes = uint32 BE value 1)
  if (buf.length >= 4 && buf.readUInt32BE(0) === 1) {
    return parseV1Binary(buf)
  }

  // Detect V0 libmacaroons text serialization
  // Format: 4-hex-digit length prefix + packet tag (location/identifier/cid/signature)
  if (buf.length >= 8) {
    const first4 = buf.subarray(0, 4).toString('ascii')
    if (/^[0-9a-f]{4}$/.test(first4)) {
      const rest = buf.subarray(4).toString('ascii', 0, 20)
      if (/^(location|identifier|cid|signature)\s/.test(rest)) {
        return {
          compliant: false,
          reason: 'libmacaroons v0 text format (spec requires binary V2 TLV — see github.com/lightninglabs/L402)',
        }
      }
    }
  }

  return { compliant: false, reason: 'unrecognized macaroon format (spec requires binary V2 TLV — see github.com/lightninglabs/L402)' }
}

/**
 * Extract payment hash from a BOLT11 invoice.
 * Returns null on decode failure (graceful degradation).
 *
 * @param {string} invoice
 * @returns {Buffer|null} 32-byte payment hash or null
 */
export function extractInvoicePaymentHash(invoice) {
  if (!invoice || typeof invoice !== 'string') return null
  try {
    const decoded = decodeBolt11(invoice)
    const section = decoded.sections.find(s => s.name === 'payment_hash')
    if (!section || !section.value) return null
    return Buffer.from(section.value, 'hex')
  } catch {
    return null
  }
}

/**
 * Full L402 challenge validation: structural compliance + payment hash cross-check.
 *
 * @param {string} macaroonB64
 * @param {string} invoiceStr
 * @returns {{ valid: boolean, specCompliant: boolean, paymentHashMatch: boolean|null, degradeReason: string|null }}
 */
export function validateL402Challenge(macaroonB64, invoiceStr) {
  const valid = isValidMacaroon(macaroonB64) && isValidInvoice(invoiceStr)

  const compliance = isSpecCompliantMacaroon(macaroonB64)
  if (!compliance.compliant) {
    return {
      valid,
      specCompliant: false,
      paymentHashMatch: null,
      degradeReason: compliance.reason || 'non-standard macaroon format',
    }
  }

  // Try payment hash cross-validation
  const invoiceHash = extractInvoicePaymentHash(invoiceStr)
  if (!invoiceHash) {
    return { valid, specCompliant: true, paymentHashMatch: null, degradeReason: null }
  }

  const paymentHashMatch = compliance.paymentHash.equals(invoiceHash)
  return {
    valid,
    specCompliant: true,
    paymentHashMatch,
    degradeReason: paymentHashMatch ? null : 'payment hash mismatch between macaroon and invoice',
  }
}
