import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// ─── Integration tests for demo API endpoints ────────────────────────────────
// Requires a running server: API_BASE=http://localhost:3402 npm test

const API = process.env.API_BASE || 'http://localhost:3402'

async function api(path) {
  const res = await fetch(`${API}${path}`)
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    body: await res.json().catch(() => null),
    text: null,
  }
}

async function page(path) {
  const res = await fetch(`${API}${path}`)
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    text: await res.text(),
  }
}

// ─── GET /demo (redirects to /) ──────────────────────────────────────────────

describe('GET /demo', () => {
  it('returns 301 redirect to /', async () => {
    const res = await fetch(`${API}/demo`, { redirect: 'manual' })
    assert.equal(res.status, 301)
    assert.ok(res.headers.get('location')?.endsWith('/'), 'should redirect to /')
  })
})

// ─── GET /api/v1/demo/probe-sample ───────────────────────────────────────────

describe('GET /api/v1/demo/probe-sample', () => {
  it('returns 200 with valid JSON structure', async () => {
    const r = await api('/api/v1/demo/probe-sample')
    assert.equal(r.status, 200)
    assert.ok(r.body, 'should return JSON body')
    assert.ok(r.body.service, 'should have service object')
    assert.ok(r.body.healthCheck, 'should have healthCheck object')
    assert.ok(r.body.flow, 'should have flow object')
  })

  it('service object has required fields', async () => {
    const r = await api('/api/v1/demo/probe-sample')
    const svc = r.body.service
    assert.ok(svc.name, 'service should have name')
    assert.ok(svc.url, 'service should have url')
    assert.ok(svc.protocol, 'service should have protocol')
  })

  it('healthCheck object has required fields', async () => {
    const r = await api('/api/v1/demo/probe-sample')
    const hc = r.body.healthCheck
    assert.ok(hc.status, 'healthCheck should have status')
    assert.ok(typeof hc.http_status === 'number' || hc.http_status === null, 'http_status should be number or null')
  })

  it('flow object has required fields', async () => {
    const r = await api('/api/v1/demo/probe-sample')
    const flow = r.body.flow
    assert.ok(flow.request, 'flow should have request')
    assert.ok(flow.responseStatus, 'flow should have responseStatus')
    assert.ok(flow.protocolHeaders, 'flow should have protocolHeaders')
    assert.ok(flow.retryHeader, 'flow should have retryHeader')
    assert.ok(flow.successStatus, 'flow should have successStatus')
  })

  it('defaults to L402 protocol', async () => {
    const r = await api('/api/v1/demo/probe-sample')
    assert.equal(r.body.service.protocol, 'L402', 'default protocol should be L402')
  })

  it('filters by protocol=L402', async () => {
    const r = await api('/api/v1/demo/probe-sample?protocol=L402')
    assert.equal(r.status, 200)
    assert.equal(r.body.service.protocol, 'L402')
    assert.ok(r.body.flow.protocolHeaders.L402, 'should have L402 headers')
  })

  it('filters by protocol=x402', async () => {
    const r = await api('/api/v1/demo/probe-sample?protocol=x402')
    assert.equal(r.status, 200)
    assert.equal(r.body.service.protocol, 'x402')
    assert.ok(r.body.flow.protocolHeaders.x402, 'should have x402 headers')
  })

  it('L402 flow shows WWW-Authenticate header format', async () => {
    const r = await api('/api/v1/demo/probe-sample?protocol=L402')
    const headers = r.body.flow.protocolHeaders.L402
    assert.ok(headers.includes('WWW-Authenticate') || headers.includes('macaroon'), 'L402 should reference WWW-Authenticate or macaroon')
  })

  it('x402 flow shows payment requirement format', async () => {
    const r = await api('/api/v1/demo/probe-sample?protocol=x402')
    const headers = r.body.flow.protocolHeaders.x402
    assert.ok(headers, 'x402 should have protocol headers')
  })
})

// ─── GET /api/v1/healthcheck (stub) ──────────────────────────────────────────

describe('GET /api/v1/healthcheck', () => {
  it('returns 501 Not Implemented', async () => {
    const r = await api('/api/v1/healthcheck')
    assert.equal(r.status, 501)
  })

  it('returns informative JSON body', async () => {
    const r = await api('/api/v1/healthcheck')
    assert.ok(r.body.error, 'should have error field')
    assert.ok(r.body.message, 'should have message field')
    assert.ok(r.body.message.includes('coming soon') || r.body.message.includes('Coming soon'), 'should mention coming soon')
  })
})
