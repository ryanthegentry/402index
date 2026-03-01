import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { escapeHtml, healthDot, protocolBadge, formatPrice, formatSchema } from '../src/views/helpers.js'

describe('escapeHtml', () => {
  it('escapes HTML special characters', () => {
    assert.equal(escapeHtml('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;')
  })

  it('escapes ampersands', () => {
    assert.equal(escapeHtml('foo & bar'), 'foo &amp; bar')
  })

  it('returns empty string for null/undefined/empty', () => {
    assert.equal(escapeHtml(null), '')
    assert.equal(escapeHtml(undefined), '')
    assert.equal(escapeHtml(''), '')
  })

  it('passes through safe strings unchanged', () => {
    assert.equal(escapeHtml('hello world'), 'hello world')
  })
})

describe('healthDot', () => {
  it('renders healthy status', () => {
    const result = healthDot('healthy')
    assert.ok(result.includes('health-healthy'))
    assert.ok(result.includes('healthy'))
  })

  it('renders degraded status', () => {
    const result = healthDot('degraded')
    assert.ok(result.includes('health-degraded'))
  })

  it('renders down status', () => {
    const result = healthDot('down')
    assert.ok(result.includes('health-down'))
  })

  it('renders unknown status', () => {
    const result = healthDot('unknown')
    assert.ok(result.includes('health-unknown'))
  })
})

describe('protocolBadge', () => {
  it('renders x402 badge', () => {
    const result = protocolBadge('x402')
    assert.ok(result.includes('badge-x402'))
    assert.ok(result.includes('x402'))
  })

  it('renders L402 badge', () => {
    const result = protocolBadge('L402')
    assert.ok(result.includes('badge-l402'))
    assert.ok(result.includes('L402'))
  })

  it('renders both badge for other protocols', () => {
    const result = protocolBadge('both')
    assert.ok(result.includes('badge-both'))
  })
})

describe('formatPrice', () => {
  it('formats USD price with 2 decimals for >= $0.01', () => {
    assert.equal(formatPrice({ price_usd: 1.5 }), '$1.50')
    assert.equal(formatPrice({ price_usd: 0.01 }), '$0.01')
  })

  it('formats USD price with 4 decimals for < $0.01', () => {
    assert.equal(formatPrice({ price_usd: 0.005 }), '$0.0050')
    assert.equal(formatPrice({ price_usd: 0.001 }), '$0.0010')
  })

  it('formats sats price when no USD price', () => {
    assert.equal(formatPrice({ price_sats: 500 }), '500 sats')
  })

  it('prefers USD over sats when both present', () => {
    assert.equal(formatPrice({ price_usd: 1.0, price_sats: 1000 }), '$1.00')
  })

  it('returns dash for no price', () => {
    const result = formatPrice({})
    assert.ok(result.includes('—'))
  })
})

describe('formatSchema', () => {
  it('pretty-prints valid JSON', () => {
    const result = formatSchema('{"type":"string"}')
    assert.equal(result, JSON.stringify({ type: 'string' }, null, 2))
  })

  it('returns null for null input', () => {
    assert.equal(formatSchema(null), null)
  })

  it('returns raw string for invalid JSON', () => {
    assert.equal(formatSchema('not json'), 'not json')
  })
})
