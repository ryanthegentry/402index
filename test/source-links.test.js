import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLink } from '../src/views/helpers.js'

describe('sourceLink', () => {
  it('returns hyperlink for known sources', () => {
    const link = sourceLink('satring')
    assert.ok(link.includes('href="https://satring.com"'))
    assert.ok(link.includes('target="_blank"'))
    assert.ok(link.includes('rel="noopener"'))
    assert.ok(link.includes('class="source-link"'))
    assert.ok(link.includes('>satring</a>'))
  })

  it('returns plain text for unknown sources', () => {
    const text = sourceLink('exclusive')
    assert.ok(!text.includes('<a'))
    assert.ok(text.includes('exclusive'))
  })

  it('returns plain text for self-registered', () => {
    assert.ok(!sourceLink('self-registered').includes('<a'))
  })

  it('returns plain text for well-known', () => {
    assert.ok(!sourceLink('well-known').includes('<a'))
  })

  it('returns plain text for discovery', () => {
    assert.ok(!sourceLink('discovery').includes('<a'))
  })

  it('maps all known sources correctly', () => {
    const expected = {
      satring: 'satring.com',
      bazaar: 'x402.org/bazaar',
      l402apps: 'l402apps.com',
      sponge: 'paysponge.com',
      mpp: 'mpp.dev',
    }
    for (const [source, domain] of Object.entries(expected)) {
      assert.ok(sourceLink(source).includes(domain), `${source} should link to ${domain}`)
    }
  })

  it('escapes HTML in source names', () => {
    const result = sourceLink('<script>')
    assert.ok(!result.includes('<script>'))
    assert.ok(result.includes('&lt;script&gt;'))
  })
})
