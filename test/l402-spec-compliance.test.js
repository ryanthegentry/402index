/**
 * L402 Spec Compliance Validation Tests
 *
 * Tests cover:
 *   isSpecCompliantMacaroon()  — V2 TLV + V1 binary identifier validation
 *   extractInvoicePaymentHash() — BOLT11 payment hash extraction
 *   validateL402Challenge()    — cross-validation of macaroon + invoice payment hashes
 *   detectProtocol integration — specCompliant field in detection results
 *   Health checker integration — degradation for non-compliant L402 endpoints
 *
 * Run: node --test test/l402-spec-compliance.test.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isSpecCompliantMacaroon, validateL402Challenge, extractInvoicePaymentHash } from '../src/services/l402-utils.js'
import { detectProtocol, getPrimaryDetection } from '../src/services/detect-protocol.js'

// ─── Fixture Helpers ─────────────────────────────────────────────────────────

function writeVarint(value) {
  const bytes = []
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80)
    value >>>= 7
  }
  bytes.push(value & 0x7f)
  return Buffer.from(bytes)
}

function buildL402Identifier(paymentHash, tokenId, version = 0) {
  const id = Buffer.alloc(66)
  id.writeUInt16BE(version, 0)
  paymentHash.copy(id, 2)
  tokenId.copy(id, 34)
  return id
}

/**
 * Build a minimal V2 TLV macaroon (binary).
 * Format: 0x02 (version) [location] 0x02 varint(id_len) <id> 0x00 (EOS) [caveats] 0x06 varint(sig_len) <sig> 0x00 (EOM)
 */
function buildV2Macaroon(identifier, signature, opts = {}) {
  const parts = []
  parts.push(Buffer.from([0x02])) // V2 version marker
  if (opts.location) {
    const loc = Buffer.from(opts.location, 'utf8')
    parts.push(Buffer.from([0x01]))
    parts.push(writeVarint(loc.length))
    parts.push(loc)
  }
  parts.push(Buffer.from([0x02])) // identifier field type
  parts.push(writeVarint(identifier.length))
  parts.push(identifier)
  parts.push(Buffer.from([0x00])) // end of section
  if (opts.caveats) {
    for (const cav of opts.caveats) {
      const cavBuf = Buffer.from(cav, 'utf8')
      parts.push(Buffer.from([0x02])) // caveat id field
      parts.push(writeVarint(cavBuf.length))
      parts.push(cavBuf)
      parts.push(Buffer.from([0x00])) // end of caveat section
    }
  }
  parts.push(Buffer.from([0x06])) // signature field type
  if (opts.sigLength !== undefined) {
    // Allow overriding signature length for malformed tests
    parts.push(writeVarint(opts.sigLength))
    parts.push(signature.subarray(0, opts.sigLength))
  } else {
    parts.push(writeVarint(signature.length))
    parts.push(signature)
  }
  parts.push(Buffer.from([0x00])) // end of macaroon
  return Buffer.concat(parts).toString('base64')
}

/**
 * Build a V1 binary macaroon.
 * Format: uint32 BE version (=1) + varint(id_len) + identifier + signature
 */
function buildV1Macaroon(identifier, signature) {
  const parts = []
  const version = Buffer.alloc(4)
  version.writeUInt32BE(1, 0)
  parts.push(version)
  parts.push(writeVarint(identifier.length))
  parts.push(identifier)
  parts.push(signature)
  return Buffer.concat(parts).toString('base64')
}

// ─── Test Fixtures ───────────────────────────────────────────────────────────

