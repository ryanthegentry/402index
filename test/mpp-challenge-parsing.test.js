import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseMppChallenge, decodeMppRequest } from '../src/services/detect-protocol.js'

// Real-world OpenAI MPP challenge
const OPENAI_CHALLENGE = 'Payment id="sHUn9TgrCUXsKVPVc2MCfja7j34HfqVP6thHbJQ9fQw", realm="openai.mpp.tempo.xyz", method="tempo", intent="session", request="eyJhbW91bnQiOiIxMDAwMCIsImN1cnJlbmN5IjoiMHgyMGMwMDAwMDAwMDAwMDAwMDAwMDAwMDBiOTUzN2QxMWM2MGU4YjUwIiwibWV0aG9kRGV0YWlscyI6eyJjaGFpbklkIjo0MjE3LCJlc2Nyb3dDb250cmFjdCI6IjB4MzNiOTAxMDE4MTc0RERhYkU0ODQxMDQyYWI3NmJhODVENGUyNGYyNSJ9LCJyZWNpcGllbnQiOiIweGNhNGU4MzVGODAzY0IwYjdDNDI4MjIyQjNBM0I5ODUxOGQ0Nzc5RmUiLCJ1bml0VHlwZSI6InJlcXVlc3QifQ", description=" - generation", expires="2026-03-18T20:04:59.811Z"'

describe('parseMppChallenge', () => {
  it('extracts all fields from real OpenAI challenge', () => {
    const parsed = parseMppChallenge(OPENAI_CHALLENGE)
    assert.ok(parsed, 'should not return null')
    assert.equal(parsed.id, 'sHUn9TgrCUXsKVPVc2MCfja7j34HfqVP6thHbJQ9fQw')
    assert.equal(parsed.realm, 'openai.mpp.tempo.xyz')
    assert.equal(parsed.method, 'tempo')
    assert.equal(parsed.intent, 'session')
    assert.ok(parsed.request.startsWith('eyJ'), 'request should be base64url')
    assert.equal(parsed.expires, '2026-03-18T20:04:59.811Z')
    assert.ok(parsed.description.includes('generation'))
  })

  it('extracts charge intent', () => {
    const parsed = parseMppChallenge('Payment id="x", realm="r", method="tempo", intent="charge", request="eyJ0ZXN0IjoxfQ"')
    assert.equal(parsed.intent, 'charge')
  })

  it('extracts stripe method', () => {
    const parsed = parseMppChallenge('Payment id="x", realm="r", method="stripe", intent="charge", request="eyJ0ZXN0IjoxfQ"')
    assert.equal(parsed.method, 'stripe')
  })

  it('returns null for missing fields gracefully', () => {
    const parsed = parseMppChallenge('Payment id="x"')
    assert.ok(parsed, 'should still parse')
    assert.equal(parsed.id, 'x')
    assert.equal(parsed.realm, null)
    assert.equal(parsed.method, null)
    assert.equal(parsed.intent, null)
    assert.equal(parsed.request, null)
  })

  it('returns null for non-Payment scheme', () => {
    assert.equal(parseMppChallenge('Bearer token="abc"'), null)
    assert.equal(parseMppChallenge('L402 macaroon="abc"'), null)
  })

  it('returns null for null/undefined/empty input', () => {
    assert.equal(parseMppChallenge(null), null)
    assert.equal(parseMppChallenge(undefined), null)
    assert.equal(parseMppChallenge(''), null)
  })

  it('handles values with special characters in description', () => {
    const parsed = parseMppChallenge('Payment id="x", realm="r", method="tempo", intent="charge", request="dGVzdA", description="test - with special chars"')
    assert.equal(parsed.description, 'test - with special chars')
  })

  it('handles escaped quotes in description', () => {
    const parsed = parseMppChallenge('Payment id="x", realm="r", method="tempo", intent="charge", request="dGVzdA", description="say \\"hello\\""')
    assert.equal(parsed.description, 'say "hello"')
  })

  it('handles backslash in value', () => {
    const parsed = parseMppChallenge('Payment id="x", realm="r", method="tempo", intent="charge", request="dGVzdA", description="path\\\\to\\\\file"')
    assert.equal(parsed.description, 'path\\to\\file')
  })
})

describe('decodeMppRequest', () => {
  it('decodes real OpenAI request payload', () => {
    const parsed = parseMppChallenge(OPENAI_CHALLENGE)
    const decoded = decodeMppRequest(parsed.request)
    assert.ok(decoded, 'should decode successfully')
    assert.equal(decoded.amount, '10000')
    assert.equal(decoded.currency, '0x20c000000000000000000000b9537d11c60e8b50')
    assert.equal(decoded.methodDetails.chainId, 4217)
    assert.equal(decoded.methodDetails.escrowContract, '0x33b901018174DDabE4841042ab76ba85D4e24f25')
    assert.equal(decoded.recipient, '0xca4e835F803cB0b7C428222B3A3B98518d4779Fe')
    assert.equal(decoded.unitType, 'request')
  })

  it('decodes simple base64url payload', () => {
    const payload = { amount: '5000', currency: 'usd' }
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const decoded = decodeMppRequest(encoded)
    assert.deepEqual(decoded, payload)
  })

  it('handles base64url needing padding', () => {
    // Create a payload that produces base64url needing padding (length not multiple of 4)
    const payload = { a: 1 }
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
    // Strip any padding that might exist
    const noPad = encoded.replace(/=/g, '')
    const decoded = decodeMppRequest(noPad)
    assert.deepEqual(decoded, payload)
  })

  it('returns null for invalid base64', () => {
    assert.equal(decodeMppRequest('!!!invalid!!!'), null)
  })

  it('returns null for valid base64 but not JSON', () => {
    const encoded = Buffer.from('not json').toString('base64url')
    assert.equal(decodeMppRequest(encoded), null)
  })

  it('returns null for empty string', () => {
    assert.equal(decodeMppRequest(''), null)
  })
})
