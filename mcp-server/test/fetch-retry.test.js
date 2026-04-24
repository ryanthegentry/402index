import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

describe('fetchJson retry behavior', () => {
  let fetchJson
  let callCount
  let originalFetch
  let savedRetries

  before(async () => {
    originalFetch = globalThis.fetch
    savedRetries = process.env.FETCH_RETRIES
    // Import the module — fetchJson must be exported from dist/index.js
    const mod = await import('../dist/index.js')
    fetchJson = mod.fetchJson
    assert.ok(typeof fetchJson === 'function', 'fetchJson must be exported from index.ts')
  })

  after(() => {
    globalThis.fetch = originalFetch
    if (savedRetries === undefined) {
      delete process.env.FETCH_RETRIES
    } else {
      process.env.FETCH_RETRIES = savedRetries
    }
  })

  beforeEach(() => {
    callCount = 0
    delete process.env.FETCH_RETRIES
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function mockFetchSequence(responseSequence) {
    callCount = 0
    globalThis.fetch = async () => {
      const idx = Math.min(callCount, responseSequence.length - 1)
      callCount++
      const r = responseSequence[idx]
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        json: async () => r.body,
        text: async () => JSON.stringify(r.body),
      }
    }
  }

  it('succeeds on first try without retry', async () => {
    mockFetchSequence([{ status: 200, body: { data: 'ok' } }])
    const result = await fetchJson('/api/v1/health')
    assert.equal(callCount, 1, 'fetch called once on success')
    assert.deepStrictEqual(result, { data: 'ok' })
  })

  it('retries on 500 and succeeds on second attempt', async () => {
    mockFetchSequence([
      { status: 500, body: {} },
      { status: 200, body: { services: [], total: 0 } },
    ])
    const result = await fetchJson('/api/v1/services')
    assert.equal(callCount, 2, 'fetch called twice (1 retry on 500)')
    assert.deepStrictEqual(result, { services: [], total: 0 })
  })

  it('exhausts retries on repeated 500 and returns error shape', async () => {
    mockFetchSequence([
      { status: 500, body: {} },
      { status: 500, body: {} },
      { status: 500, body: {} },
    ])
    const result = await fetchJson('/api/v1/services')
    assert.equal(callCount, 2, 'fetch called exactly 2 times (default max)')
    assert.equal(result.error, true, 'result should have error: true')
    assert.equal(result.status, 500, 'result should have status: 500')
    assert.ok(typeof result.message === 'string', 'result should have message string')
  })

  it('does NOT retry on 404 (4xx)', async () => {
    mockFetchSequence([{ status: 404, body: {} }])
    const result = await fetchJson('/api/v1/services/nonexistent')
    assert.equal(callCount, 1, 'fetch called once — 4xx should not retry')
    assert.equal(result.error, true)
    assert.equal(result.status, 404)
  })

  it('respects FETCH_RETRIES=0 as fail-fast', async () => {
    process.env.FETCH_RETRIES = '0'
    mockFetchSequence([
      { status: 500, body: {} },
      { status: 200, body: { ok: true } },
    ])
    const result = await fetchJson('/api/v1/health')
    assert.equal(callCount, 1, 'fetch called once with FETCH_RETRIES=0')
    assert.equal(result.error, true, 'should return error on first 500 with fail-fast')
  })

  it('respects arbitrary FETCH_RETRIES count', async () => {
    process.env.FETCH_RETRIES = '4'
    mockFetchSequence([
      { status: 500, body: {} },
      { status: 500, body: {} },
      { status: 500, body: {} },
      { status: 200, body: { recovered: true } },
    ])
    const result = await fetchJson('/api/v1/health')
    assert.equal(callCount, 4, 'fetch called 4 times with FETCH_RETRIES=4')
    assert.deepStrictEqual(result, { recovered: true })
  })
})