// Valid BOLT11 invoice from light-bolt11-decoder test suite
const VALID_BOLT11 = 'lnbc20u1p3y0x3hpp5743k2g0fsqqxj7n8qzuhns5gmkk4djeejk3wkp64ppevgekvc0jsdqcve5kzar2v9nr5gpqd4hkuetesp5ez2g297jduwc20t6lmqlsg3man0vf2jfd8ar9fh8fhn2g8yttfkqxqy9gcqcqzys9qrsgqrzjqtx3k77yrrav9hye7zar2rtqlfkytl094dsp0ms5majzth6gt7ca6uhdkxl983uywgqqqqlgqqqvx5qqjqrzjqd98kxkpyw0l9tyy8r8q57k7zpy9zjmh6sez752wj6gcumqnj3yxzhdsmg6qq56utgqqqqqqqqqqqeqqjq7jd56882gtxhrjm03c93aacyfy306m4fq0tskf83c0nmet8zc2lxyyg3saz8x6vwcp26xnrlagf9semau3qm2glysp7sv95693fphvsp54l567'
const VALID_BOLT11_PAYMENT_HASH = 'f5636521e98000697a6700b979c288ddad56cb3995a2eb07550872c466ccc3e5'

// Undecodable invoice (truncated, invalid checksum)
const UNDECODABLE_INVOICE = 'lnbc1500n1pjk4m0kpp5qwjz8drz5tn3kxh6y9fghp7z4k2ksaj9q5a7sj5sz8t2qxcwqqdqqcqzpgxqyz5vqsp5usyc4lk9chsfp53kvcnvq456ganh60d89reykdngsmtj6yw3nhvq9qyyssqjcmp6lknzw8zehjvwener5yh6wk4fkdj6kpetv9dzx7nnnnz'

const MATCHING_PAYMENT_HASH = Buffer.from(VALID_BOLT11_PAYMENT_HASH, 'hex')
const DIFFERENT_PAYMENT_HASH = Buffer.alloc(32, 0xFF)
const TOKEN_ID = Buffer.alloc(32, 0x42)
const VALID_SIGNATURE = Buffer.alloc(32, 0xAA)

// Spec-compliant macaroon with matching payment hash
const MATCHING_ID = buildL402Identifier(MATCHING_PAYMENT_HASH, TOKEN_ID)
const SPEC_MACAROON = buildV2Macaroon(MATCHING_ID, VALID_SIGNATURE)

// Spec-compliant macaroon with DIFFERENT payment hash
const MISMATCHED_ID = buildL402Identifier(DIFFERENT_PAYMENT_HASH, TOKEN_ID)
const MISMATCHED_MACAROON = buildV2Macaroon(MISMATCHED_ID, VALID_SIGNATURE)

// llm402.ai-style JSON macaroon (non-compliant)
const JSON_MACAROON = Buffer.from(JSON.stringify({
  id: 'abc123', caveats: ['payment_hash = deadbeef'], sig: 'cafebabe'
})).toString('base64')

// Short identifier (not 66 bytes)
const SHORT_ID = Buffer.alloc(10, 0xFF)
const SHORT_ID_MACAROON = buildV2Macaroon(SHORT_ID, VALID_SIGNATURE)

// Wrong L402 version (1 instead of 0)
const WRONG_VERSION_ID = buildL402Identifier(MATCHING_PAYMENT_HASH, TOKEN_ID, 1)
const WRONG_VERSION_MACAROON = buildV2Macaroon(WRONG_VERSION_ID, VALID_SIGNATURE)

// Random valid 66-byte identifier with version 0
const RANDOM_VALID_ID = Buffer.alloc(66)
RANDOM_VALID_ID.writeUInt16BE(0, 0)
for (let i = 2; i < 66; i++) RANDOM_VALID_ID[i] = (i * 37 + 13) & 0xFF // deterministic "random"
const RANDOM_VALID_MACAROON = buildV2Macaroon(RANDOM_VALID_ID, VALID_SIGNATURE)

// V1 format macaroons
const V1_VALID_MACAROON = buildV1Macaroon(MATCHING_ID, VALID_SIGNATURE)
const V1_WRONG_VERSION_ID = buildL402Identifier(MATCHING_PAYMENT_HASH, TOKEN_ID, 1)
const V1_WRONG_VERSION_MAC = buildV1Macaroon(V1_WRONG_VERSION_ID, VALID_SIGNATURE)

