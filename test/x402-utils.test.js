import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  parsePaymentRequired,
  validatePaymentRequirements,
  isValidAssetAddress,
  isValidEvmAddress,
  isValidSolanaAddress,
  isValidPaymentAddress,
  isKnownUSDC,
  extractFacilitatorUrl,
} from '../src/services/x402-utils.js'

// ─── parsePaymentRequired ──────────────────────────────────────────────────

describe('parsePaymentRequired', () => {
  function encode(obj) {
    return Buffer.from(JSON.stringify(obj)).toString('base64')
  }

  it('parses valid base64-encoded JSON with accepts array', () => {
    const payload = {
      accepts: [{
        payTo: '0x1234567890abcdef1234567890abcdef12345678',
        asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        network: 'eip155:8453',
        maxAmountRequired: '1000000',
      }],
    }
    const result = parsePaymentRequired(encode(payload))
    assert.equal(result.valid, true)
    assert.equal(result.accepts.length, 1)
    assert.equal(result.error, null)
  })

  it('returns error for null input', () => {
    const result = parsePaymentRequired(null)
    assert.equal(result.valid, false)
    assert.ok(result.error.includes('missing'))
  })

  it('returns error for empty string', () => {
    const result = parsePaymentRequired('')
    assert.equal(result.valid, false)
  })

  it('returns error for invalid base64', () => {
    const result = parsePaymentRequired('!!!not-base64!!!')
    // Buffer.from handles most strings gracefully, so this may or may not fail at base64 stage
    // It should fail at JSON parse stage
    assert.equal(result.valid, false)
  })

  it('returns error for valid base64 but invalid JSON', () => {
    const result = parsePaymentRequired(Buffer.from('not json').toString('base64'))
    assert.equal(result.valid, false)
    assert.ok(result.error.includes('JSON'))
  })

  it('returns error for JSON without accepts array', () => {
    const result = parsePaymentRequired(encode({ foo: 'bar' }))
    assert.equal(result.valid, false)
    assert.ok(result.error.includes('accepts'))
  })

  it('returns error for empty accepts array', () => {
    const result = parsePaymentRequired(encode({ accepts: [] }))
    assert.equal(result.valid, false)
    assert.ok(result.error.includes('empty'))
  })

  it('preserves raw parsed object', () => {
    const payload = { accepts: [{ payTo: '0x' + 'a'.repeat(40) }], version: '1.0' }
    const result = parsePaymentRequired(encode(payload))
    assert.equal(result.raw.version, '1.0')
  })
})

// ─── isValidEvmAddress ──────────────────────────────────────────────────────

describe('isValidEvmAddress', () => {
  it('accepts valid EVM address', () => {
    assert.equal(isValidEvmAddress('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'), true)
  })

  it('accepts uppercase hex', () => {
    assert.equal(isValidEvmAddress('0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913'), true)
  })

  it('rejects null', () => {
    assert.equal(isValidEvmAddress(null), false)
  })

  it('rejects without 0x prefix', () => {
    assert.equal(isValidEvmAddress('833589fcd6edb6e08f4c7c32d4f71b54bda02913'), false)
  })

  it('rejects too short', () => {
    assert.equal(isValidEvmAddress('0x833589fcd6edb6e08f4c7c32d4f71b54bda0291'), false)
  })

  it('rejects too long', () => {
    assert.equal(isValidEvmAddress('0x833589fcd6edb6e08f4c7c32d4f71b54bda029130'), false)
  })

  it('rejects non-hex chars', () => {
    assert.equal(isValidEvmAddress('0xzzzz89fcd6edb6e08f4c7c32d4f71b54bda02913'), false)
  })
})

// ─── isValidSolanaAddress ───────────────────────────────────────────────────

