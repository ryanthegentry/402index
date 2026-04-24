import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { installMockFetch, restoreFetch } from './helpers/mock-fetch.js'

const useLive = process.env.MCP_SMOKE_LIVE === '1'

if (!useLive) {
  before(() => installMockFetch())
  after(() => restoreFetch())
}

const INDEX_URL = process.env.INDEX_URL || 'https://402index.io'

describe('402 Index API — verified param contract tests (#125)', () => {
  it('GET /api/v1/services?verified=true accepts the parameter', async () => {
    const res = await fetch(`${INDEX_URL}/api/v1/services?verified=true&limit=3`)
    assert.ok(res.ok, `Expected 2xx, got ${res.status}`)
    const data = await res.json()
    assert.ok(Array.isArray(data.services))
  })

  it('services in response include domain_verified field', async () => {
    const res = await fetch(`${INDEX_URL}/api/v1/services?limit=1`)
    const data = await res.json()
    if (data.services.length > 0) {
      assert.ok('domain_verified' in data.services[0], 'domain_verified field missing from response')
    }
  })
})
