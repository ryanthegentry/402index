import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectProtocol, parseMppChallenge, decodeMppRequest, getPrimaryDetection } from '../src/services/detect-protocol.js'
import { isLightningEntry } from '../src/services/x402-utils.js'

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
    assert.equal(result[0].protocol, 'L402')
    assert.equal(result[0].valid, true)
    assert.equal(result[0].degradeReason, null)
    assert.equal(result[0].details.scheme, 'L402')
    assert.equal(result[0].details.macaroonValid, true)
    assert.equal(result[0].details.invoiceValid, true)
    assert.ok(result[0].rawHeaders['WWW-Authenticate'])
  })

  it('detects LSAT scheme (case insensitive)', () => {
    const result = detectProtocol({
      wwwAuthenticate: `LSAT macaroon="${VALID_L402_MACAROON}", invoice="${VALID_L402_INVOICE}"`,
    })
    assert.equal(result[0].protocol, 'L402')
    assert.equal(result[0].valid, true)
    assert.equal(result[0].details.scheme, 'LSAT')
  })

  it('returns valid=false for L402 with invalid macaroon', () => {
    const result = detectProtocol({
      wwwAuthenticate: 'L402 macaroon="bad", invoice="' + VALID_L402_INVOICE + '"',
    })
    assert.equal(result[0].protocol, 'L402')
    assert.equal(result[0].valid, false)
    assert.ok(result[0].degradeReason.includes('macaroon'))
    assert.equal(result[0].details.macaroonValid, false)
  })

  it('returns valid=false for L402 with missing invoice', () => {
    const result = detectProtocol({
      wwwAuthenticate: `L402 macaroon="${VALID_L402_MACAROON}"`,
    })
    assert.equal(result[0].protocol, 'L402')
    assert.equal(result[0].valid, false)
    assert.ok(result[0].degradeReason.includes('invoice'))
  })

  it('returns empty array for empty WWW-Authenticate', () => {
    const result = detectProtocol({ wwwAuthenticate: '' })
    assert.equal(result.length, 0)
  })

  it('returns empty array for no headers at all', () => {
    const result = detectProtocol({})
    assert.equal(result.length, 0)
  })
})

// ─── MPP Detection ────────────────────────────────────────────────────────────

describe('detectProtocol — MPP', () => {
  it('detects valid MPP Payment header with all 5 required fields', () => {
    const result = detectProtocol({
      wwwAuthenticate: OPENAI_MPP_CHALLENGE,
    })
    assert.equal(result[0].protocol, 'MPP')
    assert.equal(result[0].valid, true)
    assert.equal(result[0].degradeReason, null)
    assert.equal(result[0].details.method, 'tempo')
    assert.equal(result[0].details.intent, 'session')
    assert.ok(result[0].details.id)
    assert.ok(result[0].details.realm)
    assert.ok(result[0].details.request)
    assert.ok(result[0].rawHeaders['WWW-Authenticate'])
  })

  it('returns valid=false for Payment header missing intent', () => {
    const result = detectProtocol({
      wwwAuthenticate: 'Payment id="abc", realm="test.com", method="tempo", request="eyJ0ZXN0IjoxfQ"',
    })
    assert.equal(result[0].protocol, 'MPP')
    assert.equal(result[0].valid, false)
    assert.equal(result[0].degradeReason, 'missing required MPP field: intent')
  })

  it('returns valid=false for Payment header missing request', () => {
    const result = detectProtocol({
      wwwAuthenticate: 'Payment id="abc", realm="test.com", method="tempo", intent="charge"',
    })
    assert.equal(result[0].protocol, 'MPP')
    assert.equal(result[0].valid, false)
    assert.equal(result[0].degradeReason, 'missing required MPP field: request')
  })

  it('detects stripe method', () => {
    const result = detectProtocol({
      wwwAuthenticate: 'Payment id="x", realm="r", method="stripe", intent="charge", request="eyJ0ZXN0IjoxfQ"',
    })
    assert.equal(result[0].protocol, 'MPP')
    assert.equal(result[0].valid, true)
    assert.equal(result[0].details.method, 'stripe')
  })

  it('detects session intent', () => {
    const result = detectProtocol({
      wwwAuthenticate: 'Payment id="x", realm="r", method="tempo", intent="session", request="eyJ0ZXN0IjoxfQ"',
    })
    assert.equal(result[0].protocol, 'MPP')
    assert.equal(result[0].details.intent, 'session')
  })

  it('extracts optional expires and description fields', () => {
    const result = detectProtocol({
      wwwAuthenticate: OPENAI_MPP_CHALLENGE,
    })
    assert.equal(result[0].details.expires, '2026-03-18T20:04:59.811Z')
    assert.ok(result[0].details.description.includes('generation'))
  })
})

