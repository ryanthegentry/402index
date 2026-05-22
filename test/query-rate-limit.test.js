import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { queryRateLimiterMin, queryRateLimiterHour } from '../src/middleware/rate-limit.js'

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

// ─── RL4 — L402-verified requests bypass both query limiters ─────────────────
// Uses a dedicated mini Express app so we can inject req.l402Verified = true via
// a pre-middleware, without needing a real macaroon token. Unique X-Forwarded-For
// IPs isolate these buckets from the RL1-RL3 counts above.
describe('Group RL4 — L402-verified requests bypass query limiters', () => {
  let rl4Server, rl4Base, rl4App, l402Injector

  before(async () => {
    l402Injector = (req, _res, next) => { req.l402Verified = true; next() }
    rl4App = express()
    rl4App.set('trust proxy', 1)
    rl4App.use(l402Injector)
    rl4App.use(queryRateLimiterMin)
    rl4App.use(queryRateLimiterHour)
    rl4App.use((_req, res) => res.status(200).json({ ok: true }))

    rl4Server = await new Promise((resolve, reject) => {
      const s = rl4App.listen(0, '127.0.0.1', () => resolve(s))
      s.on('error', reject)
    })
    rl4Base = `http://127.0.0.1:${rl4Server.address().port}`
  })

  after(() => new Promise(r => rl4Server.close(r)))

  it('RL4-chain: l402Verified injector is mounted before both query limiters in app.router.stack', () => {
    const stack = rl4App.router.stack
    const injectorIdx = stack.findIndex(l => l.handle === l402Injector)
    const minIdx = stack.findIndex(l => l.handle === queryRateLimiterMin)
    const hourIdx = stack.findIndex(l => l.handle === queryRateLimiterHour)
    assert.ok(injectorIdx !== -1, 'l402Verified injector not found in stack')
    assert.ok(minIdx !== -1, 'queryRateLimiterMin not found in stack')
    assert.ok(hourIdx !== -1, 'queryRateLimiterHour not found in stack')
    assert.ok(injectorIdx < minIdx, 'injector must precede queryRateLimiterMin')
    assert.ok(injectorIdx < hourIdx, 'injector must precede queryRateLimiterHour')
  })

  it('RL4a: 35 ?q=foo requests with l402Verified bypass per-minute limiter (0 × 429)', async () => {
    const results = await Promise.all(
      Array.from({ length: 35 }, () =>
        fetch(`${rl4Base}/?q=foo`, { headers: { 'x-forwarded-for': '10.10.4.1' } }),
      ),
    )
    const limited = results.filter(r => r.status === 429)
    assert.equal(limited.length, 0, `Expected 0 rate-limited responses, got ${limited.length}`)
  })

  it('RL4b: l402Verified bypasses hourly limiter even when QUERY_RATE_LIMIT_PER_HOUR=3', async () => {
    process.env.QUERY_RATE_LIMIT_PER_HOUR = '3'
    try {
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          fetch(`${rl4Base}/?q=foo`, { headers: { 'x-forwarded-for': '10.10.4.2' } }),
        ),
      )
      const limited = results.filter(r => r.status === 429)
      assert.equal(limited.length, 0, 'L402-verified requests must bypass even a low hourly limit')
    } finally {
      delete process.env.QUERY_RATE_LIMIT_PER_HOUR
    }
  })
})

// ─── RL5 — hourly query rate limit enforced at configured threshold ───────────
// Requires F1 (limit as arrow function) so that QUERY_RATE_LIMIT_PER_HOUR set
// after module import takes effect at request time. Without F1, the limit was
// baked in as 500 at module-load time; 4 requests never trigger 429.
describe('Group RL5 — hourly query rate limit returns 429 at configured threshold', () => {
  let rl5Server, rl5Base

  before(async () => {
    process.env.QUERY_RATE_LIMIT_PER_HOUR = '3'
    process.env.QUERY_RATE_LIMIT_PER_MIN = '1000'

    const app = express()
    app.set('trust proxy', 1)
    app.use(queryRateLimiterMin)
    app.use(queryRateLimiterHour)
    app.use((_req, res) => res.status(200).json({ ok: true }))

    rl5Server = await new Promise((resolve, reject) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s))
      s.on('error', reject)
    })
    rl5Base = `http://127.0.0.1:${rl5Server.address().port}`
  })

  after(async () => {
    delete process.env.QUERY_RATE_LIMIT_PER_HOUR
    delete process.env.QUERY_RATE_LIMIT_PER_MIN
    await new Promise(r => rl5Server.close(r))
  })

  it('RL5: 4th ?q=foo within the hour returns 429 with retry_after=3600 and Retry-After header', async () => {
    // Retry-After: '3600' is set by the custom handler in rate-limit.js (not the
    // draft-7 standard headers), so it always matches the configured window.
    const rl5Ip = '10.10.5.1'
    const opts = { headers: { 'x-forwarded-for': rl5Ip } }

    for (let i = 1; i <= 3; i++) {
      const res = await fetch(`${rl5Base}/?q=foo`, opts)
      assert.notEqual(res.status, 429, `Request ${i} should not be rate-limited (got ${res.status})`)
    }

    const res = await fetch(`${rl5Base}/?q=foo`, opts)
    assert.equal(res.status, 429, '4th request within the hour should return 429')

    const body = await res.json()
    assert.equal(body.retry_after, 3600, 'retry_after should be 3600')
    assert.ok(
      typeof body.message === 'string' && body.message.toLowerCase().includes('per hour'),
      `Expected message to include "per hour", got: ${body.message}`,
    )
    assert.equal(res.headers.get('retry-after'), '3600', 'Retry-After header should be 3600')
  })
})
