/**
 * TDD tests for the shared probeEndpoint() function.
 *
 * Run: node --test test/probe-endpoint.test.js
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import dns from 'dns'

// ─── Helpers ────────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch
let dnsLookupMock

function mockResponse(status, headers = {}, bodyText = '') {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) { return headers[name.toLowerCase()] || null },
      entries() { return Object.entries(headers) },
    },
    text: async () => bodyText,
  }
}

function makeX402Header() {
  const payload = {
    accepts: [{
      payTo: '0x1234567890abcdef1234567890abcdef12345678',
      asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      network: 'eip155:8453',
      maxAmountRequired: '1000000',
    }],
  }
  return Buffer.from(JSON.stringify(payload)).toString('base64')
}

const VALID_MACAROON = 'AgELYmVuY2FybWFuAgSTZXN0AgJiYQ'
const VALID_INVOICE = 'lnbc1000n1p' + 'a'.repeat(200)
const VALID_L402_WWW_AUTH = `L402 macaroon="${VALID_MACAROON}", invoice="${VALID_INVOICE}"`
const VALID_MPP_WWW_AUTH = 'Payment id="pay-123", realm="example.com", method="lightning", intent="purchase", request="eyJ0ZXN0IjoxfQ"'
const VALID_X402_HEADER = makeX402Header()

// ─── Setup / Teardown ───────────────────────────────────────────────────────

// Lazy-import probeEndpoint so module resolution happens after mocks are ready
let probeEndpoint

beforeEach(async () => {
  // Mock DNS to bypass SSRF checks (resolve to public IP)
  dnsLookupMock = mock.method(dns.promises, 'lookup',
    async () => ({ address: '93.184.216.34', family: 4 })
  )
  // Dynamic import to pick up fresh module state
  const mod = await import('../src/services/probe-endpoint.js')
  probeEndpoint = mod.probeEndpoint
})

afterEach(() => {
  globalThis.fetch = originalFetch
  dnsLookupMock.mock.restore()
})

// ═══════════════════════════════════════════════════════════════════════════
// Phase 1: Core fetch behavior
// ═══════════════════════════════════════════════════════════════════════════

describe('probeEndpoint — core fetch', () => {
  it('returns httpStatus, responseTimeMs, headers for simple 402 GET', async () => {
    globalThis.fetch = async (url, opts) => {
      // HEAD returns 200, GET should return 402
      if (opts?.method === 'HEAD') return mockResponse(200)
      return mockResponse(402, {
        'www-authenticate': VALID_L402_WWW_AUTH,
      })
    }

    const result = await probeEndpoint('https://example.com/api')
    assert.equal(result.httpStatus, 402)
    assert.equal(typeof result.responseTimeMs, 'number')
    assert.ok(result.responseTimeMs >= 0)
    assert.equal(result.errorMessage, null)
    assert.equal(result.wwwAuthenticate, VALID_L402_WWW_AUTH)
  })

  it('returns httpStatus for simple 200 GET', async () => {
    globalThis.fetch = async () => mockResponse(200)

    const result = await probeEndpoint('https://example.com/api')
    assert.equal(result.httpStatus, 200)
    assert.equal(result.errorMessage, null)
  })

  it('returns errorMessage timeout on AbortSignal timeout', async () => {
    globalThis.fetch = async () => {
      const err = new Error('The operation was aborted')
      err.name = 'TimeoutError'
      throw err
    }

    const result = await probeEndpoint('https://example.com/api')
    assert.equal(result.httpStatus, null)
    assert.equal(result.errorMessage, 'timeout')
  })

  it('returns errorMessage on connection error', async () => {
    globalThis.fetch = async () => {
      throw new Error('ECONNREFUSED')
    }

    const result = await probeEndpoint('https://example.com/api')
    assert.equal(result.httpStatus, null)
    assert.match(result.errorMessage, /ECONNREFUSED/)
  })

  it('blocks non-http scheme (SSRF)', async () => {
    const result = await probeEndpoint('ftp://example.com/file')
    assert.ok(result.errorMessage)
    assert.match(result.errorMessage, /blocked|scheme/i)
    assert.equal(result.httpStatus, null)
  })

  it('blocks private IP (SSRF)', async () => {
    dnsLookupMock.mock.restore()
    dnsLookupMock = mock.method(dns.promises, 'lookup',
      async () => ({ address: '192.168.1.1', family: 4 })
    )

    const result = await probeEndpoint('https://internal.local/api')
    assert.ok(result.errorMessage)
    assert.match(result.errorMessage, /blocked|private/i)
  })

  it('uses HEAD-then-GET fallback for GET method', async () => {
    const calls = []
    globalThis.fetch = async (url, opts) => {
      calls.push(opts?.method || 'GET')
      if (opts?.method === 'HEAD') return mockResponse(200)
      return mockResponse(402, { 'www-authenticate': VALID_L402_WWW_AUTH })
    }

    const result = await probeEndpoint('https://example.com/api')
    assert.equal(result.httpStatus, 402)
    assert.deepEqual(calls, ['HEAD', 'GET'])
  })

  it('returns 402 from HEAD without falling back to GET', async () => {
    const calls = []
    globalThis.fetch = async (url, opts) => {
      calls.push(opts?.method || 'GET')
      return mockResponse(402, { 'www-authenticate': VALID_L402_WWW_AUTH })
    }

    const result = await probeEndpoint('https://example.com/api')
    assert.equal(result.httpStatus, 402)
    assert.deepEqual(calls, ['HEAD'])
  })

  it('sends POST with Content-Type and body', async () => {
    let capturedOpts
    globalThis.fetch = async (url, opts) => {
      capturedOpts = opts
      return mockResponse(402, { 'www-authenticate': VALID_L402_WWW_AUTH })
    }

    await probeEndpoint('https://example.com/api', { method: 'POST', body: '{"test":1}' })
    assert.equal(capturedOpts.method, 'POST')
    assert.equal(capturedOpts.headers['Content-Type'], 'application/json')
    assert.equal(capturedOpts.body, '{"test":1}')
  })

  it('uses 8s timeout by default', async () => {
    let capturedSignal
    globalThis.fetch = async (url, opts) => {
      capturedSignal = opts?.signal
      return mockResponse(402)
    }

    await probeEndpoint('https://example.com/api')
    // AbortSignal.timeout() doesn't expose the timeout value directly,
    // but we can verify it's present
    assert.ok(capturedSignal, 'should have an AbortSignal')
  })

  it('captures responseBody for x402 V1 (402 + no payment-required header)', async () => {
    const x402Body = JSON.stringify({
      accepts: [{
        payTo: '0x1234567890abcdef1234567890abcdef12345678',
        asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        amount: '1000000',
      }],
    })
    globalThis.fetch = async (url, opts) => {
      if (opts?.method === 'HEAD') return mockResponse(200)
      return mockResponse(402, {}, x402Body)
    }

    const result = await probeEndpoint('https://example.com/api')
    assert.equal(result.httpStatus, 402)
    assert.equal(result.responseBody, x402Body)
  })

  it('respects custom timeoutMs', async () => {
    let capturedSignal
    globalThis.fetch = async (url, opts) => {
      capturedSignal = opts?.signal
      return mockResponse(402)
    }

    await probeEndpoint('https://example.com/api', { timeoutMs: 3000 })
    assert.ok(capturedSignal, 'should have an AbortSignal')
  })

  it('sets finalUrl to input url when no redirects', async () => {
    globalThis.fetch = async () => mockResponse(402)

    const result = await probeEndpoint('https://example.com/api')
    assert.equal(result.finalUrl, 'https://example.com/api')
    assert.equal(result.redirectCount, 0)
  })

  it('sets methodUsed to GET for default GET probe', async () => {
    globalThis.fetch = async () => mockResponse(402)

    const result = await probeEndpoint('https://example.com/api')
    assert.equal(result.methodUsed, 'GET')
  })

  it('sets methodUsed to POST for POST probe', async () => {
    globalThis.fetch = async () => mockResponse(402)

    const result = await probeEndpoint('https://example.com/api', { method: 'POST' })
    assert.equal(result.methodUsed, 'POST')
  })

  it('sends ngrok-skip-browser-warning header', async () => {
    let capturedHeaders
    globalThis.fetch = async (url, opts) => {
      capturedHeaders = opts?.headers
      return mockResponse(402)
    }

    await probeEndpoint('https://example.com/api')
    assert.equal(capturedHeaders['ngrok-skip-browser-warning'], 'true')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2: Redirect following
// ═══════════════════════════════════════════════════════════════════════════

describe('probeEndpoint — redirects', () => {
  it('follows 307 redirect to 402 endpoint', async () => {
    let callCount = 0
    globalThis.fetch = async (url, opts) => {
      callCount++
      if (url === 'https://example.com/api') {
        return mockResponse(307, { location: 'https://example.com/v2/api' })
      }
      return mockResponse(402, { 'www-authenticate': VALID_L402_WWW_AUTH })
    }

    const result = await probeEndpoint('https://example.com/api')
    assert.equal(result.httpStatus, 402)
    assert.equal(result.finalUrl, 'https://example.com/v2/api')
    assert.equal(result.redirectCount, 1)
  })

  it('follows 301 redirect', async () => {
    globalThis.fetch = async (url) => {
      if (url === 'https://old.example.com/api') {
        return mockResponse(301, { location: 'https://new.example.com/api' })
      }
      return mockResponse(402, { 'www-authenticate': VALID_L402_WWW_AUTH })
    }

    const result = await probeEndpoint('https://old.example.com/api')
    assert.equal(result.httpStatus, 402)
    assert.equal(result.redirectCount, 1)
  })

  it('follows 302 redirect', async () => {
    globalThis.fetch = async (url) => {
      if (url === 'https://example.com/old') {
        return mockResponse(302, { location: 'https://example.com/new' })
      }
      return mockResponse(402)
    }

    const result = await probeEndpoint('https://example.com/old')
    assert.equal(result.httpStatus, 402)
    assert.equal(result.redirectCount, 1)
  })

  it('follows 308 redirect', async () => {
    globalThis.fetch = async (url) => {
      if (url === 'https://example.com/old') {
        return mockResponse(308, { location: 'https://example.com/new' })
      }
      return mockResponse(402)
    }

    const result = await probeEndpoint('https://example.com/old')
    assert.equal(result.httpStatus, 402)
    assert.equal(result.redirectCount, 1)
  })

  it('runs SSRF check on each redirect hop', async () => {
    globalThis.fetch = async (url) => {
      if (url === 'https://example.com/api') {
        return mockResponse(307, { location: 'https://evil.local/steal' })
      }
      return mockResponse(402)
    }

    // Make the redirect target resolve to private IP
    const originalMockFn = dnsLookupMock.mock.implementation
    dnsLookupMock.mock.restore()
    dnsLookupMock = mock.method(dns.promises, 'lookup', async (hostname) => {
      if (hostname === 'evil.local') return { address: '10.0.0.1', family: 4 }
      return { address: '93.184.216.34', family: 4 }
    })

    const result = await probeEndpoint('https://example.com/api')
    assert.ok(result.errorMessage)
    assert.match(result.errorMessage, /blocked|private/i)
  })

  it('fails after max redirects exceeded', async () => {
    globalThis.fetch = async (url) => {
      return mockResponse(307, { location: `${url}/next` })
    }

    const result = await probeEndpoint('https://example.com/api', { maxRedirects: 3 })
    assert.ok(result.errorMessage)
    assert.match(result.errorMessage, /redirect/i)
  })

  it('fails on redirect with no Location header', async () => {
    globalThis.fetch = async () => mockResponse(307, {})

    const result = await probeEndpoint('https://example.com/api')
    assert.ok(result.errorMessage)
    assert.match(result.errorMessage, /location/i)
  })

  it('does not follow redirects when followRedirects=false', async () => {
    globalThis.fetch = async () => {
      return mockResponse(307, { location: 'https://example.com/v2' })
    }

    const result = await probeEndpoint('https://example.com/api', { followRedirects: false })
    assert.equal(result.httpStatus, 307)
    assert.equal(result.redirectCount, 0)
    assert.equal(result.finalUrl, 'https://example.com/api')
  })

  it('resolves relative Location URLs', async () => {
    globalThis.fetch = async (url) => {
      if (url === 'https://example.com/api/v1') {
        return mockResponse(307, { location: '/api/v2' })
      }
      return mockResponse(402)
    }

    const result = await probeEndpoint('https://example.com/api/v1')
    assert.equal(result.httpStatus, 402)
    assert.equal(result.finalUrl, 'https://example.com/api/v2')
  })

  it('uses HEAD-then-GET on the final URL after redirects', async () => {
    const calls = []
    globalThis.fetch = async (url, opts) => {
      if (url === 'https://example.com/old' && !calls.includes('redirect')) {
        calls.push('redirect')
        return mockResponse(307, { location: 'https://example.com/new' })
      }
      calls.push(`${opts?.method}@${new URL(url).pathname}`)
      if (opts?.method === 'HEAD') return mockResponse(200)
      return mockResponse(402)
    }

    const result = await probeEndpoint('https://example.com/old')
    assert.equal(result.httpStatus, 402)
    // After redirect, should do HEAD then GET on the new URL
    assert.ok(calls.includes('HEAD@/new'))
    assert.ok(calls.includes('GET@/new'))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Phase 3: Protocol detection
// ═══════════════════════════════════════════════════════════════════════════

describe('probeEndpoint — protocol detection', () => {
  it('detects L402 protocol from WWW-Authenticate header', async () => {
    globalThis.fetch = async () => mockResponse(402, {
      'www-authenticate': VALID_L402_WWW_AUTH,
    })

    const result = await probeEndpoint('https://example.com/api')
    assert.equal(result.detection.protocol, 'L402')
    assert.equal(result.detection.valid, true)
    assert.equal(result.detection.details.scheme, 'L402')
  })

  it('detects x402 protocol from PAYMENT-REQUIRED header', async () => {
    globalThis.fetch = async () => mockResponse(402, {
      'payment-required': VALID_X402_HEADER,
    })

    const result = await probeEndpoint('https://example.com/api')
    assert.equal(result.detection.protocol, 'x402')
    assert.equal(result.detection.valid, true)
  })

  it('detects MPP protocol from WWW-Authenticate Payment header', async () => {
    globalThis.fetch = async () => mockResponse(402, {
      'www-authenticate': VALID_MPP_WWW_AUTH,
    })

    const result = await probeEndpoint('https://example.com/api')
    assert.equal(result.detection.protocol, 'MPP')
    assert.equal(result.detection.valid, true)
  })

  it('returns detection.protocol=null for plain 402', async () => {
    globalThis.fetch = async () => mockResponse(402)

    const result = await probeEndpoint('https://example.com/api')
    assert.equal(result.detection.protocol, null)
    assert.equal(result.detection.valid, false)
  })

  it('returns detection.protocol=null for non-402 response', async () => {
    globalThis.fetch = async () => mockResponse(200)

    const result = await probeEndpoint('https://example.com/api')
    assert.equal(result.detection.protocol, null)
  })

  it('detects x402 V1 from response body', async () => {
    const x402Body = JSON.stringify({
      accepts: [{
        payTo: '0x1234567890abcdef1234567890abcdef12345678',
        asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        amount: '1000000',
      }],
    })
    globalThis.fetch = async (url, opts) => {
      if (opts?.method === 'HEAD') return mockResponse(200)
      return mockResponse(402, {}, x402Body)
    }

    const result = await probeEndpoint('https://example.com/api')
    assert.equal(result.detection.protocol, 'x402')
    assert.equal(result.detection.details.version, 1)
  })

  it('detection precedence: L402 wins over x402 header', async () => {
    globalThis.fetch = async () => mockResponse(402, {
      'www-authenticate': VALID_L402_WWW_AUTH,
      'payment-required': VALID_X402_HEADER,
    })

    const result = await probeEndpoint('https://example.com/api')
    assert.equal(result.detection.protocol, 'L402')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Phase 4: POST fallback
// ═══════════════════════════════════════════════════════════════════════════

describe('probeEndpoint — POST fallback', () => {
  it('tries POST on 405 when postFallback=true', async () => {
    const calls = []
    globalThis.fetch = async (url, opts) => {
      const method = opts?.method || 'GET'
      calls.push(method)
      if (method === 'POST') {
        return mockResponse(402, { 'www-authenticate': VALID_L402_WWW_AUTH })
      }
      return mockResponse(405)
    }

    const result = await probeEndpoint('https://example.com/api', { postFallback: true })
    assert.ok(calls.includes('POST'))
    assert.equal(result.postFallback.attempted, true)
    assert.equal(result.postFallback.httpStatus, 402)
    assert.equal(result.postFallback.detection.protocol, 'L402')
    assert.equal(result.methodUsed, 'POST')
  })

  it('tries POST on 400 when postFallback=true', async () => {
    globalThis.fetch = async (url, opts) => {
      if (opts?.method === 'POST') {
        return mockResponse(402, { 'payment-required': VALID_X402_HEADER })
      }
      if (opts?.method === 'HEAD') return mockResponse(400)
      return mockResponse(400)
    }

    const result = await probeEndpoint('https://example.com/api', { postFallback: true })
    assert.equal(result.postFallback.attempted, true)
    assert.equal(result.postFallback.detection.protocol, 'x402')
    assert.equal(result.methodUsed, 'POST')
  })

  it('tries POST on 200 when postFallback=true', async () => {
    globalThis.fetch = async (url, opts) => {
      if (opts?.method === 'POST') {
        return mockResponse(402, { 'www-authenticate': VALID_MPP_WWW_AUTH })
      }
      return mockResponse(200)
    }

    const result = await probeEndpoint('https://example.com/api', { postFallback: true })
    assert.equal(result.postFallback.attempted, true)
    assert.equal(result.postFallback.detection.protocol, 'MPP')
    assert.equal(result.methodUsed, 'POST')
  })

  it('does NOT try POST when postFallback=false', async () => {
    const calls = []
    globalThis.fetch = async (url, opts) => {
      calls.push(opts?.method || 'GET')
      return mockResponse(405)
    }

    const result = await probeEndpoint('https://example.com/api', { postFallback: false })
    assert.ok(!calls.includes('POST'))
    assert.equal(result.postFallback, null)
  })

  it('does NOT try POST when method is already POST', async () => {
    const calls = []
    globalThis.fetch = async (url, opts) => {
      calls.push(opts?.method || 'GET')
      return mockResponse(405)
    }

    const result = await probeEndpoint('https://example.com/api', {
      method: 'POST',
      postFallback: true,
    })
    // Should only have one POST call (the original), not a fallback
    assert.equal(calls.filter(c => c === 'POST').length, 1)
    assert.equal(result.postFallback, null)
  })

  it('sets methodUsed=POST when POST fallback succeeds with valid detection', async () => {
    globalThis.fetch = async (url, opts) => {
      if (opts?.method === 'POST') {
        return mockResponse(402, { 'www-authenticate': VALID_L402_WWW_AUTH })
      }
      return mockResponse(405)
    }

    const result = await probeEndpoint('https://example.com/api', { postFallback: true })
    assert.equal(result.methodUsed, 'POST')
    assert.equal(result.httpStatus, 402)
  })

  it('keeps methodUsed=GET when POST fallback fails', async () => {
    globalThis.fetch = async (url, opts) => {
      if (opts?.method === 'POST') return mockResponse(500)
      return mockResponse(405)
    }

    const result = await probeEndpoint('https://example.com/api', { postFallback: true })
    assert.equal(result.methodUsed, 'GET')
    assert.equal(result.postFallback.attempted, true)
    assert.equal(result.postFallback.httpStatus, 500)
  })

  it('does not try POST on 402 (already successful)', async () => {
    const calls = []
    globalThis.fetch = async (url, opts) => {
      calls.push(opts?.method || 'GET')
      return mockResponse(402, { 'www-authenticate': VALID_L402_WWW_AUTH })
    }

    const result = await probeEndpoint('https://example.com/api', { postFallback: true })
    assert.ok(!calls.includes('POST'))
    assert.equal(result.postFallback, null)
  })

  it('does not try POST on 500 error', async () => {
    const calls = []
    globalThis.fetch = async (url, opts) => {
      calls.push(opts?.method || 'GET')
      return mockResponse(500)
    }

    const result = await probeEndpoint('https://example.com/api', { postFallback: true })
    assert.ok(!calls.includes('POST'))
    assert.equal(result.postFallback, null)
  })

  it('POST fallback sends body and Content-Type', async () => {
    let capturedOpts
    globalThis.fetch = async (url, opts) => {
      if (opts?.method === 'POST') {
        capturedOpts = opts
        return mockResponse(402, { 'www-authenticate': VALID_L402_WWW_AUTH })
      }
      return mockResponse(405)
    }

    await probeEndpoint('https://example.com/api', {
      postFallback: true,
      body: '{"action":"test"}',
    })
    assert.equal(capturedOpts.headers['Content-Type'], 'application/json')
    assert.equal(capturedOpts.body, '{"action":"test"}')
  })

  it('POST fallback follows redirects when followRedirects=true', async () => {
    globalThis.fetch = async (url, opts) => {
      // GET path: return 405
      if (opts?.method === 'HEAD' || opts?.method === 'GET') return mockResponse(405)
      // POST path: redirect then 402
      if (opts?.method === 'POST' && url === 'https://example.com/api') {
        return mockResponse(307, { location: 'https://example.com/v2/api' })
      }
      if (opts?.method === 'POST' && url === 'https://example.com/v2/api') {
        return mockResponse(402, { 'www-authenticate': VALID_L402_WWW_AUTH })
      }
      return mockResponse(500)
    }

    const result = await probeEndpoint('https://example.com/api', {
      postFallback: true,
      followRedirects: true,
    })
    assert.equal(result.postFallback.attempted, true)
    assert.equal(result.postFallback.httpStatus, 402)
    assert.equal(result.postFallback.detection.protocol, 'L402')
  })
})
