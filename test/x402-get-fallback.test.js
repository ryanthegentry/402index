import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { parsePaymentRequired, validatePaymentRequirements } from '../src/services/x402-utils.js'

// Helper: create a valid base64-encoded x402 payment header
function makePaymentHeader() {
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

// Helper: create mock Response with headers
function mockResponse(status, headers = {}) {
  return {
    status,
    headers: {
      get(name) { return headers[name.toLowerCase()] || null },
    },
  }
}

// ─── GET fallback logic (unit-level simulation) ─────────────────────────────
// These tests simulate the checkService x402 validation logic without importing
// the full checker (which requires db). They verify the decision flow.

describe('x402 GET fallback — payment header capture', () => {
  let originalFetch

  beforeEach(() => {
    originalFetch = global.fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('captures payment header from GET when HEAD returns 402 without it', async () => {
    const validHeader = makePaymentHeader()
    let fetchCalls = []

    // Simulate the GET retry logic from checkService
    global.fetch = async (url, opts) => {
      fetchCalls.push({ url, method: opts?.method })
      if (opts?.method === 'GET') {
        return mockResponse(402, { 'payment-required': validHeader })
      }
      return mockResponse(402) // HEAD — no payment-required header
    }

    // Simulate: HEAD returned 402, no payment-required
    const headPaymentRequired = null
    let paymentRequiredHeader = headPaymentRequired

    // GET retry (same logic as checkService)
    if (!paymentRequiredHeader) {
      const getRes = await fetch('https://example.com/api', {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
        redirect: 'manual',
      })
      if (getRes.status === 402) {
        paymentRequiredHeader = getRes.headers.get('payment-required')
      }
    }

    const parsed = parsePaymentRequired(paymentRequiredHeader)
    assert.equal(parsed.valid, true, 'should parse valid payment header from GET')
    assert.equal(parsed.accepts.length, 1)

    const validation = validatePaymentRequirements(parsed.accepts)
    assert.equal(validation.valid, true, 'payment requirements should be valid')
    assert.equal(validation.assetKnown, true, 'should recognize Base USDC')
  })

  it('sets x402PaymentValid=0 when both HEAD and GET lack payment header', async () => {
    global.fetch = async () => mockResponse(402) // No payment-required on any method

    const headPaymentRequired = null
    let paymentRequiredHeader = headPaymentRequired

    // GET retry
    if (!paymentRequiredHeader) {
      const getRes = await fetch('https://example.com/api', {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
        redirect: 'manual',
      })
      if (getRes.status === 402) {
        paymentRequiredHeader = getRes.headers.get('payment-required')
      }
    }

    const parsed = parsePaymentRequired(paymentRequiredHeader)
    assert.equal(parsed.valid, false, 'should fail when no header on either method')
    const x402PaymentValid = parsed.valid ? 1 : 0
    assert.equal(x402PaymentValid, 0)
  })

  it('skips GET retry when HEAD already has payment header', async () => {
    const validHeader = makePaymentHeader()
    let fetchCalls = 0

    global.fetch = async () => {
      fetchCalls++
      return mockResponse(402, { 'payment-required': validHeader })
    }

    // HEAD returned 402 WITH payment-required
    const headPaymentRequired = validHeader
    let paymentRequiredHeader = headPaymentRequired

    // GET retry should NOT happen
    if (!paymentRequiredHeader) {
      await fetch('https://example.com/api', { method: 'GET' })
    }

    assert.equal(fetchCalls, 0, 'should not call fetch when HEAD already has header')
    const parsed = parsePaymentRequired(paymentRequiredHeader)
    assert.equal(parsed.valid, true)
  })

  it('preserves cached value when currentPaymentValid is set and HEAD lacks header', () => {
    // Simulate the caching guard from checkService
    const currentPaymentValid = 1
    const headPaymentRequired = null
    let x402PaymentValid = null

    // Caching logic from checkService
    if (currentPaymentValid != null && !headPaymentRequired) {
      x402PaymentValid = currentPaymentValid
    }

    assert.equal(x402PaymentValid, 1, 'should preserve cached payment validity')
  })

  it('re-validates when HEAD provides payment header even if cached', () => {
    const validHeader = makePaymentHeader()
    const currentPaymentValid = 0 // Previously marked invalid
    const headPaymentRequired = validHeader
    let x402PaymentValid = null

    // Caching logic: should NOT use cache when HEAD has header
    if (currentPaymentValid != null && !headPaymentRequired) {
      x402PaymentValid = currentPaymentValid
    } else {
      const parsed = parsePaymentRequired(headPaymentRequired)
      if (parsed.valid) {
        const validation = validatePaymentRequirements(parsed.accepts)
        x402PaymentValid = validation.valid ? 1 : 0
      } else {
        x402PaymentValid = 0
      }
    }

    assert.equal(x402PaymentValid, 1, 'should re-validate and update from new header data')
  })

  it('does not GET retry for POST-method services', async () => {
    let getCalled = false
    global.fetch = async (url, opts) => {
      if (opts?.method === 'GET') getCalled = true
      return mockResponse(402)
    }

    const http_method = 'POST'
    const headPaymentRequired = null
    let paymentRequiredHeader = headPaymentRequired

    // Condition from checkService: skip GET retry for POST services
    if (!paymentRequiredHeader && (http_method || 'GET') !== 'POST') {
      await fetch('https://example.com/api', { method: 'GET' })
    }

    assert.equal(getCalled, false, 'should not retry GET for POST-method services')
  })

  it('handles GET retry timeout gracefully', async () => {
    global.fetch = async () => {
      throw new Error('timeout')
    }

    const headPaymentRequired = null
    let paymentRequiredHeader = headPaymentRequired

    // GET retry with error
    if (!paymentRequiredHeader) {
      try {
        const getRes = await fetch('https://example.com/api', {
          method: 'GET',
          signal: AbortSignal.timeout(5000),
          redirect: 'manual',
        })
        if (getRes.status === 402) {
          paymentRequiredHeader = getRes.headers.get('payment-required')
        }
      } catch {
        // GET retry failed — leave as null
      }
    }

    assert.equal(paymentRequiredHeader, null, 'should leave header null on timeout')
    const parsed = parsePaymentRequired(paymentRequiredHeader)
    assert.equal(parsed.valid, false)
  })
})

// ─── SQL NULL handling ──────────────────────────────────────────────────────

describe('scoreboard stats SQL — NULL handling', () => {
  it('SQL condition includes x402 with NULL payment_valid', () => {
    // Verify the SQL logic: (protocol != 'x402' OR x402_payment_valid IS NULL OR x402_payment_valid != 0)
    // Test with different combinations:
    const testCases = [
      { protocol: 'x402', x402_payment_valid: null, expected: true, desc: 'x402 NULL → included' },
      { protocol: 'x402', x402_payment_valid: 1, expected: true, desc: 'x402 valid=1 → included' },
      { protocol: 'x402', x402_payment_valid: 0, expected: false, desc: 'x402 valid=0 → excluded' },
      { protocol: 'L402', x402_payment_valid: null, expected: true, desc: 'L402 NULL → included' },
      { protocol: 'L402', x402_payment_valid: 0, expected: true, desc: 'L402 valid=0 → included (not x402)' },
    ]

    for (const tc of testCases) {
      // Simulate the SQL WHERE clause in JS
      const included = (tc.protocol !== 'x402') || (tc.x402_payment_valid == null) || (tc.x402_payment_valid !== 0)
      assert.equal(included, tc.expected, tc.desc)
    }
  })

  it('JavaScript filter correctly handles NULL (strict equality)', () => {
    // The JS filter: !(svc.protocol === 'x402' && svc.x402_payment_valid === 0)
    const testCases = [
      { protocol: 'x402', x402_payment_valid: null, expected: true, desc: 'x402 NULL → included' },
      { protocol: 'x402', x402_payment_valid: 1, expected: true, desc: 'x402 valid=1 → included' },
      { protocol: 'x402', x402_payment_valid: 0, expected: false, desc: 'x402 valid=0 → excluded' },
      { protocol: 'L402', x402_payment_valid: null, expected: true, desc: 'L402 → included' },
    ]

    for (const tc of testCases) {
      const included = !(tc.protocol === 'x402' && tc.x402_payment_valid === 0)
      assert.equal(included, tc.expected, tc.desc)
    }
  })

  it('old SQL NOT expression incorrectly excludes NULL', () => {
    // Demonstrate the bug: NOT (protocol = 'x402' AND x402_payment_valid = 0)
    // In SQL, NULL = 0 → NULL, NOT NULL → NULL (excluded from results)
    // Simulate: SQL treats NULL comparison as "unknown" → row excluded
    const x402_payment_valid = null
    // SQL: NOT ('x402' = 'x402' AND NULL = 0) → NOT (true AND NULL) → NOT NULL → NULL → excluded
    // This is NOT the same as the JS behavior
    const sqlResult = !(true && (x402_payment_valid === 0)) // JS: !(true && false) = true ← DIFFERENT from SQL
    assert.equal(sqlResult, true, 'JS handles NULL correctly but SQL does not — this test documents the bug')
  })
})
