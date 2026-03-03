/**
 * Registration API tests for POST /api/v1/register
 *
 * Run: node --test test/register.test.js
 *
 * Tests validation logic against a running server.
 * Probe-dependent tests use URLs that predictably fail SSRF or DNS checks.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const BASE = process.env.API_BASE || 'http://localhost:3402'
const API = `${BASE}/api/v1`

async function register(body) {
  const res = await fetch(`${API}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return {
    status: res.status,
    body: await res.json().catch(() => null),
  }
}

// ─── Validation Tests (no probe needed) ──────────────────────────────────────

describe('POST /api/v1/register — Validation', () => {
  it('rejects request with no body → 400', async () => {
    const res = await fetch(`${API}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    const body = await res.json()
    assert.equal(res.status, 400)
    assert.ok(body.error.includes('Missing required'))
  })

  it('rejects missing url → 400', async () => {
    const r = await register({ name: 'Test', protocol: 'L402' })
    assert.equal(r.status, 400)
    assert.ok(r.body.error.includes('url'))
  })

  it('rejects missing name → 400', async () => {
    const r = await register({ url: 'https://example.com/api', protocol: 'L402' })
    assert.equal(r.status, 400)
    assert.ok(r.body.error.includes('name'))
  })

  it('rejects missing protocol → 400', async () => {
    const r = await register({ url: 'https://example.com/api', name: 'Test' })
    assert.equal(r.status, 400)
    assert.ok(r.body.error.includes('protocol'))
  })

  it('rejects invalid protocol → 400', async () => {
    const r = await register({
      url: 'https://example.com/api',
      name: 'Test',
      protocol: 'HTTP402',
    })
    assert.equal(r.status, 400)
    assert.ok(r.body.error.includes('Invalid protocol'))
  })

  it('rejects x402 protocol → 400', async () => {
    const r = await register({
      url: 'https://example.com/api',
      name: 'Test x402 Service',
      protocol: 'x402',
    })
    assert.equal(r.status, 400)
    assert.ok(r.body.error.includes('L402'))
  })

  it('rejects "both" protocol → 400', async () => {
    const r = await register({
      url: 'https://example.com/api',
      name: 'Test',
      protocol: 'both',
    })
    assert.equal(r.status, 400)
    assert.ok(r.body.error.includes('L402'))
  })

  it('rejects oversized name → 400', async () => {
    const r = await register({
      url: 'https://example.com/api',
      name: 'A'.repeat(201),
      protocol: 'L402',
    })
    assert.equal(r.status, 400)
    assert.ok(r.body.error.includes('name'))
  })

  it('rejects invalid URL scheme → 400', async () => {
    const r = await register({
      url: 'ftp://example.com/api',
      name: 'Test',
      protocol: 'L402',
    })
    assert.equal(r.status, 400)
    assert.ok(r.body.error.includes('http'))
  })

  it('rejects invalid email format → 400', async () => {
    const r = await register({
      url: 'https://example.com/api',
      name: 'Test',
      protocol: 'L402',
      contact_email: 'not-an-email',
    })
    assert.equal(r.status, 400)
    assert.ok(r.body.error.includes('email'))
  })
})

// ─── SSRF Protection ─────────────────────────────────────────────────────────

describe('POST /api/v1/register — SSRF Protection', () => {
  it('blocks private IP (127.0.0.1) → 422', async () => {
    const r = await register({
      url: 'https://127.0.0.1/api',
      name: 'Private IP Test',
      protocol: 'L402',
    })
    assert.equal(r.status, 422)
    assert.ok(r.body.detail.includes('blocked') || r.body.detail.includes('private'))
  })

  it('blocks private IP (10.x.x.x) → 422', async () => {
    const r = await register({
      url: 'https://10.0.0.1/api',
      name: 'Internal Network Test',
      protocol: 'L402',
    })
    assert.equal(r.status, 422)
    assert.ok(r.body.detail.includes('blocked') || r.body.detail.includes('private'))
  })

  it('blocks non-http scheme → 400', async () => {
    const r = await register({
      url: 'ftp://example.com/file',
      name: 'FTP Test',
      protocol: 'L402',
    })
    assert.equal(r.status, 400)
    assert.ok(r.body.error.includes('http'))
  })
})

// ─── Probe Failures ──────────────────────────────────────────────────────────

describe('POST /api/v1/register — Probe Failures', () => {
  it('endpoint returns 200 instead of 402 → 422', async () => {
    // example.com returns 200 on GET — not L402-gated
    const r = await register({
      url: 'https://example.com',
      name: 'Not L402 Service',
      protocol: 'L402',
    })
    assert.equal(r.status, 422)
    assert.equal(r.body.error, 'L402 verification failed')
    assert.ok(r.body.detail.includes('instead of 402'))
    assert.ok(r.body.probe)
    assert.equal(r.body.probe.httpStatus, 200)
  })

  it('unreachable endpoint → 422', async () => {
    // Use a domain that resolves but port is unlikely to be open
    const r = await register({
      url: 'https://example.com:9999/nonexistent',
      name: 'Unreachable Service',
      protocol: 'L402',
    })
    assert.equal(r.status, 422)
    assert.equal(r.body.error, 'L402 verification failed')
  })
})

// ─── Content-Type ────────────────────────────────────────────────────────────

describe('POST /api/v1/register — Content-Type', () => {
  it('rejects non-JSON content type → 400 or 415', async () => {
    const res = await fetch(`${API}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'not json',
    })
    // express.json() rejects non-JSON content types
    assert.ok([400, 415].includes(res.status), `Expected 400 or 415, got ${res.status}`)
  })
})