// Neither V1 nor V2 (starts with 0x05, not 0x02 or uint32 BE=1)
const NEITHER_MACAROON = Buffer.from([0x05, 0x01, 0x02, 0x03, ...Array(62).fill(0)]).toString('base64')

// Truly unknown format (starts with 0xFF — not JSON, V0, V2, or V1)
const TRULY_UNKNOWN_MACAROON = Buffer.from([0xFF, 0xFE, 0x00, ...Array(30).fill(0x42)]).toString('base64')

/**
 * Build a V0 libmacaroons text-format macaroon.
 * Format: each line is `NNNNfield value\n` where NNNN is 4-hex-digit packet length.
 */
function buildV0TextMacaroon({ location, identifier, caveats = [], signature }) {
  const lines = []

  function addPacket(tag, value) {
    const content = `${tag} ${value}\n`
    const len = (content.length + 4).toString(16).padStart(4, '0')
    lines.push(`${len}${content}`)
  }

  addPacket('location', location || 'test-location')
  addPacket('identifier', identifier || 'test-id')
  for (const c of caveats) {
    addPacket('cid', c)
  }

  // Signature packet
  const sigContent = `signature ${signature || 'A'.repeat(32)}\n`
  const sigLen = (sigContent.length + 4).toString(16).padStart(4, '0')
  lines.push(`${sigLen}${sigContent}`)

  return Buffer.from(lines.join('')).toString('base64')
}

// V0 text format macaroons
const V0_BASIC = buildV0TextMacaroon({ location: '0/receipt/1', identifier: 'id11503id' })
const V0_WITH_CAVEATS = buildV0TextMacaroon({
  location: 'test-host',
  identifier: 'abc123',
  caveats: ['service = my-service', 'expires = 1774279339'],
})
const V0_WITH_URL = buildV0TextMacaroon({
  location: 'https://api.lightningenable.com',
  identifier: 'token-xyz',
})

// ─── isSpecCompliantMacaroon — Identifier Validation ─────────────────────────

describe('isSpecCompliantMacaroon — identifier validation', () => {
  it('valid V2 TLV macaroon with 66-byte identifier → compliant', () => {
    const result = isSpecCompliantMacaroon(SPEC_MACAROON)
    assert.equal(result.compliant, true)
    assert.equal(result.format, 'v2_tlv')
    assert.ok(result.paymentHash)
    assert.equal(result.paymentHash.toString('hex'), VALID_BOLT11_PAYMENT_HASH)
  })

  it('JSON macaroon (llm402.ai style) → non-compliant', () => {
    const result = isSpecCompliantMacaroon(JSON_MACAROON)
    assert.equal(result.compliant, false)
    assert.equal(result.format, 'json')
    assert.ok(result.reason.toLowerCase().includes('json'))
  })

  it('too-short identifier → non-compliant', () => {
    const result = isSpecCompliantMacaroon(SHORT_ID_MACAROON)
    assert.equal(result.compliant, false)
    assert.ok(result.reason.includes('short'))
  })

  it('wrong identifier version (1 instead of 0) → non-compliant', () => {
    const result = isSpecCompliantMacaroon(WRONG_VERSION_MACAROON)
    assert.equal(result.compliant, false)
    assert.ok(result.reason.includes('version'))
  })

  it('non-base64 string → non-compliant', () => {
    const result = isSpecCompliantMacaroon('!!!not-base64!!!')
    assert.equal(result.compliant, false)
    assert.ok(result.reason.includes('base64'))
  })

  it('random 66 bytes with version 0 in V2 TLV → compliant', () => {
    const result = isSpecCompliantMacaroon(RANDOM_VALID_MACAROON)
    assert.equal(result.compliant, true)
  })

  it('null input → non-compliant', () => {
    const result = isSpecCompliantMacaroon(null)
    assert.equal(result.compliant, false)
  })

  it('empty string → non-compliant', () => {
    const result = isSpecCompliantMacaroon('')
    assert.equal(result.compliant, false)
  })
})

