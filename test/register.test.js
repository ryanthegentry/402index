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
import { readFileSync } from 'node:fs'
import { startServer, stopServer } from './helpers/server.js'

let BASE = process.env.API_BASE
let API

before(async () => { BASE = BASE || await startServer(); API = `${BASE}/api/v1` })
after(async () => { await stopServer() })

async function register(body, extraHeaders = {}) {
  const res = await fetch(`${API}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
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

  it('accepts x402 protocol (passes validation, hits probe)', async () => {
    const r = await register({
      url: 'https://example.com/api',
      name: 'Test x402 Service',
      protocol: 'x402',
    })
    // 422 = passed validation, failed probe (example.com returns 200, not 402)
    assert.equal(r.status, 422, 'x402 should pass validation (not 400)')
    assert.ok(r.body.error.includes('x402'))
  })

  it('rejects "both" protocol → 400', async () => {
    const r = await register({
      url: 'https://example.com/api',
      name: 'Test',
      protocol: 'both',
    })
    assert.equal(r.status, 400)
    assert.ok(r.body.error.includes('Invalid protocol'))
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

describe('POST /api/v1/register — Probe Failures', { skip: process.env.CI ? 'requires external network' : false }, () => {
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

/**
 * Start a mock HTTP server that responds with x402 PAYMENT-REQUIRED header.
 */
function startMockX402Server(paymentRequiredB64, bodyJson) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const headers = { 'Content-Type': 'application/json' }
      if (paymentRequiredB64) headers['PAYMENT-REQUIRED'] = paymentRequiredB64
      res.writeHead(402, headers)
      res.end(bodyJson || '')
    })
    server.listen(0, '::', () => {
      const port = server.address().port
      resolve({ server, port })
    })
    server.on('error', reject)
  })
}

/**
 * Start a mock HTTP server that responds with MPP Payment challenge.
 */
function startMockMppServer(wwwAuthenticateValue) {
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

// ─── x402 Registration (mock x402 server) ────────────────────────────────────

const VALID_X402_ACCEPTS = [{
  payTo: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  amount: '10000',
  network: 'eip155:8453',
}]
const VALID_X402_HEADER_B64 = Buffer.from(JSON.stringify({ accepts: VALID_X402_ACCEPTS })).toString('base64')

describe('POST /api/v1/register — x402 Registration', () => {
  const ipv6 = findPublicIpv6()
  let serverAvailable = false

  before(async () => {
    if (!ipv6) return
    try {
      const res = await fetch(`${BASE}/api/v1/services`, { signal: AbortSignal.timeout(3000) })
      serverAvailable = res.ok
    } catch { serverAvailable = false }
  })

  it('accepts x402 protocol and probes for x402 payment headers → 201', async (t) => {
    if (!ipv6 || !serverAvailable) return t.skip('requires public IPv6 + running 402index server')

    const { server, port } = await startMockX402Server(VALID_X402_HEADER_B64)
    try {
      const url = `http://[${ipv6}]:${port}/api/${randomUUID()}`
      const r = await register({ url, name: 'Valid x402 Test', protocol: 'x402' })
      assert.equal(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`)
      assert.equal(r.body.service.protocol, 'x402')
      assert.ok(r.body.verification)
      assert.equal(r.body.verification.httpStatus, 402)
    } finally {
      await closeMockServer(server)
    }
  })

  it('returns 422 with x402-specific verification details when probe fails', async (t) => {
    if (!ipv6 || !serverAvailable) return t.skip('requires public IPv6 + running 402index server')

    // Server returns 402 but no PAYMENT-REQUIRED header and no body → invalid x402
    const { server, port } = await startMockX402Server(null, null)
    try {
      const url = `http://[${ipv6}]:${port}/api/${randomUUID()}`
      const r = await register({ url, name: 'Invalid x402 Test', protocol: 'x402' })
      assert.equal(r.status, 422, `expected 422, got ${r.status}: ${JSON.stringify(r.body)}`)
      assert.ok(r.body.error.includes('x402'))
    } finally {
      await closeMockServer(server)
    }
  })

  it('stores payment_asset and payment_network from x402 requirements', async (t) => {
    if (!ipv6 || !serverAvailable) return t.skip('requires public IPv6 + running 402index server')

    const { server, port } = await startMockX402Server(VALID_X402_HEADER_B64)
    try {
      const url = `http://[${ipv6}]:${port}/api/${randomUUID()}`
      const r = await register({
        url, name: 'x402 Asset Test', protocol: 'x402',
        payment_asset: 'USDC', payment_network: 'Base',
      })
      assert.equal(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`)
      assert.equal(r.body.service.payment_asset, 'USDC')
      assert.equal(r.body.service.payment_network, 'Base')
    } finally {
      await closeMockServer(server)
    }
  })

  it('case-insensitive protocol matching for x402', async () => {
    // Should pass validation and hit probe (which will fail on example.com → 422)
    const r = await register({
      url: 'https://example.com/api',
      name: 'Case Test x402',
      protocol: 'X402',
    })
    assert.equal(r.status, 422, 'uppercase X402 should pass validation (not 400)')
  })
})

// ─── MPP Registration (mock MPP server) ──────────────────────────────────────

const VALID_MPP_CHALLENGE = 'Payment id="test123", realm="test.example.com", method="tempo", intent="session", request="eyJ0ZXN0IjoxfQ", description="test payment", expires="2099-01-01T00:00:00Z"'

describe('POST /api/v1/register — MPP Registration', () => {
  const ipv6 = findPublicIpv6()
  let serverAvailable = false

  before(async () => {
    if (!ipv6) return
    try {
      const res = await fetch(`${BASE}/api/v1/services`, { signal: AbortSignal.timeout(3000) })
      serverAvailable = res.ok
    } catch { serverAvailable = false }
  })

  it('accepts MPP protocol and probes for Payment challenge → 201', async (t) => {
    if (!ipv6 || !serverAvailable) return t.skip('requires public IPv6 + running 402index server')

    const { server, port } = await startMockMppServer(VALID_MPP_CHALLENGE)
    try {
      const url = `http://[${ipv6}]:${port}/api/${randomUUID()}`
      const r = await register({ url, name: 'Valid MPP Test', protocol: 'MPP' })
      assert.equal(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`)
      assert.equal(r.body.service.protocol, 'MPP')
      assert.ok(r.body.verification)
      assert.equal(r.body.verification.httpStatus, 402)
    } finally {
      await closeMockServer(server)
    }
  })

  it('returns 422 with MPP-specific verification details when probe fails', async (t) => {
    if (!ipv6 || !serverAvailable) return t.skip('requires public IPv6 + running 402index server')

    // Payment challenge missing required 'intent' field
    const badChallenge = 'Payment id="x", realm="r", method="tempo", request="eyJ0ZXN0IjoxfQ"'
    const { server, port } = await startMockMppServer(badChallenge)
    try {
      const url = `http://[${ipv6}]:${port}/api/${randomUUID()}`
      const r = await register({ url, name: 'Invalid MPP Test', protocol: 'MPP' })
      assert.equal(r.status, 422, `expected 422, got ${r.status}: ${JSON.stringify(r.body)}`)
      assert.ok(r.body.error.includes('MPP'))
    } finally {
      await closeMockServer(server)
    }
  })

  it('validates MPP challenge has required fields', async (t) => {
    if (!ipv6 || !serverAvailable) return t.skip('requires public IPv6 + running 402index server')

    // Missing 'request' field
    const incompleteChallenge = 'Payment id="x", realm="r", method="tempo", intent="charge"'
    const { server, port } = await startMockMppServer(incompleteChallenge)
    try {
      const url = `http://[${ipv6}]:${port}/api/${randomUUID()}`
      const r = await register({ url, name: 'Incomplete MPP Test', protocol: 'MPP' })
      assert.equal(r.status, 422, `expected 422, got ${r.status}: ${JSON.stringify(r.body)}`)
      assert.ok(r.body.error.includes('MPP'))
    } finally {
      await closeMockServer(server)
    }
  })

  it('case-insensitive protocol matching for MPP', async () => {
    const r = await register({
      url: 'https://example.com/api',
      name: 'Case Test MPP',
      protocol: 'mpp',
    })
    assert.equal(r.status, 422, 'lowercase mpp should pass validation (not 400)')
  })
})

