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

  it('rejects javascript: protocol', () => {
    assert.equal(normalizeUrl('javascript:alert(1)'), null)
  })

  it('rejects data: protocol', () => {
    assert.equal(normalizeUrl('data:text/html,<script>alert(1)</script>'), null)
  })

  it('rejects ftp: protocol', () => {
    assert.equal(normalizeUrl('ftp://example.com/file'), null)
  })

  it('allows https: protocol', () => {
    assert.equal(normalizeUrl('https://example.com/api'), 'https://example.com/api')
  })

  it('allows http: protocol (upgrades to https)', () => {
    assert.equal(normalizeUrl('http://example.com/api'), 'https://example.com/api')
  })

  it('allows http: with preserveScheme', () => {
    assert.equal(normalizeUrl('http://example.com/api', { preserveScheme: true }), 'http://example.com/api')
  })
})