describe('isValidSolanaAddress', () => {
  it('accepts valid Solana address', () => {
    assert.equal(isValidSolanaAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), true)
  })

  it('rejects null', () => {
    assert.equal(isValidSolanaAddress(null), false)
  })

  it('rejects too short (< 32 chars)', () => {
    assert.equal(isValidSolanaAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G'), false) // 31 chars
  })

  it('rejects strings with invalid base58 chars (0, O, I, l)', () => {
    assert.equal(isValidSolanaAddress('0PjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), false)
  })

  it('accepts 32-char base58 string', () => {
    assert.equal(isValidSolanaAddress('11111111111111111111111111111111'), true) // '1' is valid base58, 32 chars
  })
})

// ─── isValidAssetAddress ────────────────────────────────────────────────────

describe('isValidAssetAddress', () => {
  it('accepts EVM address', () => {
    assert.equal(isValidAssetAddress('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'), true)
  })

  it('accepts Solana address', () => {
    assert.equal(isValidAssetAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), true)
  })

  it('rejects garbage', () => {
    assert.equal(isValidAssetAddress('not-an-address'), false)
  })
})

// ─── isKnownUSDC ────────────────────────────────────────────────────────────

describe('isKnownUSDC', () => {
  it('recognizes Base USDC', () => {
    const result = isKnownUSDC('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')
    assert.equal(result.known, true)
    assert.equal(result.chain, 'Base')
  })

  it('recognizes Ethereum USDC', () => {
    const result = isKnownUSDC('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')
    assert.equal(result.known, true)
    assert.equal(result.chain, 'Ethereum')
  })

  it('is case-insensitive', () => {
    const result = isKnownUSDC('0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913')
    assert.equal(result.known, true)
    assert.equal(result.chain, 'Base')
  })

  it('returns unknown for random address', () => {
    const result = isKnownUSDC('0x' + 'a'.repeat(40))
    assert.equal(result.known, false)
    assert.equal(result.chain, null)
  })

  it('handles null', () => {
    const result = isKnownUSDC(null)
    assert.equal(result.known, false)
  })

  it('recognizes Base Sepolia USDC', () => {
    const result = isKnownUSDC('0x036cbd53842c5426634e7929541ec2318f3dcf7e')
    assert.equal(result.known, true)
    assert.equal(result.chain, 'Base Sepolia')
  })
})

// ─── extractFacilitatorUrl ──────────────────────────────────────────────────

describe('extractFacilitatorUrl', () => {
  it('extracts from extra.facilitatorUrl', () => {
    const url = extractFacilitatorUrl({ extra: { facilitatorUrl: 'https://x402.org/facilitator' } })
    assert.equal(url, 'https://x402.org/facilitator')
  })

  it('extracts from facilitatorData.facilitatorUrl (object)', () => {
    const url = extractFacilitatorUrl({ facilitatorData: { facilitatorUrl: 'https://example.com/f' } })
    assert.equal(url, 'https://example.com/f')
  })

  it('extracts from facilitatorData (JSON string)', () => {
    const url = extractFacilitatorUrl({
      facilitatorData: JSON.stringify({ facilitatorUrl: 'https://example.com/f' }),
    })
    assert.equal(url, 'https://example.com/f')
  })

  it('extracts from facilitatorData (URL string)', () => {
    const url = extractFacilitatorUrl({ facilitatorData: 'https://example.com/f' })
    assert.equal(url, 'https://example.com/f')
  })

  it('returns null for null input', () => {
    assert.equal(extractFacilitatorUrl(null), null)
  })

  it('returns null when no facilitator data', () => {
    assert.equal(extractFacilitatorUrl({ payTo: '0x123' }), null)
  })
})

// ─── validatePaymentRequirements ────────────────────────────────────────────

describe('validatePaymentRequirements', () => {
  const validEntry = {
    payTo: '0x1234567890abcdef1234567890abcdef12345678',
    asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    network: 'eip155:8453',
    maxAmountRequired: '1000000',
    extra: { facilitatorUrl: 'https://x402.org/facilitator' },
  }

  it('validates a complete entry', () => {
    const result = validatePaymentRequirements([validEntry])
    assert.equal(result.valid, true)
    assert.equal(result.assetKnown, true)
    assert.equal(result.entries.length, 1)
    assert.equal(result.entries[0].valid, true)
    assert.equal(result.entries[0].payToValid, true)
    assert.equal(result.entries[0].assetValid, true)
    assert.equal(result.entries[0].assetKnown, true)
    assert.equal(result.entries[0].assetChain, 'Base')
    assert.equal(result.facilitatorUrls.length, 1)
    assert.equal(result.facilitatorUrls[0], 'https://x402.org/facilitator')
  })

  it('marks entry invalid when payTo missing', () => {
    const result = validatePaymentRequirements([{ ...validEntry, payTo: undefined }])
    assert.equal(result.valid, false)
    assert.equal(result.entries[0].hasPayTo, false)
    assert.equal(result.entries[0].valid, false)
  })

  it('marks entry invalid when payTo is malformed', () => {
    const result = validatePaymentRequirements([{ ...validEntry, payTo: 'not-an-address' }])
    assert.equal(result.valid, false)
    assert.equal(result.entries[0].payToValid, false)
  })

  it('marks entry invalid when asset missing', () => {
    const result = validatePaymentRequirements([{ ...validEntry, asset: undefined }])
    assert.equal(result.valid, false)
  })

  it('marks entry invalid when amount missing', () => {
    const result = validatePaymentRequirements([{ ...validEntry, maxAmountRequired: undefined }])
    assert.equal(result.valid, false)
    assert.equal(result.entries[0].hasAmount, false)
  })

  it('marks assetKnown false for unknown contract', () => {
    const result = validatePaymentRequirements([{
      ...validEntry,
      asset: '0x' + 'b'.repeat(40),
    }])
    assert.equal(result.valid, true)
    assert.equal(result.assetKnown, false)
    assert.equal(result.entries[0].assetKnown, false)
  })

  it('valid if at least one entry is valid (multi-entry)', () => {
    const result = validatePaymentRequirements([
      { payTo: 'garbage' }, // invalid
      validEntry,           // valid
    ])
    assert.equal(result.valid, true)
    assert.equal(result.entries[0].valid, false)
    assert.equal(result.entries[1].valid, true)
  })

  it('deduplicates facilitator URLs', () => {
    const entry2 = { ...validEntry, payTo: '0x' + 'c'.repeat(40) }
    const result = validatePaymentRequirements([validEntry, entry2])
    assert.equal(result.facilitatorUrls.length, 1)
  })

  it('returns empty facilitatorUrls when none present', () => {
    const noFac = { ...validEntry, extra: undefined }
    const result = validatePaymentRequirements([noFac])
    assert.equal(result.facilitatorUrls.length, 0)
  })

  it('returns invalid for empty array', () => {
    const result = validatePaymentRequirements([])
    assert.equal(result.valid, false)
  })

  it('returns invalid for null', () => {
    const result = validatePaymentRequirements(null)
    assert.equal(result.valid, false)
  })

  it('recognizes hasNetwork when network is present', () => {
    const result = validatePaymentRequirements([validEntry])
    assert.equal(result.entries[0].hasNetwork, true)
  })

  it('handles maxAmountRequired as number', () => {
    const result = validatePaymentRequirements([{ ...validEntry, maxAmountRequired: 1000000 }])
    assert.equal(result.entries[0].hasAmount, true)
    assert.equal(result.valid, true)
  })

  it('handles maxAmountRequired as "0" (zero is valid)', () => {
    const result = validatePaymentRequirements([{ ...validEntry, maxAmountRequired: '0' }])
    assert.equal(result.entries[0].hasAmount, true)
  })
})

// ─── Detail page: x402 payment validation display ──────────────────────────

describe('detailPage — x402 payment validation', () => {
  it('shows x402 payment validation section for x402 services', async () => {
    const { detailPage } = await import('../src/views/detail.js')
    const html = detailPage({
      name: 'Test x402 API',
      url: 'https://example.com/api',
      protocol: 'x402',
      health_status: 'healthy',
      source: 'bazaar',
      consecutive_failures: 0,
      health_checks: [],
      x402_payment_valid: 1,
      x402_asset_known: 1,
      x402_facilitator_reachable: 1,
    })
    assert.ok(html.includes('x402 Payment Validation'))
    assert.ok(html.includes('Valid'))
    assert.ok(html.includes('Known USDC'))
    assert.ok(html.includes('Reachable'))
  })

  it('shows invalid state for x402 services', async () => {
    const { detailPage } = await import('../src/views/detail.js')
    const html = detailPage({
      name: 'Bad x402 API',
      url: 'https://example.com/api',
      protocol: 'x402',
      health_status: 'degraded',
      source: 'bazaar',
      consecutive_failures: 0,
      health_checks: [],
      x402_payment_valid: 0,
      x402_asset_known: 0,
      x402_facilitator_reachable: 0,
    })
    assert.ok(html.includes('Invalid'))
    assert.ok(html.includes('Unknown asset'))
    assert.ok(html.includes('Unreachable'))
  })

  it('does not show x402 section for L402 services', async () => {
    const { detailPage } = await import('../src/views/detail.js')
    const html = detailPage({
      name: 'L402 API',
      url: 'https://example.com/api',
      protocol: 'L402',
      health_status: 'healthy',
      source: 'exclusive',
      consecutive_failures: 0,
      health_checks: [],
    })
    assert.ok(!html.includes('x402 Payment Validation'))
  })

  it('shows dash when x402 fields are null', async () => {
    const { detailPage } = await import('../src/views/detail.js')
    const html = detailPage({
      name: 'New x402 API',
      url: 'https://example.com/api',
      protocol: 'x402',
      health_status: 'unknown',
      source: 'bazaar',
      consecutive_failures: 0,
      health_checks: [],
      x402_payment_valid: null,
      x402_asset_known: null,
      x402_facilitator_reachable: null,
    })
    assert.ok(html.includes('x402 Payment Validation'))
    // All three should show '—' (not Valid/Invalid/Reachable/etc.)
    const section = html.split('x402 Payment Validation')[1].split('</div>').slice(0, 10).join('</div>')
    assert.ok(!section.includes('>Valid<'))
    assert.ok(!section.includes('>Invalid<'))
  })
})

// ─── Query builder: payment_valid filter ────────────────────────────────────

describe('buildServiceQuery — payment_valid filter', () => {
  it('adds x402_payment_valid = 1 when payment_valid is true', async () => {
    const { buildServiceQuery } = await import('../src/queries/services.js')
    const result = buildServiceQuery({ payment_valid: 'true' })
    assert.ok(result.where.includes('x402_payment_valid = 1'))
  })

  it('does not filter when payment_valid is absent', async () => {
    const { buildServiceQuery } = await import('../src/queries/services.js')
    const result = buildServiceQuery({})
    assert.ok(!result.where.includes('x402_payment_valid'))
  })

  it('API_COLUMNS includes x402 validation columns', async () => {
    const { API_COLUMNS } = await import('../src/queries/services.js')
    assert.ok(API_COLUMNS.includes('x402_payment_valid'))
    assert.ok(API_COLUMNS.includes('x402_facilitator_reachable'))
    assert.ok(API_COLUMNS.includes('x402_asset_known'))
  })

  it('PAGE_COLUMNS includes x402_payment_valid', async () => {
    const { PAGE_COLUMNS } = await import('../src/queries/services.js')
    assert.ok(PAGE_COLUMNS.includes('x402_payment_valid'))
  })
})

// ─── Homepage: payment_valid checkbox ───────────────────────────────────────

describe('homePage — payment_valid filter', () => {
  it('includes payment_valid checkbox', async () => {
    const { homePage } = await import('../src/views/home.js')
    const html = homePage({
      services: [],
      total: 0,
      limit: 50,
      offset: 0,
      filters: {},
      stats: { total: 0, healthy: 0, degraded: 0, down: 0, unknown: 0 },
      categories: [],
    })
    assert.ok(html.includes('name="payment_valid"'))
    assert.ok(html.includes('Payment verified'))
  })

  it('checkbox is checked when filter is active', async () => {
    const { homePage } = await import('../src/views/home.js')
    const html = homePage({
      services: [],
      total: 0,
      limit: 50,
      offset: 0,
      filters: { payment_valid: true },
      stats: { total: 0, healthy: 0, degraded: 0, down: 0, unknown: 0 },
      categories: [],
    })
    assert.ok(html.includes('name="payment_valid" value="true" checked'))
  })
})
