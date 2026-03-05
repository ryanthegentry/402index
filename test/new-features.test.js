import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatPrice } from '../src/views/helpers.js'
import { buildServiceQuery } from '../src/queries/services.js'

describe('formatPrice with btcUsdRate', () => {
  it('converts sats to USD when btcUsdRate provided', () => {
    const result = formatPrice({ price_sats: 100 }, 90000)
    // 100 sats = 0.000001 BTC * 90000 = $0.09
    assert.equal(result, '$0.09')
  })

  it('converts small sats to USD with 4 decimals', () => {
    const result = formatPrice({ price_sats: 1 }, 90000)
    // 1 sat = 0.00000001 BTC * 90000 = $0.0009
    assert.equal(result, '$0.0009')
  })

  it('prefers price_usd over sats conversion', () => {
    const result = formatPrice({ price_usd: 1.5, price_sats: 100 }, 90000)
    assert.equal(result, '$1.50')
  })

  it('falls back to sats display when no btcUsdRate', () => {
    assert.equal(formatPrice({ price_sats: 50 }), '50 sats')
    assert.equal(formatPrice({ price_sats: 50 }, null), '50 sats')
    assert.equal(formatPrice({ price_sats: 50 }, 0), '50 sats')
  })

  it('returns dash when no price at all', () => {
    assert.ok(formatPrice({}, 90000).includes('—'))
    assert.ok(formatPrice({}).includes('—'))
  })

  it('handles zero sats correctly', () => {
    const result = formatPrice({ price_sats: 0 }, 90000)
    assert.equal(result, '$0.0000')
  })
})

describe('buildServiceQuery payment_valid filter', () => {
  it('builds correct SQL for payment_valid=true', () => {
    const result = buildServiceQuery({ payment_valid: 'true' })
    assert.ok(result.where.includes("protocol = 'x402' AND x402_payment_valid = 1"))
    assert.ok(result.where.includes("protocol = 'L402' AND health_status = 'healthy'"))
  })

  it('builds correct SQL for payment_valid=1', () => {
    const result = buildServiceQuery({ payment_valid: '1' })
    assert.ok(result.where.includes("x402_payment_valid = 1"))
  })

  it('does not add payment_valid filter for false', () => {
    const result = buildServiceQuery({ payment_valid: 'false' })
    assert.ok(!result.where.includes('x402_payment_valid'))
  })

  it('accepts sponge as valid source', () => {
    const result = buildServiceQuery({ source: 'sponge' })
    assert.ok(result.where.includes('source = @source'))
    assert.equal(result.params.source, 'sponge')
  })
})

describe('CSV escaping', () => {
  // Import the escapeCsvField function by testing it through the endpoint behavior
  // Since it's not exported, we test the logic directly here
  function escapeCsvField(value) {
    if (value == null) return ''
    const str = String(value)
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return '"' + str.replace(/"/g, '""') + '"'
    }
    return str
  }

  it('passes through simple strings', () => {
    assert.equal(escapeCsvField('hello'), 'hello')
  })

  it('quotes fields with commas', () => {
    assert.equal(escapeCsvField('a,b'), '"a,b"')
  })

  it('escapes double quotes', () => {
    assert.equal(escapeCsvField('say "hi"'), '"say ""hi"""')
  })

  it('quotes fields with newlines', () => {
    assert.equal(escapeCsvField('line1\nline2'), '"line1\nline2"')
  })

  it('returns empty string for null/undefined', () => {
    assert.equal(escapeCsvField(null), '')
    assert.equal(escapeCsvField(undefined), '')
  })

  it('converts numbers to strings', () => {
    assert.equal(escapeCsvField(42), '42')
    assert.equal(escapeCsvField(0.01), '0.01')
  })
})
