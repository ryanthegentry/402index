import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// ─── Integration tests: verify /api/v1/services supports demo search needs ──
// Requires a running server: API_BASE=http://localhost:3402 npm test

const API = process.env.API_BASE || 'http://localhost:3402'

async function api(path) {
  const res = await fetch(`${API}${path}`)
  return {
    status: res.status,
    body: await res.json().catch(() => null),
  }
}

// ─── Combined filter support ─────────────────────────────────────────────────

describe('services API — demo search support', () => {
  it('supports combined filters (protocol + health)', async () => {
    const r = await api('/api/v1/services?protocol=L402&health=healthy&limit=5')
    assert.equal(r.status, 200)
    assert.ok(Array.isArray(r.body.services), 'should return services array')
    for (const svc of r.body.services) {
      assert.equal(svc.protocol, 'L402', 'all services should be L402')
      assert.equal(svc.health_status, 'healthy', 'all services should be healthy')
    }
  })

  it('supports combined filters (protocol + category + health)', async () => {
    const r = await api('/api/v1/services?protocol=x402&health=healthy&limit=5')
    assert.equal(r.status, 200)
    assert.ok(Array.isArray(r.body.services))
  })

  it('response includes reliability_score field', async () => {
    const r = await api('/api/v1/services?limit=5')
    assert.equal(r.status, 200)
    if (r.body.services.length > 0) {
      const svc = r.body.services[0]
      assert.ok('reliability_score' in svc, 'service should have reliability_score field')
    }
  })

  it('response includes latency_p50_ms field', async () => {
    const r = await api('/api/v1/services?limit=5')
    assert.equal(r.status, 200)
    if (r.body.services.length > 0) {
      const svc = r.body.services[0]
      assert.ok('latency_p50_ms' in svc, 'service should have latency_p50_ms field')
    }
  })

  it('response includes health_status field', async () => {
    const r = await api('/api/v1/services?limit=5')
    assert.equal(r.status, 200)
    if (r.body.services.length > 0) {
      const svc = r.body.services[0]
      assert.ok('health_status' in svc, 'service should have health_status field')
    }
  })

  it('sort by reliability works', async () => {
    const r = await api('/api/v1/services?sort=reliability&limit=10')
    assert.equal(r.status, 200)
    assert.ok(Array.isArray(r.body.services))
    // Verify descending order (default)
    for (let i = 1; i < r.body.services.length; i++) {
      const prev = r.body.services[i - 1].reliability_score ?? -1
      const curr = r.body.services[i].reliability_score ?? -1
      assert.ok(prev >= curr, `reliability should be in descending order: ${prev} >= ${curr}`)
    }
  })

  it('results contain all fields needed for demo display', async () => {
    const r = await api('/api/v1/services?limit=1')
    assert.equal(r.status, 200)
    if (r.body.services.length > 0) {
      const svc = r.body.services[0]
      const requiredFields = ['id', 'name', 'url', 'protocol', 'health_status', 'latency_p50_ms', 'reliability_score']
      for (const field of requiredFields) {
        assert.ok(field in svc, `service should have ${field} field`)
      }
    }
  })

  it('text search (q parameter) works', async () => {
    const r = await api('/api/v1/services?q=weather&limit=5')
    assert.equal(r.status, 200)
    assert.ok(Array.isArray(r.body.services))
  })

  it('max_price_usd filter works', async () => {
    const r = await api('/api/v1/services?max_price_usd=1.00&limit=5')
    assert.equal(r.status, 200)
    assert.ok(Array.isArray(r.body.services))
    for (const svc of r.body.services) {
      if (svc.price_usd != null) {
        assert.ok(svc.price_usd <= 1.0, `price_usd should be <= 1.00, got ${svc.price_usd}`)
      }
    }
  })
})