// ─── isSpecCompliantMacaroon — V2/V1 Envelope ───────────────────────────────

describe('isSpecCompliantMacaroon — V2/V1 envelope', () => {
  it('V2 with location field → compliant', () => {
    const mac = buildV2Macaroon(MATCHING_ID, VALID_SIGNATURE, { location: 'lsat' })
    const result = isSpecCompliantMacaroon(mac)
    assert.equal(result.compliant, true)
    assert.equal(result.format, 'v2_tlv')
  })

  it('V2 with caveats → compliant + caveats extracted', () => {
    const mac = buildV2Macaroon(MATCHING_ID, VALID_SIGNATURE, {
      caveats: ['services=lspd:alice:read', 'expiry=2026-01-01']
    })
    const result = isSpecCompliantMacaroon(mac)
    assert.equal(result.compliant, true)
    assert.equal(result.format, 'v2_tlv')
    assert.ok(result.caveats)
    assert.ok(result.caveats.length >= 2)
    assert.ok(result.caveats.includes('services=lspd:alice:read'))
  })

  it('V1 format with valid 66-byte identifier → compliant (V1 fallback)', () => {
    const result = isSpecCompliantMacaroon(V1_VALID_MACAROON)
    assert.equal(result.compliant, true)
    assert.equal(result.format, 'v1_binary')
    assert.equal(result.paymentHash.toString('hex'), VALID_BOLT11_PAYMENT_HASH)
  })

  it('V1 format with wrong inner L402 version → non-compliant', () => {
    const result = isSpecCompliantMacaroon(V1_WRONG_VERSION_MAC)
    assert.equal(result.compliant, false)
    assert.ok(result.reason.includes('version'))
  })

  it('raw bytes that are neither V1 nor V2 → non-compliant', () => {
    const result = isSpecCompliantMacaroon(NEITHER_MACAROON)
    assert.equal(result.compliant, false)
  })

  it('existing VALID_L402_MACAROON fixture → compliant (truncated but valid identifier)', () => {
    // This is the macaroon from detect-protocol.test.js — V2 TLV, truncated after identifier+caveat
    const existing = 'AgEEbHNhdAJCAABhxp0hYS6wT3N2qleVV3c55EyTtbU3h52oanqJTh89qwfl2DlCh9j46xrVJFVlhF02FQBQajCMGHLJhZcFLwACGHNlcnZpY2VzPWxzcGQ6YWxpY2U6cmVh'
    const result = isSpecCompliantMacaroon(existing)
    assert.equal(result.compliant, true)
    assert.equal(result.paymentHash.toString('hex'), '61c69d21612eb04f7376aa5795577739e44c93b5b537879da86a7a894e1f3dab')
  })
})

// ─── extractInvoicePaymentHash ───────────────────────────────────────────────

describe('extractInvoicePaymentHash', () => {
  it('valid BOLT11 invoice → returns 32-byte payment hash', () => {
    const hash = extractInvoicePaymentHash(VALID_BOLT11)
    assert.ok(hash)
    assert.equal(hash.toString('hex'), VALID_BOLT11_PAYMENT_HASH)
  })

  it('undecodable invoice → returns null (graceful degradation)', () => {
    const hash = extractInvoicePaymentHash(UNDECODABLE_INVOICE)
    assert.equal(hash, null)
  })

  it('null input → returns null', () => {
    const hash = extractInvoicePaymentHash(null)
    assert.equal(hash, null)
  })

  it('empty string → returns null', () => {
    const hash = extractInvoicePaymentHash('')
    assert.equal(hash, null)
  })
})

// ─── validateL402Challenge — Payment Hash Cross-Validation ───────────────────

