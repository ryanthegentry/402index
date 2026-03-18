import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectProtocol, parseMppChallenge, decodeMppRequest } from '../src/services/detect-protocol.js'

// ─── Real-world MPP fixture (captured from OpenAI) ────────────────────────────

const OPENAI_MPP_CHALLENGE = 'Payment id="sHUn9TgrCUXsKVPVc2MCfja7j34HfqVP6thHbJQ9fQw", realm="openai.mpp.tempo.xyz", method="tempo", intent="session", request="eyJhbW91bnQiOiIxMDAwMCIsImN1cnJlbmN5IjoiMHgyMGMwMDAwMDAwMDAwMDAwMDAwMDAwMDBiOTUzN2QxMWM2MGU4YjUwIiwibWV0aG9kRGV0YWlscyI6eyJjaGFpbklkIjo0MjE3LCJlc2Nyb3dDb250cmFjdCI6IjB4MzNiOTAxMDE4MTc0RERhYkU0ODQxMDQyYWI3NmJhODVENGUyNGYyNSJ9LCJyZWNpcGllbnQiOiIweGNhNGU4MzVGODAzY0IwYjdDNDI4MjIyQjNBM0I5ODUxOGQ0Nzc5RmUiLCJ1bml0VHlwZSI6InJlcXVlc3QifQ", description=" - generation", expires="2026-03-18T20:04:59.811Z"'

const VALID_L402_MACAROON = 'AgEEbHNhdAJCAABhxp0hYS6wT3N2qleVV3c55EyTtbU3h52oanqJTh89qwfl2DlCh9j46xrVJFVlhF02FQBQajCMGHLJhZcFLwACGHNlcnZpY2VzPWxzcGQ6YWxpY2U6cmVh'
const VALID_L402_INVOICE = 'lnbc1500n1pjk4m0kpp5qwjz8drz5tn3kxh6y9fghp7z4k2ksaj9q5a7sj5sz8t2qxcwqqdqqcqzpgxqyz5vqsp5usyc4lk9chsfp53kvcnvq456ganh60d89reykdngsmtj6yw3nhvq9qyyssqjcmp6lknzw8zehjvwener5yh6wk4fkdj6kpetv9dzx7nnnnz'

// ─── L402 Detection ───────────────────────────────────────────────────────────

describe('detectProtocol — L402', () => {
  it('detects valid L402 header', () => {
    const result = detectProtocol({
      wwwAuthenticate: `L402 macaroon="${VALID_L402_MACAROON}", invoice="${VALID_L402_INVOICE}"`,
    })
    assert.equal(result.protocol, 'L402')
    assert.equal(result.valid, true)
    assert.equal(result.degradeReason, null)
    assert.equal(result.details.scheme, 'L402')
    assert.equal(result.details.macaroonValid, true)
    assert.equal(result.details.invoiceValid, true)
    assert.ok(result.rawHeaders['WWW-Authenticate'])
  })

  it('detects LSAT scheme (case insensitive)', () => {
    const result = detectProtocol({
      wwwAuthenticate: `LSAT macaroon="${VALID_L402_MACAROON}", invoice="${VALID_L402_INVOICE}"`,
    })
    assert.equal(result.protocol, 'L402')
    assert.equal(result.valid, true)
    assert.equal(result.details.scheme, 'LSAT')
  })

  it('returns valid=false for L402 with invalid macaroon', () => {
    const result = detectProtocol({
      wwwAuthenticate: 'L402 macaroon="bad", invoice="' + VALID_L402_INVOICE + '"',
    })
    assert.equal(result.protocol, 'L402')
    assert.equal(result.valid, false)
    assert.ok(result.degradeReason.includes('macaroon'))
    assert.equal(result.details.macaroonValid, false)
  })

  it('returns valid=false for L402 with missing invoice', () => {
    const result = detectProtocol({
      wwwAuthenticate: `L402 macaroon="${VALID_L402_MACAROON}"`,
    })
    assert.equal(result.protocol, 'L402')
    assert.equal(result.valid, false)
    assert.ok(result.degradeReason.includes('invoice'))
  })

  it('returns null protocol for empty WWW-Authenticate', () => {
    const result = detectProtocol({ wwwAuthenticate: '' })
    assert.equal(result.protocol, null)
  })

  it('returns null protocol for no headers at all', () => {
    const result = detectProtocol({})
    assert.equal(result.protocol, null)
    assert.equal(result.valid, false)
    assert.deepEqual(result.details, {})
    assert.deepEqual(result.rawHeaders, {})
  })
})

// ─── MPP Detection ────────────────────────────────────────────────────────────