// ─── Protocol Dispatcher ─────────────────────────────────────────────────────

describe('POST /api/v1/register — Protocol Dispatcher', () => {
  it('dispatches L402 to correct verification', async () => {
    // L402 on example.com returns 200 (not 402) → 422 with L402 error
    const r = await register({
      url: 'https://example.com/api',
      name: 'L402 Dispatch Test',
      protocol: 'L402',
    })
    assert.equal(r.status, 422)
    assert.ok(r.body.error.includes('L402'))
  })

  it('dispatches x402 to correct verification', async () => {
    const r = await register({
      url: 'https://example.com/api',
      name: 'x402 Dispatch Test',
      protocol: 'x402',
    })
    assert.equal(r.status, 422)
    assert.ok(r.body.error.includes('x402'))
  })

  it('dispatches MPP to correct verification', async () => {
    const r = await register({
      url: 'https://example.com/api',
      name: 'MPP Dispatch Test',
      protocol: 'MPP',
    })
    assert.equal(r.status, 422)
    assert.ok(r.body.error.includes('MPP'))
  })

  it('returns 400 for unknown protocol', async () => {
    const r = await register({
      url: 'https://example.com/api',
      name: 'Unknown Protocol Test',
      protocol: 'BOLT12',
    })
    assert.equal(r.status, 400)
    assert.ok(r.body.error.includes('Invalid protocol'))
  })

  it('partner-gateway auto-approve works with valid secret', async (t) => {
    const ipv6 = findPublicIpv6()
    if (!ipv6) return t.skip('requires public IPv6')
    let serverAvailable = false
    try {
      const res = await fetch(`${BASE}/api/v1/services`, { signal: AbortSignal.timeout(3000) })
      serverAvailable = res.ok
    } catch { serverAvailable = false }
    if (!serverAvailable) return t.skip('requires running 402index server')

    const secret = process.env.PARTNER_GATEWAY_SECRET
    if (!secret) return t.skip('requires PARTNER_GATEWAY_SECRET env var')

    const wwwAuth = `L402 macaroon="${VALID_MACAROON}", invoice="${VALID_INVOICE}"`
    const { server, port } = await startMockL402Server(wwwAuth)
    try {
      const url = `http://[${ipv6}]:${port}/api/${randomUUID()}`
      const r = await register(
        { url, name: 'Partner Gateway Test', protocol: 'L402', provider: 'partner-gateway' },
        { 'x-partner-gateway-secret': secret }
      )
      assert.equal(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`)
      assert.equal(r.body.service.status, 'active')
    } finally {
      await closeMockServer(server)
    }
  })

  it('partner-gateway without secret header stays pending', async (t) => {
    const ipv6 = findPublicIpv6()
    if (!ipv6) return t.skip('requires public IPv6')
    let serverAvailable = false
    try {
      const res = await fetch(`${BASE}/api/v1/services`, { signal: AbortSignal.timeout(3000) })
      serverAvailable = res.ok
    } catch { serverAvailable = false }
    if (!serverAvailable) return t.skip('requires running 402index server')

    const secret = process.env.PARTNER_GATEWAY_SECRET
    if (!secret) return t.skip('requires PARTNER_GATEWAY_SECRET env var')

    const wwwAuth = `L402 macaroon="${VALID_MACAROON}", invoice="${VALID_INVOICE}"`
    const { server, port } = await startMockL402Server(wwwAuth)
    try {
      const url = `http://[${ipv6}]:${port}/api/${randomUUID()}`
      const r = await register(
        { url, name: 'Partner No Secret Test', protocol: 'L402', provider: 'partner-gateway' }
      )
      assert.equal(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`)
      assert.equal(r.body.service.status, 'pending', 'should NOT auto-approve without secret header')
    } finally {
      await closeMockServer(server)
    }
  })

  it('partner-gateway with wrong secret stays pending', async (t) => {
    const ipv6 = findPublicIpv6()
    if (!ipv6) return t.skip('requires public IPv6')
    let serverAvailable = false
    try {
      const res = await fetch(`${BASE}/api/v1/services`, { signal: AbortSignal.timeout(3000) })
      serverAvailable = res.ok
    } catch { serverAvailable = false }
    if (!serverAvailable) return t.skip('requires running 402index server')

    const secret = process.env.PARTNER_GATEWAY_SECRET
    if (!secret) return t.skip('requires PARTNER_GATEWAY_SECRET env var')

    const wwwAuth = `L402 macaroon="${VALID_MACAROON}", invoice="${VALID_INVOICE}"`
    const { server, port } = await startMockL402Server(wwwAuth)
    try {
      const url = `http://[${ipv6}]:${port}/api/${randomUUID()}`
      const r = await register(
        { url, name: 'Partner Wrong Secret Test', protocol: 'L402', provider: 'partner-gateway' },
        { 'x-partner-gateway-secret': 'wrong-secret-value' }
      )
      assert.equal(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`)
      assert.equal(r.body.service.status, 'pending', 'should NOT auto-approve with wrong secret')
    } finally {
      await closeMockServer(server)
    }
  })

  // ─── Timing-leak migration structural + behavioral regression (#156) ──

  it('structural: register route does not contain timingSafeEqual(', () => {
    const src = readFileSync(new URL('../src/routes/api/register.js', import.meta.url), 'utf8')
    assert.ok(!src.includes('timingSafeEqual('), 'timingSafeEqual( must be removed from register route')
  })

  it('structural: register route does not contain Length mismatch catch-clause comment', () => {
    const src = readFileSync(new URL('../src/routes/api/register.js', import.meta.url), 'utf8')
    assert.ok(!src.includes('Length mismatch'), 'catch-clause comment must be removed')
  })

  it('structural: register route uses constantTimeEqual(gatewaySecret, gatewayHeader)', () => {
    const src = readFileSync(new URL('../src/routes/api/register.js', import.meta.url), 'utf8')
    assert.ok(src.includes('constantTimeEqual(gatewaySecret, gatewayHeader)'), 'must use constantTimeEqual for gateway comparison')
  })

  it('behavioral: partner-gateway with short wrong secret returns 201 pending (not 500)', async (t) => {
    const ipv6 = findPublicIpv6()
    if (!ipv6) return t.skip('requires public IPv6')
    let serverAvailable = false
    try {
      const res = await fetch(`${BASE}/api/v1/services`, { signal: AbortSignal.timeout(3000) })
      serverAvailable = res.ok
    } catch { serverAvailable = false }
    if (!serverAvailable) return t.skip('requires running 402index server')

    const secret = process.env.PARTNER_GATEWAY_SECRET
    if (!secret) return t.skip('requires PARTNER_GATEWAY_SECRET env var')

    const wwwAuth = `L402 macaroon="${VALID_MACAROON}", invoice="${VALID_INVOICE}"`
    const { server, port } = await startMockL402Server(wwwAuth)
    try {
      const url = `http://[${ipv6}]:${port}/api/${randomUUID()}`
      const r = await register(
        { url, name: 'Partner Short Secret Test', protocol: 'L402', provider: 'partner-gateway' },
        { 'x-partner-gateway-secret': 'wrong' }
      )
      assert.equal(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`)
      assert.equal(r.body.service.status, 'pending', 'short wrong secret must not auto-approve')
    } finally {
      await closeMockServer(server)
    }
  })
})
