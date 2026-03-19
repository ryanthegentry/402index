/**
 * Registration API tests for POST /api/v1/register
 *
 * Run: node --test test/register.test.js
 *
 * Tests validation logic against a running server.
 * Probe-dependent tests use URLs that predictably fail SSRF or DNS checks.
 * Macaroon/invoice validation tests use a local mock server via public IPv6.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { randomUUID } from 'node:crypto'

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

  it('accepts lowercase "l402" protocol (case-insensitive)', async () => {
    // Should pass validation and hit the L402 probe (which will fail on example.com → 422)
    const r = await register({
      url: 'https://example.com/api',
      name: 'Lowercase Protocol Test',
      protocol: 'l402',
    })
    // 422 = passed validation, failed probe (example.com returns 200, not 402)
    assert.equal(r.status, 422, 'lowercase l402 should pass validation (not 400)')
  })

  it('accepts mixed-case "L402" variations', async () => {
    const r = await register({
      url: 'https://example.com/api',
      name: 'Mixed Case Test',
      protocol: 'l402',
    })
    assert.equal(r.status, 422, 'mixed case l402 should pass validation (not 400)')
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

// ─── Macaroon/Invoice Validation (mock L402 server) ─────────────────────────
//
// These tests spin up a local HTTP server that returns custom L402 challenges,
// then register that server's URL against the running 402index server.
// SSRF protection blocks localhost/private IPs, so we use a public IPv6 address
// assigned to this machine. Tests skip gracefully if no public IPv6 is available
// or the 402index server isn't running.

const VALID_MACAROON = 'AgELYmVuY2FybWFu'
const VALID_INVOICE = 'lnbc1000n1pjtest' + 'a'.repeat(200)
const SHORT_INVOICE = 'lnbc1234'

/**
 * Find a global (non-private) IPv6 address on this machine that passes SSRF checks.
 * Returns the address string or null if none found.
 */
function findPublicIpv6() {
  const nets = networkInterfaces()
  for (const addrs of Object.values(nets)) {
    for (const net of addrs) {
      if (net.internal || net.family !== 'IPv6') continue
      const lower = net.address.toLowerCase()
      if (lower === '::1') continue
      if (lower.startsWith('fe80:')) continue
      if (lower.startsWith('fd') || lower.startsWith('fc')) continue
      return net.address
    }
  }
  return null
}

/**
 * Start a mock HTTP server that responds with a specific WWW-Authenticate header.
 * Binds to :: (all interfaces) so it's reachable via public IPv6.
 */
function startMockL402Server(wwwAuthenticateValue) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      res.writeHead(402, { 'WWW-Authenticate': wwwAuthenticateValue })
      res.end()
    })
    server.listen(0, '::', () => {
      const port = server.address().port
      resolve({ server, port })
    })
    server.on('error', reject)
  })
}

function closeMockServer(server) {
  return new Promise(resolve => server.close(resolve))
}

describe('POST /api/v1/register — Macaroon/Invoice Validation', () => {
  const ipv6 = findPublicIpv6()
  let serverAvailable = false

  before(async () => {
    if (!ipv6) return
    // Check if 402index server is reachable
    try {
      const res = await fetch(`${BASE}/api/v1/services`, {
        signal: AbortSignal.timeout(3000),
      })
      serverAvailable = res.ok
    } catch {
      serverAvailable = false
    }
  })

  it('endpoint returns 402 + L402 with invalid macaroon → 422', async (t) => {
    if (!ipv6 || !serverAvailable) return t.skip('requires public IPv6 + running 402index server')

    const wwwAuth = `L402 token="probe", invoice="${VALID_INVOICE}"`
    const { server, port } = await startMockL402Server(wwwAuth)
    try {
      const url = `http://[${ipv6}]:${port}/api/${randomUUID()}`
      const r = await register({ url, name: 'Invalid Macaroon Test', protocol: 'L402' })
      assert.equal(r.status, 422, `expected 422, got ${r.status}: ${JSON.stringify(r.body)}`)
      assert.equal(r.body.error, 'L402 verification failed')
      assert.ok(
        r.body.detail.includes('macaroon') || r.body.detail.includes('token'),
        `detail should mention macaroon/token: ${r.body.detail}`
      )
      assert.equal(r.body.probe.hasMacaroon, false)
    } finally {
      await closeMockServer(server)
    }
  })

  it('endpoint returns 402 + L402 with valid macaroon but short invoice → 422', async (t) => {
    if (!ipv6 || !serverAvailable) return t.skip('requires public IPv6 + running 402index server')

    const wwwAuth = `L402 macaroon="${VALID_MACAROON}", invoice="${SHORT_INVOICE}"`
    const { server, port } = await startMockL402Server(wwwAuth)
    try {
      const url = `http://[${ipv6}]:${port}/api/${randomUUID()}`
      const r = await register({ url, name: 'Short Invoice Test', protocol: 'L402' })
      assert.equal(r.status, 422, `expected 422, got ${r.status}: ${JSON.stringify(r.body)}`)
      assert.equal(r.body.error, 'L402 verification failed')
      assert.ok(
        r.body.detail.includes('invoice') || r.body.detail.includes('short'),
        `detail should mention invoice: ${r.body.detail}`
      )
      assert.equal(r.body.probe.hasInvoice, false, 'hasInvoice must be false for short invoice (Gap 3)')
    } finally {
      await closeMockServer(server)
    }
  })

  it('endpoint returns 402 + L402 with valid macaroon and valid invoice → 201 (pending)', async (t) => {
    if (!ipv6 || !serverAvailable) return t.skip('requires public IPv6 + running 402index server')

    const wwwAuth = `L402 macaroon="${VALID_MACAROON}", invoice="${VALID_INVOICE}"`
    const { server, port } = await startMockL402Server(wwwAuth)
    try {
      const url = `http://[${ipv6}]:${port}/api/${randomUUID()}`
      const r = await register({ url, name: 'Valid L402 Test', protocol: 'L402' })
      assert.equal(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`)
      assert.equal(r.body.service.status, 'pending')
      assert.equal(r.body.verification.hasMacaroon, true)
      assert.equal(r.body.verification.hasInvoice, true)
    } finally {
      await closeMockServer(server)
    }
  })
})
