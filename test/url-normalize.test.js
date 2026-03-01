import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeUrl } from '../src/services/url-normalize.js'

describe('normalizeUrl', () => {
  it('upgrades http to https', () => {
    assert.equal(normalizeUrl('http://example.com/api'), 'https://example.com/api')
  })

  it('lowercases hostname', () => {
    assert.equal(normalizeUrl('https://EXAMPLE.COM/Api'), 'https://example.com/Api')
  })

  it('strips trailing slashes', () => {
    assert.equal(normalizeUrl('https://example.com/api/'), 'https://example.com/api')
    assert.equal(normalizeUrl('https://example.com/api///'), 'https://example.com/api')
  })

  it('preserves root path as /', () => {
    assert.equal(normalizeUrl('https://example.com/'), 'https://example.com/')
    assert.equal(normalizeUrl('https://example.com'), 'https://example.com/')
  })

  it('preserves query parameters', () => {
    assert.equal(normalizeUrl('https://example.com/api?key=value'), 'https://example.com/api?key=value')
  })

  it('returns invalid URLs unchanged', () => {
    assert.equal(normalizeUrl('not-a-url'), 'not-a-url')
  })

  it('returns null/undefined unchanged', () => {
    assert.equal(normalizeUrl(null), null)
    assert.equal(normalizeUrl(undefined), undefined)
  })

  it('handles empty string', () => {
    assert.equal(normalizeUrl(''), '')
  })
})