// ─── x402 Detection ───────────────────────────────────────────────────────────

describe('detectProtocol — x402', () => {
  const validAccepts = [{ payTo: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', amount: '10000', network: 'eip155:8453' }]
  const validHeaderB64 = Buffer.from(JSON.stringify({ accepts: validAccepts })).toString('base64')

  it('detects valid x402 V2 header', () => {
    const result = detectProtocol({ paymentRequired: validHeaderB64 })
    assert.equal(result[0].protocol, 'x402')
    assert.equal(result[0].valid, true)
    assert.equal(result[0].details.version, 2)
    assert.ok(result[0].details.accepts)
    assert.ok(result[0].rawHeaders['PAYMENT-REQUIRED'])
  })

  it('detects x402 V1 body fallback', () => {
    const body = JSON.stringify({ x402Version: 1, accepts: validAccepts })
    const result = detectProtocol({ responseBody: body })
    assert.equal(result[0].protocol, 'x402')
    assert.equal(result[0].valid, true)
    assert.equal(result[0].details.version, 1)
    assert.ok(result[0].rawHeaders['PAYMENT-REQUIRED'].includes('V1'))
  })

  it('returns empty array for invalid base64 header', () => {
    const result = detectProtocol({ paymentRequired: '!!not-base64!!' })
    assert.equal(result.length, 0)
  })

  it('returns empty array for header with empty accepts', () => {
    const headerB64 = Buffer.from(JSON.stringify({ accepts: [] })).toString('base64')
    const result = detectProtocol({ paymentRequired: headerB64 })
    assert.equal(result.length, 0)
  })

  it('x402 Lightning entry: details include paymentMethod lightning', () => {
    const VALID_BOLT11 = 'lnbc20u1p3y0x3hpp5743k2g0fsqqxj7n8qzuhns5gmkk4djeejk3wkp64ppevgekvc0jsdqcve5kzar2v9nr5gpqd4hkuetesp5ez2g297jduwc20t6lmqlsg3man0vf2jfd8ar9fh8fhn2g8yttfkqxqy9gcqcqzys9qrsgqrzjqtx3k77yrrav9hye7zar2rtqlfkytl094dsp0ms5majzth6gt7ca6uhdkxl983uywgqqqqlgqqqvx5qqjqrzjqd98kxkpyw0l9tyy8r8q57k7zpy9zjmh6sez752wj6gcumqnj3yxzhdsmg6qq56utgqqqqqqqqqqqeqqjq7jd56882gtxhrjm03c93aacyfy306m4fq0tskf83c0nmet8zc2lxyyg3saz8x6vwcp26xnrlagf9semau3qm2glysp7sv95693fphvsp54l567'
    const lightningAccepts = [{
      scheme: 'exact',
      network: 'bip122:000000000019d6689c085ae165831e93',
      amount: '13000',
      asset: 'BTC',
      payTo: 'anonymous',
      maxTimeoutSeconds: 300,
      extra: { paymentMethod: 'lightning', invoice: VALID_BOLT11 },
    }]
    const headerB64 = Buffer.from(JSON.stringify({ accepts: lightningAccepts })).toString('base64')
    const result = detectProtocol({ paymentRequired: headerB64 })
    assert.equal(result[0].protocol, 'x402')
    assert.equal(result[0].valid, true)
    assert.equal(result[0].details.paymentMethod, 'lightning')
    // Asset should be recognized
    assert.equal(result[0].details.assetKnown, true)
  })
})

// ─── Precedence ───────────────────────────────────────────────────────────────

describe('detectProtocol — precedence', () => {
  const validAccepts = [{ payTo: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', amount: '10000' }]
  const validHeaderB64 = Buffer.from(JSON.stringify({ accepts: validAccepts })).toString('base64')

  it('L402 is first when both L402 and x402 present', () => {
    const result = detectProtocol({
      wwwAuthenticate: `L402 macaroon="${VALID_L402_MACAROON}", invoice="${VALID_L402_INVOICE}"`,
      paymentRequired: validHeaderB64,
    })
    assert.equal(result[0].protocol, 'L402')
    assert.equal(result.length, 2) // both detected
  })

  it('MPP is first when both MPP and x402 present', () => {
    const result = detectProtocol({
      wwwAuthenticate: 'Payment id="x", realm="r", method="tempo", intent="charge", request="eyJ0ZXN0IjoxfQ"',
      paymentRequired: validHeaderB64,
    })
    assert.equal(result[0].protocol, 'MPP')
    assert.equal(result.length, 2) // both detected
  })

  it('L402 wins over MPP (L402 checked first in WWW-Authenticate)', () => {
    // This is an edge case — real servers won't send both, but L402 scheme check comes first
    const result = detectProtocol({
      wwwAuthenticate: `L402 macaroon="${VALID_L402_MACAROON}", invoice="${VALID_L402_INVOICE}"`,
    })
    assert.equal(result[0].protocol, 'L402')
  })

  it('returns empty array when no protocol headers present', () => {
    const result = detectProtocol({ httpStatus: 200 })
    assert.equal(result.length, 0)
  })

  it('falls through Bearer WWW-Authenticate to detect x402', () => {
    const result = detectProtocol({
      wwwAuthenticate: 'Bearer realm="api.example.com"',
      paymentRequired: validHeaderB64,
    })
    assert.equal(result[0].protocol, 'x402')
    assert.equal(result[0].valid, true)
  })

  it('falls through Basic WWW-Authenticate to detect x402', () => {
    const result = detectProtocol({
      wwwAuthenticate: 'Basic realm="api.example.com"',
      paymentRequired: validHeaderB64,
    })
    assert.equal(result[0].protocol, 'x402')
  })

  it('non-Payment non-L402 WWW-Authenticate with no x402 returns empty array', () => {
    const result = detectProtocol({
      wwwAuthenticate: 'Digest realm="api.example.com", nonce="abc123"',
    })
    assert.equal(result.length, 0)
  })

  it('MPP is first when both MPP and x402 V1 body present', () => {
    const body = JSON.stringify({ x402Version: 1, accepts: validAccepts })
    const result = detectProtocol({
      wwwAuthenticate: 'Payment id="x", realm="r", method="tempo", intent="charge", request="eyJ0ZXN0IjoxfQ"',
      responseBody: body,
    })
    assert.equal(result[0].protocol, 'MPP')
  })
})

// ─── rawHeaders output ────────────────────────────────────────────────────────

describe('detectProtocol — rawHeaders', () => {
  it('L402 rawHeaders contains WWW-Authenticate', () => {
    const header = `L402 macaroon="${VALID_L402_MACAROON}", invoice="${VALID_L402_INVOICE}"`
    const result = detectProtocol({ wwwAuthenticate: header })
    assert.equal(result[0].rawHeaders['WWW-Authenticate'], header)
  })

  it('MPP rawHeaders contains WWW-Authenticate', () => {
    const result = detectProtocol({ wwwAuthenticate: OPENAI_MPP_CHALLENGE })
    assert.equal(result[0].rawHeaders['WWW-Authenticate'], OPENAI_MPP_CHALLENGE)
  })

  it('x402 rawHeaders contains PAYMENT-REQUIRED', () => {
    const validAccepts = [{ payTo: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', amount: '10000' }]
    const header = Buffer.from(JSON.stringify({ accepts: validAccepts })).toString('base64')
    const result = detectProtocol({ paymentRequired: header })
    assert.equal(result[0].rawHeaders['PAYMENT-REQUIRED'], header)
  })

  it('no protocol returns empty array', () => {
    const result = detectProtocol({})
    assert.equal(result.length, 0)
  })
})

// ─── Multi-Protocol Detection ──────────────────────────────────────────────

describe('multi-protocol detection', () => {
  const validAccepts = [{ payTo: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', amount: '10000', network: 'eip155:8453' }]
  const validHeaderB64 = Buffer.from(JSON.stringify({ accepts: validAccepts })).toString('base64')

  it('dual L402+x402: returns 2-element array with both protocols', () => {
    const result = detectProtocol({
      wwwAuthenticate: `L402 macaroon="${VALID_L402_MACAROON}", invoice="${VALID_L402_INVOICE}"`,
      paymentRequired: validHeaderB64,
    })
    assert.ok(Array.isArray(result), 'detectProtocol must return an array')
    assert.equal(result.length, 2, 'should detect both L402 and x402')
    const protocols = result.map(d => d.protocol).sort()
    assert.deepEqual(protocols, ['L402', 'x402'])
  })

  it('dual L402+MPP is impossible: L402 WWW-Authenticate returns 1-element array with L402 only', () => {
    // A single WWW-Authenticate header can only carry one scheme
    const result = detectProtocol({
      wwwAuthenticate: `L402 macaroon="${VALID_L402_MACAROON}", invoice="${VALID_L402_INVOICE}"`,
    })
    assert.ok(Array.isArray(result), 'detectProtocol must return an array')
    assert.equal(result.length, 1)
    assert.equal(result[0].protocol, 'L402')
  })

  it('triple detection (L402 + x402 header + x402 body): returns 2-element array (L402 + x402 V2, no V1 duplicate)', () => {
    const body = JSON.stringify({ x402Version: 1, accepts: validAccepts })
    const result = detectProtocol({
      wwwAuthenticate: `L402 macaroon="${VALID_L402_MACAROON}", invoice="${VALID_L402_INVOICE}"`,
      paymentRequired: validHeaderB64,
      responseBody: body,
    })
    assert.ok(Array.isArray(result), 'detectProtocol must return an array')
    assert.equal(result.length, 2, 'should have L402 + x402 (V2 only, not V1 duplicate)')
    const x402 = result.find(d => d.protocol === 'x402')
    assert.equal(x402.details.version, 2, 'x402 V2 takes precedence over V1')
  })

  it('single L402 only: returns 1-element array', () => {
    const result = detectProtocol({
      wwwAuthenticate: `L402 macaroon="${VALID_L402_MACAROON}", invoice="${VALID_L402_INVOICE}"`,
    })
    assert.ok(Array.isArray(result), 'detectProtocol must return an array')
    assert.equal(result.length, 1)
    assert.equal(result[0].protocol, 'L402')
    assert.equal(result[0].valid, true)
  })

  it('no protocol: returns empty array', () => {
    const result = detectProtocol({})
    assert.ok(Array.isArray(result), 'detectProtocol must return an array')
    assert.equal(result.length, 0)
  })
})

// ─── getPrimaryDetection ──────────────────────────────────────────────────

describe('getPrimaryDetection', () => {
  const validAccepts = [{ payTo: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', amount: '10000', network: 'eip155:8453' }]
  const validHeaderB64 = Buffer.from(JSON.stringify({ accepts: validAccepts })).toString('base64')

  it('extracts L402 detection from a mixed array', () => {
    const detections = detectProtocol({
      wwwAuthenticate: `L402 macaroon="${VALID_L402_MACAROON}", invoice="${VALID_L402_INVOICE}"`,
      paymentRequired: validHeaderB64,
    })
    const l402 = getPrimaryDetection(detections, 'L402')
    assert.equal(l402.protocol, 'L402')
    assert.equal(l402.valid, true)
  })

  it('returns null-protocol sentinel when protocol not in array', () => {
    const detections = detectProtocol({
      wwwAuthenticate: `L402 macaroon="${VALID_L402_MACAROON}", invoice="${VALID_L402_INVOICE}"`,
      paymentRequired: validHeaderB64,
    })
    const mpp = getPrimaryDetection(detections, 'MPP')
    assert.equal(mpp.protocol, null)
    assert.equal(mpp.valid, false)
    assert.equal(mpp.degradeReason, null)
    assert.deepEqual(mpp.details, {})
    assert.deepEqual(mpp.rawHeaders, {})
  })

  it('returns null-protocol sentinel for empty array', () => {
    const mpp = getPrimaryDetection([], 'L402')
    assert.equal(mpp.protocol, null)
    assert.equal(mpp.valid, false)
    assert.equal(mpp.degradeReason, null)
    assert.deepEqual(mpp.details, {})
    assert.deepEqual(mpp.rawHeaders, {})
  })
})