describe('validateL402Challenge — payment hash cross-validation', () => {
  it('matching payment hashes → valid + specCompliant + paymentHashMatch', () => {
    const result = validateL402Challenge(SPEC_MACAROON, VALID_BOLT11)
    assert.equal(result.valid, true)
    assert.equal(result.specCompliant, true)
    assert.equal(result.paymentHashMatch, true)
  })

  it('mismatched payment hashes → valid + specCompliant + paymentHashMatch=false', () => {
    const result = validateL402Challenge(MISMATCHED_MACAROON, VALID_BOLT11)
    assert.equal(result.valid, true)
    assert.equal(result.specCompliant, true)
    assert.equal(result.paymentHashMatch, false)
    assert.ok(result.degradeReason)
    assert.ok(result.degradeReason.includes('mismatch'))
  })

  it('non-compliant macaroon + valid invoice → valid + specCompliant=false', () => {
    const result = validateL402Challenge(JSON_MACAROON, VALID_BOLT11)
    assert.equal(result.valid, true) // base64 charset check still passes
    assert.equal(result.specCompliant, false)
    assert.ok(result.degradeReason)
  })

  it('valid macaroon + undecodable invoice → graceful degradation (paymentHashMatch=null)', () => {
    const result = validateL402Challenge(SPEC_MACAROON, UNDECODABLE_INVOICE)
    assert.equal(result.valid, true)
    assert.equal(result.specCompliant, true)
    assert.equal(result.paymentHashMatch, null)
  })
})

// ─── detectProtocol — L402 Spec Compliance Integration ───────────────────────

describe('detectProtocol — L402 spec compliance integration', () => {
  it('spec-compliant L402 → specCompliant=true in details', () => {
    const result = detectProtocol({
      wwwAuthenticate: `L402 macaroon="${SPEC_MACAROON}", invoice="${VALID_BOLT11}"`,
    })
    assert.equal(result[0].protocol, 'L402')
    assert.equal(result[0].valid, true)
    assert.equal(result[0].details.specCompliant, true)
    assert.equal(result[0].details.format, 'v2_tlv')
  })

  it('non-compliant macaroon → specCompliant=false + degradeReason set', () => {
    const result = detectProtocol({
      wwwAuthenticate: `L402 macaroon="${JSON_MACAROON}", invoice="${VALID_BOLT11}"`,
    })
    assert.equal(result[0].protocol, 'L402')
    assert.equal(result[0].valid, true) // charset check still passes
    assert.equal(result[0].details.specCompliant, false)
    assert.equal(result[0].details.format, 'json')
    assert.ok(result[0].degradeReason)
  })

  it('spec-compliant macaroon + undecodable invoice → paymentHashMatch=null', () => {
    const result = detectProtocol({
      wwwAuthenticate: `L402 macaroon="${SPEC_MACAROON}", invoice="${UNDECODABLE_INVOICE}"`,
    })
    assert.equal(result[0].protocol, 'L402')
    assert.equal(result[0].details.specCompliant, true)
    assert.equal(result[0].details.paymentHashMatch, null)
  })
})

// ─── Health Checker — L402 Spec Compliance Degradation ───────────────────────

describe('Health checker — L402 format relaxation (BLIP-0026)', () => {
  // Simulate checkService's relaxed L402 logic without HTTP layer
  // Per BLIP-0026: format is metadata, only payment hash mismatch degrades
  function simulateHealthCheck(wwwAuthHeader) {
    const detections = detectProtocol({ wwwAuthenticate: wwwAuthHeader })
    const detection = getPrimaryDetection(detections, 'L402')
    const classification = { healthStatus: 'healthy', checkStatus: 'healthy' }

    if (detection.protocol === 'L402' && classification.healthStatus === 'healthy') {
      if (!detection.valid) {
        classification.healthStatus = 'degraded'
        classification.checkStatus = 'degraded'
      } else if (detection.details?.paymentHashMatch === false) {
        classification.healthStatus = 'degraded'
        classification.checkStatus = 'degraded'
        classification.degradeReason = detection.degradeReason || 'payment hash mismatch'
      }
    }

    return classification
  }

  it('non-compliant macaroon format → healthy (format is metadata)', () => {
    const result = simulateHealthCheck(
      `L402 macaroon="${JSON_MACAROON}", invoice="${VALID_BOLT11}"`
    )
    assert.equal(result.healthStatus, 'healthy')
  })

  it('spec-compliant macaroon + matching hash → healthy', () => {
    const result = simulateHealthCheck(
      `L402 macaroon="${SPEC_MACAROON}", invoice="${VALID_BOLT11}"`
    )
    assert.equal(result.healthStatus, 'healthy')
  })

  it('spec-compliant macaroon + mismatched hash → health degraded', () => {
    const result = simulateHealthCheck(
      `L402 macaroon="${MISMATCHED_MACAROON}", invoice="${VALID_BOLT11}"`
    )
    assert.equal(result.healthStatus, 'degraded')
  })
})