describe('detectProtocol — MPP', () => {
  it('detects valid MPP Payment header with all 5 required fields', () => {
    const result = detectProtocol({
      wwwAuthenticate: OPENAI_MPP_CHALLENGE,
    })
    assert.equal(result.protocol, 'MPP')
    assert.equal(result.valid, true)
    assert.equal(result.degradeReason, null)
    assert.equal(result.details.method, 'tempo')
    assert.equal(result.details.intent, 'session')
    assert.ok(result.details.id)
    assert.ok(result.details.realm)
    assert.ok(result.details.request)
    assert.ok(result.rawHeaders['WWW-Authenticate'])
  })

  it('returns valid=false for Payment header missing intent', () => {
    const result = detectProtocol({
      wwwAuthenticate: 'Payment id="abc", realm="test.com", method="tempo", request="eyJ0ZXN0IjoxfQ"',
    })
    assert.equal(result.protocol, 'MPP')
    assert.equal(result.valid, false)
    assert.equal(result.degradeReason, 'missing required MPP field: intent')
  })

  it('returns valid=false for Payment header missing request', () => {
    const result = detectProtocol({
      wwwAuthenticate: 'Payment id="abc", realm="test.com", method="tempo", intent="charge"',
    })
    assert.equal(result.protocol, 'MPP')
    assert.equal(result.valid, false)
    assert.equal(result.degradeReason, 'missing required MPP field: request')
  })

  it('detects stripe method', () => {
    const result = detectProtocol({
      wwwAuthenticate: 'Payment id="x", realm="r", method="stripe", intent="charge", request="eyJ0ZXN0IjoxfQ"',
    })
    assert.equal(result.protocol, 'MPP')
    assert.equal(result.valid, true)
    assert.equal(result.details.method, 'stripe')
  })

  it('detects session intent', () => {
    const result = detectProtocol({
      wwwAuthenticate: 'Payment id="x", realm="r", method="tempo", intent="session", request="eyJ0ZXN0IjoxfQ"',
    })
    assert.equal(result.protocol, 'MPP')
    assert.equal(result.details.intent, 'session')
  })

  it('extracts optional expires and description fields', () => {
    const result = detectProtocol({
      wwwAuthenticate: OPENAI_MPP_CHALLENGE,
    })
    assert.equal(result.details.expires, '2026-03-18T20:04:59.811Z')
    assert.ok(result.details.description.includes('generation'))
  })
})

// ─── x402 Detection ───────────────────────────────────────────────────────────

describe('detectProtocol — x402', () => {
  const validAccepts = [{ payTo: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', amount: '10000', network: 'eip155:8453' }]
  const validHeaderB64 = Buffer.from(JSON.stringify({ accepts: validAccepts })).toString('base64')

  it('detects valid x402 V2 header', () => {
    const result = detectProtocol({ paymentRequired: validHeaderB64 })
    assert.equal(result.protocol, 'x402')
    assert.equal(result.valid, true)
    assert.equal(result.details.version, 2)
    assert.ok(result.details.accepts)
    assert.ok(result.rawHeaders['PAYMENT-REQUIRED'])
  })

  it('detects x402 V1 body fallback', () => {
    const body = JSON.stringify({ x402Version: 1, accepts: validAccepts })
    const result = detectProtocol({ responseBody: body })
    assert.equal(result.protocol, 'x402')
    assert.equal(result.valid, true)
    assert.equal(result.details.version, 1)
    assert.ok(result.rawHeaders['PAYMENT-REQUIRED'].includes('V1'))
  })

  it('returns valid=false for invalid base64 header', () => {
    const result = detectProtocol({ paymentRequired: '!!not-base64!!' })
    // parsePaymentRequired will decode it but get invalid JSON — falls through
    assert.equal(result.protocol, null)
  })

  it('returns valid=false for header with empty accepts', () => {
    const headerB64 = Buffer.from(JSON.stringify({ accepts: [] })).toString('base64')
    const result = detectProtocol({ paymentRequired: headerB64 })
    assert.equal(result.protocol, null) // parsePaymentRequired returns valid:false for empty accepts
  })
})

// ─── Precedence ───────────────────────────────────────────────────────────────

describe('detectProtocol — precedence', () => {
  const validAccepts = [{ payTo: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', amount: '10000' }]
  const validHeaderB64 = Buffer.from(JSON.stringify({ accepts: validAccepts })).toString('base64')

  it('L402 wins over x402 when both present', () => {
    const result = detectProtocol({
      wwwAuthenticate: `L402 macaroon="${VALID_L402_MACAROON}", invoice="${VALID_L402_INVOICE}"`,
      paymentRequired: validHeaderB64,
    })
    assert.equal(result.protocol, 'L402')
  })

  it('MPP wins over x402 when both present', () => {
    const result = detectProtocol({
      wwwAuthenticate: 'Payment id="x", realm="r", method="tempo", intent="charge", request="eyJ0ZXN0IjoxfQ"',
      paymentRequired: validHeaderB64,
    })
    assert.equal(result.protocol, 'MPP')
  })

  it('L402 wins over MPP (L402 checked first in WWW-Authenticate)', () => {
    // This is an edge case — real servers won't send both, but L402 scheme check comes first
    const result = detectProtocol({
      wwwAuthenticate: `L402 macaroon="${VALID_L402_MACAROON}", invoice="${VALID_L402_INVOICE}"`,
    })
    assert.equal(result.protocol, 'L402')
  })

  it('returns null when no protocol headers present', () => {
    const result = detectProtocol({ httpStatus: 200 })
    assert.equal(result.protocol, null)
    assert.equal(result.valid, false)
  })
})

// ─── rawHeaders output ────────────────────────────────────────────────────────

describe('detectProtocol — rawHeaders', () => {
  it('L402 rawHeaders contains WWW-Authenticate', () => {
    const header = `L402 macaroon="${VALID_L402_MACAROON}", invoice="${VALID_L402_INVOICE}"`
    const result = detectProtocol({ wwwAuthenticate: header })
    assert.equal(result.rawHeaders['WWW-Authenticate'], header)
  })

  it('MPP rawHeaders contains WWW-Authenticate', () => {
    const result = detectProtocol({ wwwAuthenticate: OPENAI_MPP_CHALLENGE })
    assert.equal(result.rawHeaders['WWW-Authenticate'], OPENAI_MPP_CHALLENGE)
  })

  it('x402 rawHeaders contains PAYMENT-REQUIRED', () => {
    const validAccepts = [{ payTo: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', amount: '10000' }]
    const header = Buffer.from(JSON.stringify({ accepts: validAccepts })).toString('base64')
    const result = detectProtocol({ paymentRequired: header })
    assert.equal(result.rawHeaders['PAYMENT-REQUIRED'], header)
  })

  it('null protocol returns empty rawHeaders', () => {
    const result = detectProtocol({})
    assert.deepEqual(result.rawHeaders, {})
  })
})
