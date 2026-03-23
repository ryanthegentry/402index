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
import { detectProtocol } from '../src/services/detect-protocol.js'

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

// ─── isSpecCompliantMacaroon — Identifier Validation ─────────────────────────

describe('isSpecCompliantMacaroon — identifier validation', () => {
  it('valid V2 TLV macaroon with 66-byte identifier → compliant', () => {
    const result = isSpecCompliantMacaroon(SPEC_MACAROON)
    assert.equal(result.compliant, true)
    assert.ok(result.paymentHash)
    assert.equal(result.paymentHash.toString('hex'), VALID_BOLT11_PAYMENT_HASH)
  })

  it('JSON macaroon (llm402.ai style) → non-compliant', () => {
    const result = isSpecCompliantMacaroon(JSON_MACAROON)
    assert.equal(result.compliant, false)
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
  })

  it('V2 with caveats → compliant + caveats extracted', () => {
    const mac = buildV2Macaroon(MATCHING_ID, VALID_SIGNATURE, {
      caveats: ['services=lspd:alice:read', 'expiry=2026-01-01']
    })
    const result = isSpecCompliantMacaroon(mac)
    assert.equal(result.compliant, true)
    assert.ok(result.caveats)
    assert.ok(result.caveats.length >= 2)
    assert.ok(result.caveats.includes('services=lspd:alice:read'))
  })

  it('V1 format with valid 66-byte identifier → compliant (V1 fallback)', () => {
    const result = isSpecCompliantMacaroon(V1_VALID_MACAROON)
    assert.equal(result.compliant, true)
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
    assert.equal(result.protocol, 'L402')
    assert.equal(result.valid, true)
    assert.equal(result.details.specCompliant, true)
  })

  it('non-compliant macaroon → specCompliant=false + degradeReason set', () => {
    const result = detectProtocol({
      wwwAuthenticate: `L402 macaroon="${JSON_MACAROON}", invoice="${VALID_BOLT11}"`,
    })
    assert.equal(result.protocol, 'L402')
    assert.equal(result.valid, true) // charset check still passes
    assert.equal(result.details.specCompliant, false)
    assert.ok(result.degradeReason)
  })

  it('spec-compliant macaroon + undecodable invoice → paymentHashMatch=null', () => {
    const result = detectProtocol({
      wwwAuthenticate: `L402 macaroon="${SPEC_MACAROON}", invoice="${UNDECODABLE_INVOICE}"`,
    })
    assert.equal(result.protocol, 'L402')
    assert.equal(result.details.specCompliant, true)
    assert.equal(result.details.paymentHashMatch, null)
  })
})

// ─── Health Checker — L402 Spec Compliance Degradation ───────────────────────

describe('Health checker — L402 spec compliance degradation', () => {
  // Simulate checkService's L402 compliance logic without HTTP layer
  function simulateHealthCheck(wwwAuthHeader) {
    const detection = detectProtocol({ wwwAuthenticate: wwwAuthHeader })
    const classification = { healthStatus: 'healthy', checkStatus: 'healthy' }

    // Replicate checkService L402 compliance check (existing + new specCompliant check)
    if (detection.protocol === 'L402' && classification.healthStatus === 'healthy') {
      if (!detection.valid) {
        classification.healthStatus = 'degraded'
        classification.checkStatus = 'degraded'
      } else if (detection.details?.specCompliant === false) {
        classification.healthStatus = 'degraded'
        classification.checkStatus = 'degraded'
        classification.degradeReason = detection.degradeReason || 'non-standard L402 macaroon format'
      } else if (detection.details?.paymentHashMatch === false) {
        classification.healthStatus = 'degraded'
        classification.checkStatus = 'degraded'
        classification.degradeReason = detection.degradeReason || 'payment hash mismatch'
      }
    }

    return classification
  }

  it('non-compliant macaroon → health degraded', () => {
    const result = simulateHealthCheck(
      `L402 macaroon="${JSON_MACAROON}", invoice="${VALID_BOLT11}"`
    )
    assert.equal(result.healthStatus, 'degraded')
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