// ─── Health Checker — POST Fallback Does Not Override Spec Compliance ────────

describe('Health checker — POST fallback with relaxed format rules', () => {
  // Extended simulation: primary GET → classify → L402 validation → POST fallback
  // Per BLIP-0026: format is metadata, only payment hash mismatch degrades
  function simulateWithPostFallback({ primaryHttpStatus, primaryDetection, postFallbackDetection, protocol = 'L402' }) {
    const { classifyHealthStatus } = await_classifyHealthStatus()

    const classification = classifyHealthStatus(primaryHttpStatus, null, 0, null, 200)

    // Relaxed: only degrade for invalid detection or payment hash mismatch
    if ((protocol === 'L402' || protocol === 'MPP') && primaryHttpStatus === 402 && classification.healthStatus === 'healthy') {
      if (!primaryDetection.valid) {
        classification.healthStatus = 'degraded'
        classification.checkStatus = 'degraded'
      } else if (protocol === 'L402' && primaryDetection.details?.paymentHashMatch === false) {
        classification.healthStatus = 'degraded'
        classification.checkStatus = 'degraded'
        classification.degradeReason = primaryDetection.degradeReason || 'payment hash mismatch'
      }
    }

    // Relaxed POST fallback: only payment hash mismatch degrades
    // postFallbackDetection is now an array from detectProtocol()
    const postPrimary = postFallbackDetection ? getPrimaryDetection(postFallbackDetection, protocol) : null
    if (postPrimary?.valid) {
      const postDetails = postPrimary.details
      if (protocol === 'L402' && postDetails?.paymentHashMatch === false) {
        classification.healthStatus = 'degraded'
        classification.checkStatus = 'degraded'
        classification.degradeReason = postPrimary.degradeReason || 'payment hash mismatch between macaroon and invoice'
      } else {
        classification.healthStatus = 'healthy'
        classification.checkStatus = 'healthy'
        classification.consecutiveFailures = 0
      }
    }

    return classification
  }

  function await_classifyHealthStatus() {
    return {
      classifyHealthStatus(httpStatus, errorMessage, prevFailures, historicalP50, responseTimeMs) {
        if (errorMessage) {
          const newFailures = (prevFailures || 0) + 1
          return { healthStatus: newFailures >= 3 ? 'down' : 'unknown', checkStatus: errorMessage === 'timeout' ? 'timeout' : 'error', consecutiveFailures: newFailures }
        }
        if (httpStatus === 402) {
          if (historicalP50 && responseTimeMs > historicalP50 * 2) {
            return { healthStatus: 'degraded', checkStatus: 'degraded', consecutiveFailures: 0 }
          }
          return { healthStatus: 'healthy', checkStatus: 'healthy', consecutiveFailures: 0 }
        }
        if (httpStatus === 405) {
          return { healthStatus: 'degraded', checkStatus: 'method_not_allowed', consecutiveFailures: prevFailures || 0 }
        }
        return { healthStatus: 'degraded', checkStatus: 'degraded', consecutiveFailures: prevFailures || 0 }
      }
    }
  }

  it('POST fallback with non-compliant macaroon format → healthy (format is metadata)', () => {
    // Scenario: GET returns 405, POST returns 402 with JSON macaroon
    // Per BLIP-0026 relaxation: format doesn't degrade health
    const postDetection = detectProtocol({
      wwwAuthenticate: `L402 macaroon="${JSON_MACAROON}", invoice="${VALID_BOLT11}"`,
    })

    const result = simulateWithPostFallback({
      primaryHttpStatus: 405,
      primaryDetection: { valid: false, details: {} },
      postFallbackDetection: postDetection,
    })

    assert.equal(result.healthStatus, 'healthy', 'non-compliant format via POST should be healthy')
  })

  it('POST fallback with compliant macaroon → healthy', () => {
    // Scenario: GET returns 405, POST returns 402 with spec-compliant macaroon
    const postDetection = detectProtocol({
      wwwAuthenticate: `L402 macaroon="${SPEC_MACAROON}", invoice="${VALID_BOLT11}"`,
    })

    const result = simulateWithPostFallback({
      primaryHttpStatus: 405,
      primaryDetection: { valid: false, details: {} },
      postFallbackDetection: postDetection,
    })

    assert.equal(result.healthStatus, 'healthy', 'compliant L402 via POST should be promoted to healthy')
  })

  it('POST fallback with compliant macaroon but payment hash mismatch → degraded', () => {
    // Scenario: GET returns 405, POST returns 402 with spec-compliant but mismatched hash
    const postDetection = detectProtocol({
      wwwAuthenticate: `L402 macaroon="${MISMATCHED_MACAROON}", invoice="${VALID_BOLT11}"`,
    })

    const result = simulateWithPostFallback({
      primaryHttpStatus: 405,
      primaryDetection: { valid: false, details: {} },
      postFallbackDetection: postDetection,
    })

    assert.equal(result.healthStatus, 'degraded', 'payment hash mismatch via POST should stay degraded')
  })
})

