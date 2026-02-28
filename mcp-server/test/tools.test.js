import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const INDEX_URL = process.env.INDEX_URL || 'https://402index.io'

async function fetchJson(path) {
  const res = await fetch(`${INDEX_URL}${path}`)
  assert.ok(res.ok, `Expected 2xx, got ${res.status} for ${path}`)
  return res.json()
}

describe('402 Index API contract tests', () => {
  it('GET /api/v1/services returns services array with expected fields', async () => {
    const data = await fetchJson('/api/v1/services?limit=5')
    assert.ok(Array.isArray(data.services), 'services should be an array')
    assert.ok(typeof data.total === 'number', 'total should be a number')
    assert.ok(typeof data.limit === 'number', 'limit should be a number')
    assert.ok(typeof data.offset === 'number', 'offset should be a number')

    if (data.services.length > 0) {
      const svc = data.services[0]
      assert.ok(svc.id, 'service should have id')
      assert.ok(svc.url, 'service should have url')
      assert.ok(svc.protocol, 'service should have protocol')
    }
  })

  it('GET /api/v1/services with filters returns filtered results', async () => {
    const data = await fetchJson('/api/v1/services?protocol=x402&limit=3')
    for (const svc of data.services) {
      assert.equal(svc.protocol.toLowerCase(), 'x402', 'protocol filter should work')
    }
  })

  it('GET /api/v1/services/:id returns service detail or 404', async () => {
    // Get a real ID first
    const list = await fetchJson('/api/v1/services?limit=1')
    if (list.services.length > 0) {
      const id = list.services[0].id
      const detail = await fetchJson(`/api/v1/services/${id}`)
      assert.ok(detail.id, 'detail should have id')
      assert.ok(detail.url, 'detail should have url')
    }
  })

  it('GET /api/v1/categories returns category tree', async () => {
    const data = await fetchJson('/api/v1/categories')
    assert.ok(data.categories, 'should have categories')
    assert.ok(typeof data.total === 'number', 'should have total')
  })

  it('GET /api/v1/health returns status and counts', async () => {
    const data = await fetchJson('/api/v1/health')
    assert.equal(data.status, 'ok', 'status should be ok')
    assert.ok(typeof data.total_services === 'number', 'should have total_services')
    assert.ok(data.by_protocol, 'should have by_protocol')
    assert.ok(data.by_health, 'should have by_health')
  })
})
