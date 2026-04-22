/**
 * Rate-limit test for POST /api/v1/claim/verify
 *
 * Asserts that claimLimiter (10 req/hr/IP) applies uniformly to /claim/verify,
 * not just /claim and /claim/revoke.
 *
 * Run: node --test test/claim-verify-rate-limit.test.js
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer, stopServer } from './helpers/server.js'

const CLAIM_LIMIT = parseInt(process.env.CLAIM_RATE_LIMIT) || 10

let BASE
let API

before(async () => {
  BASE = await startServer()
  API = `${BASE}/api/v1`
})

after(async () => {
  await stopServer()
})

describe('POST /api/v1/claim/verify rate limiting', () => {
  it(`returns 429 after ${CLAIM_LIMIT} requests`, async () => {
    const results = []

    for (let i = 0; i < CLAIM_LIMIT + 1; i++) {
      const res = await fetch(`${API}/claim/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: 'example.com' }),
      })
      results.push(res.status)
    }

    // Requests 1–N should NOT be 429
    for (let i = 0; i < CLAIM_LIMIT; i++) {
      assert.notEqual(results[i], 429, `request ${i + 1} should not be rate-limited`)
    }

    // Request N+1 MUST be 429
    assert.equal(results[CLAIM_LIMIT], 429, `request ${CLAIM_LIMIT + 1} should be rate-limited`)
  })

  it('returns the correct rate-limit error message on 429', async () => {
    // Limiter state carries over from previous test — next request should also be 429
    const res = await fetch(`${API}/claim/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'example.com' }),
    })
    assert.equal(res.status, 429)
    const body = await res.json()
    assert.equal(body.error, 'Too many claim requests. Limit: 10 per hour per IP.')
  })
})