// ─── Varint Overflow Guard ───────────────────────────────────────────────────

describe('readVarint overflow protection', () => {
  it('macaroon with excessive varint continuation bytes → non-compliant (not a crash)', () => {
    // Build a malicious V2 TLV macaroon where identifier length varint has 10+ continuation bytes
    // Each byte has MSB set (0x80 | value), causing the parser to keep reading
    const parts = []
    parts.push(Buffer.from([0x02])) // V2 version marker
    parts.push(Buffer.from([0x02])) // identifier field type
    // 10 continuation bytes (all with MSB set) — exceeds the 5-byte limit
    parts.push(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80]))
    // terminator byte (no MSB)
    parts.push(Buffer.from([0x01]))
    // Some dummy data
    parts.push(Buffer.alloc(100, 0x42))
    const malicious = Buffer.concat(parts).toString('base64')

    const result = isSpecCompliantMacaroon(malicious)
    // Must NOT crash, hang, or produce garbage — just non-compliant
    assert.equal(result.compliant, false)
  })

  it('macaroon with 5-byte varint (max valid) → parses correctly', () => {
    // Build a V2 TLV macaroon with a varint requiring exactly 5 bytes
    // Value = 2^28 = 268435456 (needs 5 varint bytes)
    // varint encoding of 268435456: 0x80, 0x80, 0x80, 0x80, 0x10
    const parts = []
    parts.push(Buffer.from([0x02])) // V2 version marker
    parts.push(Buffer.from([0x02])) // identifier field type
    // 5-byte varint for length 268435456 — this is way too large for actual data,
    // so the identifier will be "truncated" and fail the 66-byte check
    parts.push(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x10]))
    // Not enough data for this varint length → truncated
    parts.push(Buffer.alloc(100, 0x42))
    const edgeCase = Buffer.concat(parts).toString('base64')

    const result = isSpecCompliantMacaroon(edgeCase)
    // Should not crash — just return non-compliant due to truncation
    assert.equal(result.compliant, false)
  })
})

// ─── V0 Libmacaroons Text Format Detection ──────────────────────────────────

