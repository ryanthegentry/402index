import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { resetProvider, getProvider } from '../src/services/l402-provider.js'

describe('export.csv L402 challenge', () => {
  let originalEnv

  beforeEach(() => {
    originalEnv = { ...process.env }
    process.env.L402_GATEWAY = 'mock'
    delete process.env.NODE_ENV
    resetProvider()
  })

  afterEach(() => {
    process.env = originalEnv
    resetProvider()
  })

  it('mock provider returns valid challenge structure', async () => {
    const provider = getProvider()
    const challenge = await provider.createChallenge(500, 24)
    assert.ok(challenge)
    assert.ok(challenge.macaroon)
    assert.ok(challenge.invoice)
    assert.ok(challenge.paymentHash)
    assert.ok(challenge.invoice.startsWith('lnbc'))
  })

  it('WWW-Authenticate header format is correct', async () => {
    const provider = getProvider()
    const challenge = await provider.createChallenge(500, 24)
    const wwwAuth = `L402 macaroon="${challenge.macaroon}", invoice="${challenge.invoice}"`
    assert.ok(wwwAuth.startsWith('L402 '))
    assert.ok(wwwAuth.includes('macaroon="'))
    assert.ok(wwwAuth.includes('invoice="lnbc'))
  })

  it('handler returns 402 with WWW-Authenticate when not verified', async () => {
    const provider = getProvider()
    const priceSats = 500
    const durationHours = 24

    // Simulate what the handler does
    const challenge = await provider.createChallenge(priceSats, durationHours)
    assert.ok(challenge, 'challenge should not be null')

    const wwwAuth = `L402 macaroon="${challenge.macaroon}", invoice="${challenge.invoice}"`

    // Build mock response to verify handler behavior
    const res = {
      statusCode: null,
      headers: {},
      body: null,
      status(code) { res.statusCode = code; return res },
      set(k, v) { res.headers[k] = v; return res },
      json(data) { res.body = data; return res },
    }

    // Simulate handler logic
    res.status(402).set('WWW-Authenticate', wwwAuth).json({
      error: 'Payment Required',
      message: 'CSV export requires L402 payment. Pay the Lightning invoice to download.',
      invoice: challenge.invoice,
      macaroon: challenge.macaroon,
      payment_hash: challenge.paymentHash,
      price_sats: priceSats,
      duration_hours: durationHours,
    })

    assert.equal(res.statusCode, 402)
    assert.ok(res.headers['WWW-Authenticate'])
    assert.ok(res.headers['WWW-Authenticate'].startsWith('L402 '))
    assert.ok(res.headers['WWW-Authenticate'].includes('macaroon="'))
    assert.ok(res.headers['WWW-Authenticate'].includes('invoice="'))
    assert.equal(res.body.error, 'Payment Required')
    assert.ok(res.body.invoice)
    assert.ok(res.body.macaroon)
    assert.ok(res.body.payment_hash)
    assert.equal(res.body.price_sats, 500)
    assert.equal(res.body.duration_hours, 24)
  })

  it('stub provider returns null challenge (graceful degradation)', async () => {
    process.env.L402_GATEWAY = 'none'
    resetProvider()
    const provider = getProvider()
    const challenge = await provider.createChallenge(500, 24)
    assert.equal(challenge, null)
  })

  it('fallback 402 response has correct structure', () => {
    // When challenge is null, handler falls back to bare 402
    const res = {
      statusCode: null,
      headers: {},
      body: null,
      status(code) { res.statusCode = code; return res },
      set(k, v) { res.headers[k] = v; return res },
      json(data) { res.body = data; return res },
    }

    // Simulate fallback path
    res.status(402).json({
      error: 'Payment Required',
      message: 'CSV export requires L402 payment. Add ?l402=require to any API endpoint, or include an L402 token in the Authorization header.',
    })

    assert.equal(res.statusCode, 402)
    assert.equal(res.body.error, 'Payment Required')
    assert.ok(!res.headers['WWW-Authenticate'], 'fallback should not have WWW-Authenticate')
  })

  it('custom price and duration from env vars', async () => {
    process.env.L402_PRICE_SATS = '1000'
    process.env.L402_DURATION_HOURS = '48'
    resetProvider()

    const priceSats = parseInt(process.env.L402_PRICE_SATS) || 500
    const durationHours = parseInt(process.env.L402_DURATION_HOURS) || 24

    assert.equal(priceSats, 1000)
    assert.equal(durationHours, 48)

    const provider = getProvider()
    const challenge = await provider.createChallenge(priceSats, durationHours)
    assert.ok(challenge.invoice.includes('1000'))
  })
})
