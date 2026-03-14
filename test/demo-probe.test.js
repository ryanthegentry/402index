import { describe, it, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { formatProbeSteps, validateProbeUrl } from '../src/services/probe-live.js'

// ─── URL Validation ────────────────────────────────────────────────────────────

describe('validateProbeUrl', () => {
  it('accepts valid HTTPS URLs', () => {
    const result = validateProbeUrl('https://api.example.com/weather')
    assert.equal(result, null, 'should return null for valid URL')
  })

  it('rejects non-HTTPS URLs', () => {
    const result = validateProbeUrl('http://api.example.com/weather')
    assert.ok(result, 'should return error for HTTP URL')
    assert.ok(result.includes('HTTPS'), 'error should mention HTTPS')
  })

  it('rejects malformed URLs', () => {
    const result = validateProbeUrl('not-a-url')
    assert.ok(result, 'should return error for malformed URL')
  })

  it('rejects empty input', () => {
    const result = validateProbeUrl('')
    assert.ok(result, 'should return error for empty URL')
  })

  it('rejects private IPs', () => {
    const result = validateProbeUrl('https://192.168.1.1/api')
    assert.ok(result, 'should return error for private IP')
  })

  it('rejects localhost', () => {
    const result = validateProbeUrl('https://localhost/api')
    assert.ok(result, 'should return error for localhost')
  })

  it('rejects 127.0.0.1', () => {
    const result = validateProbeUrl('https://127.0.0.1/api')
    assert.ok(result, 'should return error for loopback IP')
  })

  it('rejects file:// scheme', () => {
    const result = validateProbeUrl('file:///etc/passwd')
    assert.ok(result, 'should return error for file scheme')
  })
})

// ─── Probe Step Formatting ─────────────────────────────────────────────────────

describe('formatProbeSteps', () => {
  it('formats connect step', () => {
    const step = formatProbeSteps.connect('https://api.example.com/weather')
    assert.equal(step.step, 'connect')
    assert.ok(step.message.includes('api.example.com'), 'should include hostname')
  })

  it('formats request step with method', () => {
    const step = formatProbeSteps.request('GET', 'https://api.example.com/weather')
    assert.equal(step.step, 'request')
    assert.ok(step.message.includes('GET'), 'should include method')
    assert.ok(step.message.includes('api.example.com'), 'should include URL')
  })

  it('formats response step with status and timing', () => {
    const step = formatProbeSteps.response(402, 145)
    assert.equal(step.step, 'response')
    assert.equal(step.status, 402)
    assert.equal(step.time_ms, 145)
    assert.ok(step.message.includes('402'), 'should include status code')
    assert.ok(step.message.includes('145'), 'should include timing')
  })

  it('formats L402 headers step', () => {
    const step = formatProbeSteps.headers('L402', {
      'WWW-Authenticate': 'L402 macaroon="abc", invoice="lnbc..."'
    })
    assert.equal(step.step, 'headers')
    assert.equal(step.protocol, 'L402')
    assert.ok(step.message.includes('L402'), 'should identify L402 protocol')
  })

  it('formats x402 headers step', () => {
    const step = formatProbeSteps.headers('x402', {
      'PAYMENT-REQUIRED': '{"accepts": [{"asset": "USDC"}]}'
    })
    assert.equal(step.step, 'headers')
    assert.equal(step.protocol, 'x402')
    assert.ok(step.message.includes('x402'), 'should identify x402 protocol')
  })

  it('formats no-protocol headers step when neither detected', () => {
    const step = formatProbeSteps.headers(null, {})
    assert.equal(step.step, 'headers')
    assert.equal(step.protocol, null)
    assert.ok(step.message.includes('No'), 'should indicate no protocol detected')
  })

  it('formats analysis step with health classification', () => {
    const step = formatProbeSteps.analysis('healthy', 'L402')
    assert.equal(step.step, 'analysis')
    assert.ok(step.message.includes('healthy'), 'should include health status')
  })

  it('formats done step', () => {
    const step = formatProbeSteps.done('healthy', 'L402', 145)
    assert.equal(step.step, 'done')
    assert.ok(step.health_status, 'should include health status')
  })

  it('formats error step', () => {
    const step = formatProbeSteps.error('Connection timed out')
    assert.equal(step.step, 'error')
    assert.ok(step.message.includes('timed out'), 'should include error message')
  })
})