describe('V0 libmacaroons text format detection', () => {
  it('V0 text macaroon → detected with specific V0 reason (not "unrecognized")', () => {
    const result = isSpecCompliantMacaroon(V0_BASIC)
    assert.equal(result.compliant, false)
    assert.equal(result.format, 'v0_text')
    assert.ok(result.reason.includes('v0'), `expected reason to mention "v0", got: ${result.reason}`)
    assert.ok(!result.reason.includes('unrecognized'), `should NOT say "unrecognized", got: ${result.reason}`)
  })

  it('V0 text with caveats → still detected as V0', () => {
    const result = isSpecCompliantMacaroon(V0_WITH_CAVEATS)
    assert.equal(result.compliant, false)
    assert.equal(result.format, 'v0_text')
    assert.ok(result.reason.includes('v0'), `expected V0-specific reason, got: ${result.reason}`)
  })

  it('V0 text with full URL location → detected as V0', () => {
    const result = isSpecCompliantMacaroon(V0_WITH_URL)
    assert.equal(result.compliant, false)
    assert.equal(result.format, 'v0_text')
    assert.ok(result.reason.includes('v0'), `expected V0-specific reason, got: ${result.reason}`)
  })

  it('buffer starting with 0x30 but NOT valid V0 text → falls through to unrecognized', () => {
    // 0x30 = ASCII "0", but followed by random non-hex bytes — should NOT match V0
    const buf = Buffer.from([0x30, 0xFF, 0x00, 0x42, ...Array(30).fill(0x99)])
    const b64 = buf.toString('base64')
    const result = isSpecCompliantMacaroon(b64)
    assert.equal(result.compliant, false)
    assert.equal(result.format, 'unknown')
    assert.ok(!result.reason.includes('v0'), `should NOT classify random 0x30 data as V0, got: ${result.reason}`)
  })
})

// ─── Actionable Degrade Reasons ─────────────────────────────────────────────

describe('Actionable degrade reasons', () => {
  it('JSON macaroon reason includes spec link', () => {
    const result = isSpecCompliantMacaroon(JSON_MACAROON)
    assert.equal(result.compliant, false)
    assert.equal(result.format, 'json')
    assert.ok(result.reason.includes('macaroon-spec.md'), `expected spec link, got: ${result.reason}`)
    assert.ok(result.reason.includes('L402'), `expected spec link, got: ${result.reason}`)
  })

  it('V2 TLV with short identifier → reason mentions "66 bytes"', () => {
    const result = isSpecCompliantMacaroon(SHORT_ID_MACAROON)
    assert.equal(result.compliant, false)
    assert.ok(result.reason.includes('66'), `expected mention of 66 bytes, got: ${result.reason}`)
  })

  it('V1 binary with wrong version → reason mentions "version"', () => {
    const result = isSpecCompliantMacaroon(V1_WRONG_VERSION_MAC)
    assert.equal(result.compliant, false)
    assert.ok(result.reason.includes('version'), `expected mention of version, got: ${result.reason}`)
  })

  it('truly unknown format → unrecognized fallback with spec link', () => {
    const result = isSpecCompliantMacaroon(TRULY_UNKNOWN_MACAROON)
    assert.equal(result.compliant, false)
    assert.equal(result.format, 'unknown')
    assert.ok(result.reason.includes('unrecognized'), `expected "unrecognized", got: ${result.reason}`)
    assert.ok(result.reason.includes('macaroon-spec.md'), `expected spec guidance, got: ${result.reason}`)
  })
})

// ─── detectProtocol — V0 Text Format Integration ────────────────────────────

describe('detectProtocol — V0 text format integration', () => {
  it('V0 text macaroon in WWW-Authenticate → specCompliant=false with V0-specific reason', () => {
    const result = detectProtocol({
      wwwAuthenticate: `L402 macaroon="${V0_BASIC}", invoice="${VALID_BOLT11}"`,
    })
    assert.equal(result[0].protocol, 'L402')
    assert.equal(result[0].details.specCompliant, false)
    assert.equal(result[0].details.format, 'v0_text')
    assert.ok(result[0].degradeReason.includes('v0'), `expected V0-specific degrade reason, got: ${result[0].degradeReason}`)
  })
})
