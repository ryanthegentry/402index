/**
 * Verify Flow Hash Fix Tests
 *
 * Tests cover:
 *   initiateClaim()    — returns verification_hash (SHA-256 of token) alongside raw token
 *   hashMatchesToken() — compares .well-known content against SHA-256(stored_token)
 *
 * Run: node --test test/verify-hash.test.js
 */

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { initiateClaim, hashMatchesToken } from '../src/services/domain-verify.js'
import db from '../src/db.js'

// ─── Test Helpers ────────────────────────────────────────────────────────────

const testDomains = []

function uniqueDomain() {
  const d = `test-${randomUUID().slice(0, 8)}.example.com`
  testDomains.push(d)
  return d
}

after(() => {
  for (const domain of testDomains) {
    try { db.prepare('DELETE FROM domain_claims WHERE domain = ?').run(domain) } catch {}
  }
})

// ─── initiateClaim — Hash Changes ───────────────────────────────────────────

describe('initiateClaim — hash changes', () => {
  it('returns both verification_token and verification_hash in response', () => {
    const domain = uniqueDomain()
    const result = initiateClaim(domain)
    assert.ok(result.status === 200 || result.status === 201)
    assert.ok(result.data.verification_token, 'should include raw token')
    assert.ok(result.data.verification_hash, 'should include hash')
    // Hash must be SHA-256 of the token
    const expectedHash = createHash('sha256').update(result.data.verification_token).digest('hex')
    assert.equal(result.data.verification_hash, expectedHash)
  })

  it('stores raw token in DB (unchanged for API auth)', () => {
    const domain = uniqueDomain()
    const result = initiateClaim(domain)
    const claim = db.prepare('SELECT verification_token FROM domain_claims WHERE domain = ?').get(domain)
    assert.ok(claim, 'claim should exist in DB')
    assert.equal(claim.verification_token, result.data.verification_token)
  })

  it('instructions tell provider to post the HASH, not the raw token', () => {
    const domain = uniqueDomain()
    const result = initiateClaim(domain)
    const instructions = result.data.instructions
    // Instructions should contain the hash
    assert.ok(instructions.includes(result.data.verification_hash),
      'instructions should include the hash')
    // Instructions should NOT contain the raw token
    assert.ok(!instructions.includes(result.data.verification_token),
      'instructions should not include the raw token')
  })
})

// ─── hashMatchesToken ────────────────────────────────────────────────────────

describe('hashMatchesToken', () => {
  const storedToken = 'a1b2c3d4e5f67890abcdef1234567890'
  const correctHash = createHash('sha256').update(storedToken).digest('hex')

  it('SHA-256 hash of token matches → true', () => {
    assert.equal(hashMatchesToken(correctHash, storedToken), true)
  })

  it('raw token does NOT match → false (breaking change from old flow)', () => {
    assert.equal(hashMatchesToken(storedToken, storedToken), false)
  })

  it('hash with leading/trailing whitespace → true (trimmed)', () => {
    assert.equal(hashMatchesToken(`  ${correctHash}  \n`, storedToken), true)
  })

  it('wrong hash → false', () => {
    const wrongHash = 'deadbeef'.repeat(8) // 64 hex chars, same length as SHA-256
    assert.equal(hashMatchesToken(wrongHash, storedToken), false)
  })

  it('hash comparison is case-insensitive', () => {
    assert.equal(hashMatchesToken(correctHash.toUpperCase(), storedToken), true)
  })
})
