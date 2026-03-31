import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { escapeHtml, escapeXml, healthDot, protocolBadge, formatPrice, formatSchema, safeJsonEmbed, safeHref } from '../src/views/helpers.js'

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

describe('escapeXml', () => {
  it('escapes all five XML entities', () => {
    assert.equal(escapeXml('<tag attr="val" other=\'val2\'>A & B</tag>'),
      '&lt;tag attr=&quot;val&quot; other=&apos;val2&apos;&gt;A &amp; B&lt;/tag&gt;')
  })

  it('escapes single quotes (unlike escapeHtml)', () => {
    assert.equal(escapeXml("it's"), 'it&apos;s')
  })

  it('returns empty string for null/undefined', () => {
    assert.equal(escapeXml(null), '')
    assert.equal(escapeXml(undefined), '')
  })

  it('passes through safe strings unchanged', () => {
    assert.equal(escapeXml('hello world'), 'hello world')
  })

  it('coerces numbers to string', () => {
    assert.equal(escapeXml(42), '42')
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

  it('escapes XSS payload in status text', () => {
    const result = healthDot('<img src=x onerror=alert(1)>')
    assert.ok(!result.includes('<img'), 'status text must be escaped')
    assert.ok(result.includes('&lt;img'))
  })

  it('escapes XSS payload in status class name', () => {
    const result = healthDot('"><script>alert(1)</script>')
    assert.ok(!result.includes('<script>'), 'status in class must be escaped')
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

  it('escapes XSS payload in protocol text', () => {
    const result = protocolBadge('<script>alert(1)</script>')
    assert.ok(!result.includes('<script>'), 'protocol text must be escaped')
    assert.ok(result.includes('&lt;script&gt;'))
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

describe('safeJsonEmbed', () => {
  it('escapes </script> breakout in string values', () => {
    const malicious = { name: '</script><script>alert(1)</script>' }
    const result = safeJsonEmbed(malicious)
    assert.ok(!result.includes('</script>'), 'output must not contain literal </script>')
    assert.ok(result.includes('\\u003c/script>'))
    // Must still parse back to the original data
    assert.deepEqual(JSON.parse(result), malicious)
  })

  it('escapes < in nested objects', () => {
    const data = { a: { b: '<img src=x onerror=alert(1)>' } }
    const result = safeJsonEmbed(data)
    assert.ok(!result.includes('<img'))
    assert.deepEqual(JSON.parse(result), data)
  })

  it('handles arrays', () => {
    const data = [{ name: '</script>' }]
    const result = safeJsonEmbed(data)
    assert.ok(!result.includes('</script>'))
    assert.deepEqual(JSON.parse(result), data)
  })

  it('handles safe data unchanged except for < escaping', () => {
    const data = { hello: 'world', count: 42 }
    assert.equal(safeJsonEmbed(data), JSON.stringify(data))
  })
})

describe('safeHref', () => {
  it('returns escaped URL for https', () => {
    assert.equal(safeHref('https://example.com'), 'https://example.com')
  })

  it('returns escaped URL for http', () => {
    assert.equal(safeHref('http://example.com'), 'http://example.com')
  })

  it('blocks javascript: protocol', () => {
    assert.equal(safeHref('javascript:alert(1)'), '#')
  })

  it('blocks JavaScript: (case-insensitive)', () => {
    assert.equal(safeHref('JavaScript:alert(1)'), '#')
  })

  it('blocks data: protocol', () => {
    assert.equal(safeHref('data:text/html,<script>alert(1)</script>'), '#')
  })

  it('blocks vbscript: protocol', () => {
    assert.equal(safeHref('vbscript:msgbox("xss")'), '#')
  })

  it('returns # for null', () => {
    assert.equal(safeHref(null), '#')
  })

  it('returns # for undefined', () => {
    assert.equal(safeHref(undefined), '#')
  })

  it('returns # for empty string', () => {
    assert.equal(safeHref(''), '#')
  })

  it('returns # for invalid URL', () => {
    assert.equal(safeHref('not-a-url'), '#')
  })

  it('escapes HTML entities in URL', () => {
    assert.equal(safeHref('https://example.com/a?b=1&c=2'), 'https://example.com/a?b=1&amp;c=2')
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
