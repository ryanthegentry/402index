import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { shuffleArray, getHostname } from '../src/health/checker.js'

describe('shuffleArray', () => {
  it('returns array of same length', () => {
    const arr = [1, 2, 3, 4, 5]
    const shuffled = shuffleArray(arr)
    assert.equal(shuffled.length, arr.length)
  })

  it('contains all original elements', () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const shuffled = shuffleArray(arr)
    assert.deepEqual(shuffled.sort((a, b) => a - b), arr)
  })

  it('does not mutate the original array', () => {
    const arr = [1, 2, 3, 4, 5]
    const original = [...arr]
    shuffleArray(arr)
    assert.deepEqual(arr, original)
  })

  it('produces a different order for large arrays (statistical)', () => {
    const arr = Array.from({ length: 20 }, (_, i) => i)
    const shuffled = shuffleArray(arr)
    // Very unlikely (1/20! chance) that a 20-element shuffle returns identical order
    let same = true
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] !== shuffled[i]) { same = false; break }
    }
    assert.equal(same, false, 'shuffled array should differ from original for 20 elements')
  })

  it('handles empty array', () => {
    assert.deepEqual(shuffleArray([]), [])
  })

  it('handles single-element array', () => {
    assert.deepEqual(shuffleArray([42]), [42])
  })
})

describe('getHostname', () => {
  it('extracts hostname from https URL', () => {
    assert.equal(getHostname('https://example.com/api/v1'), 'example.com')
  })

  it('extracts hostname from http URL', () => {
    assert.equal(getHostname('http://api.example.com:3000/path'), 'api.example.com')
  })

  it('extracts hostname from URL with port', () => {
    assert.equal(getHostname('https://lightningfaucet.com:443/api/l402/btc_price'), 'lightningfaucet.com')
  })

  it('extracts hostname from URL with path and query', () => {
    assert.equal(getHostname('https://sats4ai.com/api/l402/image?foo=bar'), 'sats4ai.com')
  })

  it('returns input string for invalid URL', () => {
    assert.equal(getHostname('not-a-url'), 'not-a-url')
  })

  it('returns input string for empty string', () => {
    assert.equal(getHostname(''), '')
  })
})

describe('.well-known URL filter', () => {
  const isWellKnown = url => url.includes('/.well-known/')

  it('detects .well-known discovery URLs', () => {
    assert.equal(isWellKnown('https://sats4ai.com/.well-known/l402-services'), true)
    assert.equal(isWellKnown('https://example.com/.well-known/openid-configuration'), true)
  })

  it('does not flag normal API URLs', () => {
    assert.equal(isWellKnown('https://sats4ai.com/api/l402/image'), false)
    assert.equal(isWellKnown('https://lightningfaucet.com/api/l402/btc_price'), false)
  })

  it('does not flag URLs with "well-known" in other positions', () => {
    assert.equal(isWellKnown('https://well-known.example.com/api'), false)
    assert.equal(isWellKnown('https://example.com/api/well-known'), false)
  })
})
