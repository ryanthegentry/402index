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
    const header = 'LSAT macaroon="dGVzdA==", invoice="lnbc500n1plegacyaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"'
    const result = parseWwwAuthenticate(header)
    assert.equal(result.scheme, 'LSAT')
    assert.equal(result.macaroon, 'dGVzdA==')
    assert.equal(result.invoice, 'lnbc500n1plegacyaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
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

  it('parses token= as macaroon (Ben Carman / mutinynet faucet style)', () => {
    const header = 'L402 token="AgELYmVuY2FybWFu", invoice="lnbc1000n1pjtestaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"'
    const result = parseWwwAuthenticate(header)
    assert.equal(result.scheme, 'L402')
    assert.equal(result.macaroon, 'AgELYmVuY2FybWFu')
    assert.ok(result.invoice.startsWith('lnbc'))
  })
})

describe('isValidMacaroon', () => {
  it('accepts valid base64 string', () => {
    assert.equal(isValidMacaroon('AgELYmVuY2FybWFuAhB0ZXN0'), true)
  })

  it('accepts base64url with padding', () => {
    assert.equal(isValidMacaroon('dGVzdF9tYWNhcm9vbg=='), true)
  })

  it('accepts JWT token with dots (Ben Carman / mutinynet style)', () => {
    const jwt = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJwYXltZW50X2hhc2giOiJjZGIzMjk3OTg2ZGYyZTk3MjYzMGY0M2FkZDQ1MTkxZjU4ZjE4ZTM3OTcwM2FmZDZkZjNkMWFiMDk3NGJlNDQzIn0.Vmh_HonFE-XTeUPamsO8B3EptcoQxzC-FEojRWOF7EA'
    assert.equal(isValidMacaroon(jwt), true)
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

// Generate a realistic-length invoice for testing (100+ chars, alphanumeric)
const longInvoice = (prefix) => prefix + 'a'.repeat(200)

describe('isValidInvoice', () => {
  it('accepts mainnet invoice (lnbc) with sufficient length', () => {
    assert.equal(isValidInvoice(longInvoice('lnbc1000n1pjtestaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')), true)
  })

  it('accepts testnet invoice (lntb) with sufficient length', () => {
    assert.equal(isValidInvoice(longInvoice('lntb500n1pjtest')), true)
  })

  it('accepts regtest invoice (lnbcrt) with sufficient length', () => {
    assert.equal(isValidInvoice(longInvoice('lnbcrt1000n1pjtest')), true)
  })

  it('accepts uppercase LNBC with sufficient length', () => {
    assert.equal(isValidInvoice(longInvoice('LNBC1000n1pjtest')), true)
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
    assert.equal(isValidInvoice('ltc1000n1p' + 'a'.repeat(200)), false)
  })

  it('rejects invoice shorter than 100 chars', () => {
    assert.equal(isValidInvoice('lnbc1000n1pjshort'), false)
  })

  it('rejects invoice with non-alphanumeric chars', () => {
    assert.equal(isValidInvoice('lnbc1000n1p' + '-'.repeat(100)), false)
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
      'www-authenticate': 'L402 macaroon="AgELYmVuY2FybWFu", invoice="lnbc1000n1pjtestaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
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
      'www-authenticate': 'LSAT macaroon="dGVzdF9tYWNhcm9vbg==", invoice="lntb500n1ptestaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
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

  it('returns valid=false when macaroon is missing', async () => {
    global.fetch = async () => mockResponse(402, {
      'www-authenticate': 'L402 invoice="lnbc1000n1pjtestaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
    })
    const result = await verifyL402('https://example.com/api')
    assert.equal(result.valid, false)
    assert.equal(result.hasMacaroon, false)
    assert.ok(result.error.includes('macaroon'), 'error should mention macaroon')
  })

  it('returns valid=false when invoice is missing', async () => {
    global.fetch = async () => mockResponse(402, {
      'www-authenticate': 'L402 macaroon="AgELYmVuY2FybWFu"',
    })
    const result = await verifyL402('https://example.com/api')
    assert.equal(result.valid, false)
    assert.equal(result.hasInvoice, false)
    assert.ok(result.error.includes('Invoice') || result.error.includes('invoice'), 'error should mention invoice')
  })

  it('follows a 307 redirect to a 402 endpoint', async () => {
    let callCount = 0
    global.fetch = async (url) => {
      callCount++
      if (callCount === 1) {
        return mockResponse(307, { 'location': 'https://www.example.com/api' })
      }
      return mockResponse(402, {
        'www-authenticate': 'L402 macaroon="AgELYmVuY2FybWFu", invoice="lnbc1000n1pjtestaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
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
        'www-authenticate': 'L402 macaroon="AgELYmVuY2FybWFu", invoice="lnbc1000n1pjtestaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
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

  it('passes probeBody to POST request instead of empty JSON', async () => {
    let capturedBody = null
    global.fetch = async (url, opts) => {
      capturedBody = opts.body
      return mockResponse(402, {
        'www-authenticate': 'L402 macaroon="AgELYmVuY2FybWFu", invoice="lnbc1000n1pjtestaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
      })
    }
    const probeBody = '{"model":"Standard","input":{"prompt":"test"}}'
    const result = await verifyL402('https://example.com/api', 'POST', probeBody)
    assert.equal(result.valid, true)
    assert.equal(capturedBody, probeBody)
  })

  it('uses empty JSON body when no probeBody is provided for POST', async () => {
    let capturedBody = null
    global.fetch = async (url, opts) => {
      capturedBody = opts.body
      return mockResponse(402, {
        'www-authenticate': 'L402 macaroon="AgELYmVuY2FybWFu", invoice="lnbc1000n1pjtestaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
      })
    }
    const result = await verifyL402('https://example.com/api', 'POST')
    assert.equal(result.valid, true)
    assert.equal(capturedBody, '{}')
  })

  it('returns valid=false when macaroon is invalid (too short, e.g. "probe")', async () => {
    global.fetch = async () => mockResponse(402, {
      'www-authenticate': 'L402 token="probe", invoice="lnbc1000n1pjtestaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
    })
    const result = await verifyL402('https://example.com/api')
    assert.equal(result.valid, false)
    assert.equal(result.hasMacaroon, false)
    assert.ok(result.error.includes('probe'), 'error should include actual token value for debugging')
    assert.ok(result.error.includes('5'), 'error should include token length')
  })

  it('returns valid=false when invoice is too short', async () => {
    global.fetch = async () => mockResponse(402, {
      'www-authenticate': 'L402 macaroon="AgELYmVuY2FybWFu", invoice="lnbc1234"',
    })
    const result = await verifyL402('https://example.com/api')
    assert.equal(result.valid, false)
    assert.equal(result.hasInvoice, false, 'hasInvoice must be false when invoice has valid prefix but is too short')
    assert.ok(result.error.includes('short') || result.error.includes('chars'), 'error should mention length issue')
  })

  it('returns valid=false when invoice has wrong prefix', async () => {
    const badInvoice = 'bc1' + 'a'.repeat(200)
    global.fetch = async () => mockResponse(402, {
      'www-authenticate': `L402 macaroon="AgELYmVuY2FybWFu", invoice="${badInvoice}"`,
    })
    const result = await verifyL402('https://example.com/api')
    assert.equal(result.valid, false)
    assert.equal(result.hasInvoice, false, 'hasInvoice must be false when invoice has wrong prefix')
    assert.ok(result.error.includes('prefix') || result.error.includes('lnbc'), 'error should mention BOLT11 prefix')
  })

  it('error includes actual macaroon value for provider debugging', async () => {
    global.fetch = async () => mockResponse(402, {
      'www-authenticate': 'L402 token="probe", invoice="lnbc1000n1pjtestaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
    })
    const result = await verifyL402('https://example.com/api')
    assert.equal(result.valid, false)
    assert.ok(result.error.includes('"probe"'), 'error should contain the quoted token value')
  })

  it('hasInvoice is true only when invoice is fully valid', async () => {
    global.fetch = async () => mockResponse(402, {
      'www-authenticate': 'L402 macaroon="AgELYmVuY2FybWFu", invoice="lnbc1000n1pjtestaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
    })
    const result = await verifyL402('https://example.com/api')
    assert.equal(result.valid, true)
    assert.equal(result.hasInvoice, true)
    assert.equal(result.hasMacaroon, true)
  })

  it('returns valid=true with token= field when token is valid base64', async () => {
    global.fetch = async () => mockResponse(402, {
      'www-authenticate': 'L402 token="MDAxM2xvY2F0aW9uIDMwLzE3", invoice="lnbc1000n1pjtestaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
    })
    const result = await verifyL402('https://example.com/api')
    assert.equal(result.valid, true)
    assert.equal(result.hasMacaroon, true)
    assert.equal(result.hasInvoice, true)
  })
})
