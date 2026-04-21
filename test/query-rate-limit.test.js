import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'

let startServer, stopServer, API

describe('Group RL — query rate limiter (#161)', () => {
  before(async () => {
    process.env.NODE_ENV = 'test'
    process.env.OPENAI_API_KEY = 'test-key-fake'

    const srv = await import('./helpers/server.js')
    startServer = srv.startServer
    stopServer = srv.stopServer
    API = await startServer()
  })

  after(async () => {
    await stopServer()
  })

  it('RL1: 31st ?q= request within 60s returns 429 with expected JSON body', async () => {
    const limit = parseInt(process.env.QUERY_RATE_LIMIT_PER_MIN) || 30

    for (let i = 0; i < limit; i++) {
      const res = await fetch(`${API}/api/v1/services?q=foo`)
      assert.notEqual(res.status, 429, `Request ${i + 1} should not be rate limited (got ${res.status})`)
    }

    const res = await fetch(`${API}/api/v1/services?q=foo`)
    assert.equal(res.status, 429, `Request ${limit + 1} should return 429`)

    const body = await res.json()
    assert.equal(body.error, 'Too Many Requests')
    assert.ok(
      typeof body.message === 'string' && body.message.includes('Query rate limit exceeded'),
      `Expected message to include "Query rate limit exceeded", got: ${body.message}`,
    )
    assert.ok(typeof body.retry_after === 'number', 'retry_after should be a number')
    assert.ok(res.headers.get('retry-after') !== null, 'Retry-After header should be present')
  })

  it('RL2: requests without ?q= are NOT throttled by the query rate limiter', async () => {
    // freeLimiter allows 100/min; 30 plain requests should be well under that
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${API}/api/v1/services`)
      assert.notEqual(
        res.status, 429,
        `Plain request ${i + 1} (no ?q=) should not be query-rate-limited (got ${res.status})`,
      )
    }
  })

  it('RL3: ?q=* is NOT throttled by the query rate limiter', async () => {
    // q=* is match-all — no OpenAI call, no rate limit cost
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${API}/api/v1/services?q=*`)
      assert.notEqual(
        res.status, 429,
        `Request ${i + 1} with q=* should not be query-rate-limited (got ${res.status})`,
      )
    }
  })
})
