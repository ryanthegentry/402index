/**
 * Domain Verification & Provider Listing Edit tests
 *
 * Run: node --test test/domain-verification.test.js
 *
 * Tests cover:
 *   POST /api/v1/claim         — domain claim initiation
 *   POST /api/v1/claim/verify  — domain verification via well-known file
 *   PATCH /api/v1/services/:id — listing edits by verified domain owner
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const BASE = process.env.API_BASE || 'http://localhost:3402'
const API = `${BASE}/api/v1`

// ─── API Helpers ─────────────────────────────────────────────────────────────

async function apiClaim(body) {
  const res = await fetch(`${API}/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

async function apiVerify(body) {
  const res = await fetch(`${API}/claim/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

async function apiPatch(id, body) {
  const res = await fetch(`${API}/services/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

// ─── DB access for test setup/teardown ───────────────────────────────────────

let db
try {
  const mod = await import('../src/db.js')
  db = mod.default
} catch {
  // db import failed — tests requiring DB setup will skip
}

// Cleanup all test data after suite
after(() => {
  if (!db) return
  try {
    db.prepare("DELETE FROM domain_claims WHERE domain LIKE '%.example.com'").run()
    db.prepare("DELETE FROM domain_claims WHERE domain = 'example.com'").run()
    db.prepare("DELETE FROM services WHERE id LIKE 'dv-test-%'").run()
    db.prepare("DELETE FROM health_checks WHERE service_id LIKE 'dv-test-%'").run()
  } catch {
    // Tables may not exist yet — expected before implementation
  }
})

// ─── 1. Claim Initiation (POST /api/v1/claim) ──────────────────────────────

describe('POST /api/v1/claim — Claim Initiation', () => {
  it('1. valid domain → 201 + token + verification_url', async () => {
    const domain = `claim-valid-${randomUUID().slice(0, 8)}.example.com`
    const r = await apiClaim({ domain })
    assert.equal(r.status, 201)
    assert.ok(r.body.verification_token)
    assert.equal(r.body.verification_token.length, 64, '32 bytes hex = 64 chars')
    assert.equal(r.body.domain, domain)
    assert.ok(r.body.verification_url.startsWith('https://'), 'must be HTTPS')
    assert.ok(r.body.verification_url.includes('/.well-known/402index-verify.txt'))
    assert.ok(r.body.instructions.includes(r.body.verification_token))
  })

  it('2. domain with protocol prefix → 400', async () => {
    const r = await apiClaim({ domain: 'https://example.com' })
    assert.equal(r.status, 400)
    assert.ok(r.body.error.includes('protocol'))
  })

  it('3. domain with path → 400', async () => {
    const r = await apiClaim({ domain: 'example.com/api/foo' })
    assert.equal(r.status, 400)
    assert.ok(r.body.error.includes('path'))
  })

  it('4. IP address → 400', async () => {
    const r = await apiClaim({ domain: '192.168.1.1' })
    assert.equal(r.status, 400)
    assert.ok(r.body.error.includes('IP'))
  })

  it('5. empty domain → 400', async () => {
    const r = await apiClaim({ domain: '' })
    assert.equal(r.status, 400)
  })

  it('6. missing domain → 400', async () => {
    const r = await apiClaim({})
    assert.equal(r.status, 400)
  })

  it('7. already-verified domain → 409', async (t) => {
    if (!db) return t.skip('requires DB access')

    const domain = `verified-${randomUUID().slice(0, 8)}.example.com`
    try {
      db.prepare(
        "INSERT INTO domain_claims (id, domain, verification_token, status, verified_at, expires_at) VALUES (?, ?, ?, 'verified', datetime('now'), datetime('now', '+3 days'))"
      ).run(randomUUID(), domain, 'a'.repeat(64))
    } catch (err) {
      return t.skip(`domain_claims table not ready: ${err.message}`)
    }

    const r = await apiClaim({ domain })
    assert.equal(r.status, 409)
  })

  it('8. already-pending domain → regenerates token + 200', async () => {
    const domain = `pending-${randomUUID().slice(0, 8)}.example.com`

    // First claim
    const r1 = await apiClaim({ domain })
    assert.equal(r1.status, 201)
    const token1 = r1.body.verification_token

    // Second claim — should regenerate token, return 200 (not 201)
    const r2 = await apiClaim({ domain })
    assert.equal(r2.status, 200)
    assert.notEqual(r2.body.verification_token, token1, 'token should be regenerated')
    assert.equal(r2.body.verification_token.length, 64)
  })
})

// ─── 2. Claim Verification — API Error Cases ────────────────────────────────

describe('POST /api/v1/claim/verify — API Error Cases', () => {
  it('13. no pending claim → 404', async () => {
    const domain = `no-claim-${randomUUID().slice(0, 8)}.example.com`
    const r = await apiVerify({ domain })
    assert.equal(r.status, 404)
  })

  it('14. expired claim → 410', async (t) => {
    if (!db) return t.skip('requires DB access')

    const domain = `expired-${randomUUID().slice(0, 8)}.example.com`
    try {
      db.prepare(
        "INSERT INTO domain_claims (id, domain, verification_token, status, expires_at) VALUES (?, ?, ?, 'pending', datetime('now', '-1 day'))"
      ).run(randomUUID(), domain, 'a'.repeat(64))
    } catch (err) {
      return t.skip(`domain_claims table not ready: ${err.message}`)
    }

    const r = await apiVerify({ domain })
    assert.equal(r.status, 410)
  })
})

// ─── 3. Claim Verification — Service Logic (mock fetch) ─────────────────────

describe('POST /api/v1/claim/verify — Verification Logic', () => {
  let verifyClaimFn

  before(async () => {
    try {
      const mod = await import('../src/services/domain-verify.js')
      verifyClaimFn = mod.verifyClaim
    } catch {
      // Module not implemented yet — tests will skip
    }
  })

  function setupClaim(domain, token) {
    const claimId = randomUUID()
    try { db.prepare("DELETE FROM domain_claims WHERE domain = ?").run(domain) } catch {}
    db.prepare(
      "INSERT INTO domain_claims (id, domain, verification_token, status, expires_at) VALUES (?, ?, ?, 'pending', datetime('now', '+3 days'))"
    ).run(claimId, domain, token)
    return claimId
  }

  function cleanupClaim(claimId) {
    try { db.prepare("DELETE FROM domain_claims WHERE id = ?").run(claimId) } catch {}
  }

  it('9. token matches → 200 verified', async (t) => {
    if (!verifyClaimFn || !db) return t.skip('domain-verify module not implemented')

    const domain = 'example.com'
    const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
    const claimId = setupClaim(domain, token)

    try {
      const mockFetch = async (url, opts) => {
        assert.ok(url.includes(domain), 'fetch URL should include domain')
        assert.equal(opts.redirect, 'manual', 'must not follow redirects')
        assert.ok(opts.headers['User-Agent'].includes('402index'), 'should set User-Agent')
        return { status: 200, text: async () => token }
      }

      const result = await verifyClaimFn(domain, { fetchFn: mockFetch })
      assert.equal(result.status, 200)
      assert.equal(result.data.status, 'verified')
      assert.equal(result.data.domain, domain)
      assert.equal(typeof result.data.services_count, 'number')
    } finally {
      cleanupClaim(claimId)
    }
  })

  it('10. token mismatch → 422', async (t) => {
    if (!verifyClaimFn || !db) return t.skip('domain-verify module not implemented')

    const domain = 'example.com'
    const token = 'correct' + 'a'.repeat(57)
    const claimId = setupClaim(domain, token)

    try {
      const mockFetch = async () => ({
        status: 200,
        text: async () => 'wrong-token-completely-different',
      })

      const result = await verifyClaimFn(domain, { fetchFn: mockFetch })
      assert.equal(result.status, 422)
      assert.ok(result.error.toLowerCase().includes('mismatch'))
    } finally {
      cleanupClaim(claimId)
    }
  })

  it('11. verification URL unreachable → 422', async (t) => {
    if (!verifyClaimFn || !db) return t.skip('domain-verify module not implemented')

    const domain = 'example.com'
    const token = 'a'.repeat(64)
    const claimId = setupClaim(domain, token)

    try {
      const mockFetch = async () => { throw new Error('ECONNREFUSED') }

      const result = await verifyClaimFn(domain, { fetchFn: mockFetch })
      assert.equal(result.status, 422)
      assert.ok(result.error.includes('Connection') || result.error.includes('failed'))
    } finally {
      cleanupClaim(claimId)
    }
  })

  it('12. HTML response (not plain text) → 422', async (t) => {
    if (!verifyClaimFn || !db) return t.skip('domain-verify module not implemented')

    const domain = 'example.com'
    const token = 'a'.repeat(64)
    const claimId = setupClaim(domain, token)

    try {
      const mockFetch = async () => ({
        status: 200,
        text: async () => '<html><body>Not a verification token</body></html>',
      })

      const result = await verifyClaimFn(domain, { fetchFn: mockFetch })
      assert.equal(result.status, 422)
      // Token mismatch — HTML body != hex token
    } finally {
      cleanupClaim(claimId)
    }
  })

  it('15. redirect from verification URL → 422', async (t) => {
    if (!verifyClaimFn || !db) return t.skip('domain-verify module not implemented')

    const domain = 'example.com'
    const token = 'a'.repeat(64)
    const claimId = setupClaim(domain, token)

    try {
      const mockFetch = async () => ({
        status: 302,
        text: async () => '',
      })

      const result = await verifyClaimFn(domain, { fetchFn: mockFetch })
      assert.equal(result.status, 422)
      assert.ok(result.error.toLowerCase().includes('redirect'))
    } finally {
      cleanupClaim(claimId)
    }
  })

  it('16. response > 1KB → 422', async (t) => {
    if (!verifyClaimFn || !db) return t.skip('domain-verify module not implemented')

    const domain = 'example.com'
    const token = 'a'.repeat(64)
    const claimId = setupClaim(domain, token)

    try {
      const mockFetch = async () => ({
        status: 200,
        text: async () => 'x'.repeat(2048),
      })

      const result = await verifyClaimFn(domain, { fetchFn: mockFetch })
      assert.equal(result.status, 422)
      assert.ok(result.error.includes('size') || result.error.includes('1KB') || result.error.includes('exceeds'))
    } finally {
      cleanupClaim(claimId)
    }
  })

  // Test 17: SSRF protection is inherited from resolveAndCheck() — tested in ssrf.test.js
  // The verifyClaim function calls resolveAndCheck before fetching, blocking private IPs
})

// ─── 4. Listing Edits (PATCH /api/v1/services/:id) ─────────────────────────

describe('PATCH /api/v1/services/:id — Listing Edits', () => {
  const DOMAIN = 'patch-test.example.com'
  const TOKEN = 'patchtoken' + 'a'.repeat(54) // 64 chars
  const SERVICE_ID = `dv-test-svc-${randomUUID().slice(0, 8)}`
  const OTHER_SERVICE_ID = `dv-test-svc-other-${randomUUID().slice(0, 8)}`
  let skipAll = false

  before(() => {
    if (!db) { skipAll = true; return }

    try {
      // Clean up any leftover test data
      db.prepare("DELETE FROM domain_claims WHERE domain = ?").run(DOMAIN)
      db.prepare("DELETE FROM services WHERE id IN (?, ?)").run(SERVICE_ID, OTHER_SERVICE_ID)

      // Insert verified claim
      db.prepare(
        "INSERT INTO domain_claims (id, domain, verification_token, status, verified_at, expires_at) VALUES (?, ?, ?, 'verified', datetime('now'), datetime('now', '+30 days'))"
      ).run(randomUUID(), DOMAIN, TOKEN)

      // Insert matching service (URL hostname = DOMAIN)
      db.prepare(
        "INSERT INTO services (id, name, url, protocol, source, category, description, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')"
      ).run(SERVICE_ID, 'Test Patch Service', `https://${DOMAIN}/api/test`, 'L402', 'self-registered', 'uncategorized', 'Original description')

      // Insert non-matching service (different domain)
      db.prepare(
        "INSERT INTO services (id, name, url, protocol, source, category, status) VALUES (?, ?, ?, ?, ?, ?, 'active')"
      ).run(OTHER_SERVICE_ID, 'Other Domain Service', 'https://other-domain.example.com/api', 'L402', 'self-registered', 'uncategorized')
    } catch (err) {
      console.log('PATCH test setup failed:', err.message)
      skipAll = true
    }
  })

  after(() => {
    if (!db) return
    try {
      db.prepare("DELETE FROM domain_claims WHERE domain = ?").run(DOMAIN)
      db.prepare("DELETE FROM services WHERE id IN (?, ?)").run(SERVICE_ID, OTHER_SERVICE_ID)
    } catch {}
  })

  it('18. valid edit → 200 + fields updated', async (t) => {
    if (skipAll) return t.skip('test setup failed')

    const r = await apiPatch(SERVICE_ID, {
      domain: DOMAIN,
      verification_token: TOKEN,
      description: 'Updated description via domain verification',
      category: 'ai/text',
    })
    assert.equal(r.status, 200)
    assert.equal(r.body.description, 'Updated description via domain verification')
    assert.equal(r.body.category, 'ai/text')
    assert.equal(r.body.id, SERVICE_ID)
  })

  it('19. wrong token → 403', async (t) => {
    if (skipAll) return t.skip('test setup failed')

    const r = await apiPatch(SERVICE_ID, {
      domain: DOMAIN,
      verification_token: 'wrongtoken' + 'b'.repeat(54),
      description: 'Should not update',
    })
    assert.equal(r.status, 403)
  })

  it('20. unverified/pending domain → 403', async (t) => {
    if (skipAll) return t.skip('test setup failed')

    const r = await apiPatch(SERVICE_ID, {
      domain: 'unverified-domain.example.com',
      verification_token: 'a'.repeat(64),
      description: 'Should not update',
    })
    assert.equal(r.status, 403)
  })

  it('21. service hostname does not match claimed domain → 403', async (t) => {
    if (skipAll) return t.skip('test setup failed')

    const r = await apiPatch(OTHER_SERVICE_ID, {
      domain: DOMAIN,
      verification_token: TOKEN,
      description: 'Should not update — domain mismatch',
    })
    assert.equal(r.status, 403)
  })

  it('22. invalid service ID → 404', async (t) => {
    if (skipAll) return t.skip('test setup failed')

    const r = await apiPatch('nonexistent-service-id-12345', {
      domain: DOMAIN,
      verification_token: TOKEN,
      description: 'Should not update',
    })
    assert.equal(r.status, 404)
  })

  it('23. partial update (only category) → only category changes', async (t) => {
    if (skipAll) return t.skip('test setup failed')

    // Set known state first
    await apiPatch(SERVICE_ID, {
      domain: DOMAIN,
      verification_token: TOKEN,
      description: 'Stable description',
      category: 'original-cat',
    })

    // Partial update — only category
    const r = await apiPatch(SERVICE_ID, {
      domain: DOMAIN,
      verification_token: TOKEN,
      category: 'finance',
    })
    assert.equal(r.status, 200)
    assert.equal(r.body.category, 'finance')
    assert.equal(r.body.description, 'Stable description', 'description should be unchanged')
  })

  it('24. category too long → 400', async (t) => {
    if (skipAll) return t.skip('test setup failed')

    const r = await apiPatch(SERVICE_ID, {
      domain: DOMAIN,
      verification_token: TOKEN,
      category: 'x'.repeat(101),
    })
    assert.equal(r.status, 400)
    assert.ok(r.body.error.includes('category'))
  })

  it('25. missing domain/token → 400', async (t) => {
    if (skipAll) return t.skip('test setup failed')

    const r = await apiPatch(SERVICE_ID, {
      description: 'Missing auth fields entirely',
    })
    assert.equal(r.status, 400)
  })
})
