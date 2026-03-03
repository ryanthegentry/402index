import { describe, it, mock, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { parseWwwAuthenticate, isValidMacaroon, isValidInvoice, verifyL402 } from '../src/services/l402-verify.js'

describe('parseWwwAuthenticate', () => {
  it('parses standard L402 header with quoted values', () => {
    const header = 'L402 macaroon="AgELYmVuY2FybWFu", invoice="lnbc1000n1ptest"'
    const result = parseWwwAuthenticate(header)
    assert.equal(result.scheme, 'L402')
    assert.equal(result.macaroon, 'AgELYmVuY2FybWFu')
    assert.equal(result.invoice, 'lnbc1000n1ptest')
  })

  it('parses LSAT header (legacy scheme)', () => {
    const header = 'LSAT macaroon="dGVzdA==", invoice="lnbc500n1plegacy"'
    const result = parseWwwAuthenticate(header)
    assert.equal(result.scheme, 'LSAT')
    assert.equal(result.macaroon, 'dGVzdA==')
    assert.equal(result.invoice, 'lnbc500n1plegacy')
  })

  it('parses header with unquoted values', () => {
    const header = 'L402 macaroon=AgELYmVuY2FybWFu, invoice=lnbc1000n1ptest'
    const result = parseWwwAuthenticate(header)
    assert.equal(result.scheme, 'L402')
    assert.equal(result.macaroon, 'AgELYmVuY2FybWFu')
    assert.equal(result.invoice, 'lnbc1000n1ptest')
  })

  it('handles case-insensitive scheme matching', () => {
    const header = 'l402 macaroon="dGVzdA==", invoice="lnbc100n1p"'
    const result = parseWwwAuthenticate(header)
    assert.equal(result.scheme, 'L402')
  })

  it('returns nulls for null input', () => {
    const result = parseWwwAuthenticate(null)
    assert.equal(result.scheme, null)
    assert.equal(result.macaroon, null)
    assert.equal(result.invoice, null)
  })

  it('returns nulls for empty string', () => {
    const result = parseWwwAuthenticate('')
    assert.equal(result.scheme, null)
  })

  it('returns nulls for non-L402/LSAT scheme', () => {
    const result = parseWwwAuthenticate('Bearer token="abc123"')
    assert.equal(result.scheme, null)
    assert.equal(result.macaroon, null)
  })

  it('handles header with only scheme, no macaroon/invoice', () => {
    const header = 'L402'
    const result = parseWwwAuthenticate(header)
    assert.equal(result.scheme, 'L402')
    assert.equal(result.macaroon, null)
    assert.equal(result.invoice, null)
  })

  it('handles header with macaroon but no invoice', () => {
    const header = 'L402 macaroon="AgELYmVuY2FybWFu"'
    const result = parseWwwAuthenticate(header)
    assert.equal(result.scheme, 'L402')
    assert.equal(result.macaroon, 'AgELYmVuY2FybWFu')
    assert.equal(result.invoice, null)
  })
})

describe('isValidMacaroon', () => {
  it('accepts valid base64 string', () => {
    assert.equal(isValidMacaroon('AgELYmVuY2FybWFuAhB0ZXN0'), true)
  })

  it('accepts base64url with padding', () => {
    assert.equal(isValidMacaroon('dGVzdF9tYWNhcm9vbg=='), true)
  })

  it('rejects null', () => {
    assert.equal(isValidMacaroon(null), false)
  })

  it('rejects empty string', () => {
    assert.equal(isValidMacaroon(''), false)
  })

  it('rejects very short string', () => {
    assert.equal(isValidMacaroon('abc'), false)
  })

  it('rejects strings with invalid characters', () => {
    assert.equal(isValidMacaroon('mac@roon!bad#chars'), false)
  })
})

describe('isValidInvoice', () => {
  it('accepts mainnet invoice (lnbc)', () => {
    assert.equal(isValidInvoice('lnbc1000n1pjtest'), true)
  })

  it('accepts testnet invoice (lntb)', () => {
    assert.equal(isValidInvoice('lntb500n1pjtest'), true)
  })

  it('accepts regtest invoice (lnbcrt)', () => {
    assert.equal(isValidInvoice('lnbcrt1000n1pjtest'), true)
  })

  it('accepts uppercase LNBC', () => {
    assert.equal(isValidInvoice('LNBC1000n1pjtest'), true)
  })

  it('rejects null', () => {
    assert.equal(isValidInvoice(null), false)
  })

  it('rejects empty string', () => {
    assert.equal(isValidInvoice(''), false)
  })

  it('rejects non-invoice string', () => {
    assert.equal(isValidInvoice('not-an-invoice'), false)
  })

  it('rejects invoice with wrong prefix', () => {
    assert.equal(isValidInvoice('ltc1000n1p'), false)
  })
})

// Helper: create a mock Response
function mockResponse(status, headers = {}) {
  return {
    status,
    headers: {
      get(name) { return headers[name.toLowerCase()] || null },
    },
  }
}

describe('verifyL402', () => {
  let originalFetch

  beforeEach(() => {
    originalFetch = global.fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('returns valid for proper L402 response (402 + WWW-Authenticate)', async () => {
    global.fetch = async () => mockResponse(402, {
      'www-authenticate': 'L402 macaroon="AgELYmVuY2FybWFu", invoice="lnbc1000n1pjtest"',
    })
    // verifyL402 calls resolveAndCheck which does DNS lookup — use a real public domain
    const result = await verifyL402('https://example.com/api')
    assert.equal(result.valid, true)
    assert.equal(result.httpStatus, 402)
    assert.equal(result.hasWwwAuthenticate, true)
    assert.equal(result.scheme, 'L402')
    assert.equal(result.hasMacaroon, true)
    assert.equal(result.hasInvoice, true)
  })

  it('returns valid for LSAT scheme', async () => {
    global.fetch = async () => mockResponse(402, {
      'www-authenticate': 'LSAT macaroon="dGVzdA==", invoice="lntb500n1ptest"',
    })
    const result = await verifyL402('https://example.com/api')
    assert.equal(result.valid, true)
    assert.equal(result.scheme, 'LSAT')
  })

  it('fails when endpoint returns 200 instead of 402', async () => {
    global.fetch = async () => mockResponse(200)
    const result = await verifyL402('https://example.com/api')
    assert.equal(result.valid, false)
    assert.equal(result.httpStatus, 200)
    assert.ok(result.error.includes('200'))
    assert.ok(result.error.includes('402'))
  })

  it('fails when endpoint returns 402 without WWW-Authenticate header', async () => {
    global.fetch = async () => mockResponse(402)
    const result = await verifyL402('https://example.com/api')
    assert.equal(result.valid, false)
    assert.equal(result.httpStatus, 402)
    assert.ok(result.error.includes('WWW-Authenticate'))
  })

  it('fails when WWW-Authenticate uses non-L402 scheme', async () => {
    global.fetch = async () => mockResponse(402, {
      'www-authenticate': 'Bearer realm="api"',
    })
    const result = await verifyL402('https://example.com/api')
    assert.equal(result.valid, false)
    assert.equal(result.hasWwwAuthenticate, true)
    assert.ok(result.error.includes('scheme'))
  })

  it('fails for connection timeout', async () => {
    global.fetch = async () => {
      const err = new Error('timeout')
      err.name = 'TimeoutError'
      throw err
    }
    const result = await verifyL402('https://example.com/api')
    assert.equal(result.valid, false)
    assert.ok(result.error.includes('timed out'))
  })

  it('fails for connection error', async () => {
    global.fetch = async () => {
      throw new Error('ECONNREFUSED')
    }
    const result = await verifyL402('https://example.com/api')
    assert.equal(result.valid, false)
    assert.ok(result.error.includes('ECONNREFUSED'))
  })

  it('blocks non-http scheme', async () => {
    const result = await verifyL402('ftp://example.com/file')
    assert.equal(result.valid, false)
    assert.ok(result.error.includes('http'))
  })

  it('blocks private IP (SSRF protection)', async () => {
    const result = await verifyL402('https://127.0.0.1/api')
    assert.equal(result.valid, false)
    assert.ok(result.error.includes('private') || result.error.includes('blocked'))
  })

  it('returns valid=true with hasMacaroon=false when macaroon is missing', async () => {
    global.fetch = async () => mockResponse(402, {
      'www-authenticate': 'L402 invoice="lnbc1000n1pjtest"',
    })
    const result = await verifyL402('https://example.com/api')
    assert.equal(result.valid, true)
    assert.equal(result.hasMacaroon, false)
    assert.equal(result.hasInvoice, true)
  })

  it('returns valid=true with hasInvoice=false when invoice is missing', async () => {
    global.fetch = async () => mockResponse(402, {
      'www-authenticate': 'L402 macaroon="AgELYmVuY2FybWFu"',
    })
    const result = await verifyL402('https://example.com/api')
    assert.equal(result.valid, true)
    assert.equal(result.hasInvoice, false)
    assert.equal(result.hasMacaroon, true)
  })

  it('follows a 307 redirect to a 402 endpoint', async () => {
    let callCount = 0
    global.fetch = async (url) => {
      callCount++
      if (callCount === 1) {
        return mockResponse(307, { 'location': 'https://www.example.com/api' })
      }
      return mockResponse(402, {
        'www-authenticate': 'L402 macaroon="AgELYmVuY2FybWFu", invoice="lnbc1000n1pjtest"',
      })
    }
    const result = await verifyL402('https://example.com/api')
    assert.equal(result.valid, true)
    assert.equal(result.httpStatus, 402)
    assert.equal(callCount, 2)
  })

  it('follows 301 redirect to a 402 endpoint', async () => {
    let callCount = 0
    global.fetch = async () => {
      callCount++
      if (callCount === 1) {
        return mockResponse(301, { 'location': 'https://example.com/redirected' })
      }
      return mockResponse(402, {
        'www-authenticate': 'L402 macaroon="AgELYmVuY2FybWFu", invoice="lnbc1000n1pjtest"',
      })
    }
    const result = await verifyL402('https://example.com/api')
    assert.equal(result.valid, true)
    assert.equal(callCount, 2)
  })

  it('fails with too many redirects (>3)', async () => {
    global.fetch = async () => mockResponse(307, { 'location': 'https://example.com/loop' })
    const result = await verifyL402('https://example.com/api')
    assert.equal(result.valid, false)
    assert.ok(result.error.includes('Too many redirects'))
  })

  it('blocks redirect to private IP (SSRF on hop)', async () => {
    global.fetch = async () => mockResponse(307, { 'location': 'https://127.0.0.1/internal' })
    const result = await verifyL402('https://example.com/api')
    assert.equal(result.valid, false)
    assert.ok(result.error.includes('private') || result.error.includes('blocked'))
  })

  it('fails when redirect has no Location header', async () => {
    global.fetch = async () => mockResponse(307)
    const result = await verifyL402('https://example.com/api')
    assert.equal(result.valid, false)
    assert.ok(result.error.includes('Location'))
  })
})
