/**
 * Domain Token Hashing — Tests A–D for issue #196
 *
 * Verifies that domain verification tokens are stored as SHA-256 hashes,
 * not raw hex, and that the migration from raw→hashed is idempotent.
 *
 * Run: node --test test/domain-token-hashing.test.js
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { startServer, stopServer } from './helpers/server.js'

let BASE
let API
let db

before(async () => {
  BASE = process.env.API_BASE || await startServer()
  API = `${BASE}/api/v1`
  try {
    const mod = await import('../src/db.js')
    db = mod.default
  } catch {
    // db import failed — tests requiring DB access will skip
  }
})

after(async () => {
  if (db) {
    try {
      db.prepare("DELETE FROM domain_claims WHERE domain LIKE '%.hash-test.example.com'").run()
      db.prepare("DELETE FROM services WHERE id LIKE 'ht-%'").run()
    } catch {
      // cleanup best-effort
    }
  }
  await stopServer()
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── Test A — storage is hashed ──────────────────────────────────────────────

describe('Domain token hashing — at-rest storage', () => {
  it('A: stored verification_token is SHA-256(raw), not the raw token', async (t) => {
    if (!db) return t.skip('requires DB access')

    const domain = `a-${randomUUID().slice(0, 8)}.hash-test.example.com`
    const r = await apiClaim({ domain })
    assert.equal(r.status, 201, `claim failed: ${JSON.stringify(r.body)}`)

    const rawToken = r.body.verification_token
    assert.ok(rawToken, 'response must include verification_token')

    // Read directly from DB
    const row = db.prepare('SELECT verification_token FROM domain_claims WHERE domain = ?').get(domain)
    assert.ok(row, 'domain_claims row must exist')

    // Stored value must NOT be the raw token
    assert.notEqual(row.verification_token, rawToken,
      'verification_token must not be stored as raw hex')

    // Stored value must equal SHA-256(rawToken)
    const expectedHash = createHash('sha256').update(rawToken).digest('hex')
    assert.equal(row.verification_token, expectedHash,
      'verification_token must be SHA-256(raw token)')
  })
})

// ─── Test B — .well-known flow unchanged ─────────────────────────────────────

describe('Domain token hashing — .well-known verification', () => {
  it('B: claim via API then verify with SHA-256(rawToken) in .well-known succeeds', async (t) => {
    if (!db) return t.skip('requires DB access')

    const { verifyClaim } = await import('../src/services/domain-verify.js')
    if (!verifyClaim) return t.skip('verifyClaim not exported')

    // Use example.com — resolves to a public IP, passes SSRF check
    const domain = 'example.com'

    // Clean up prior state
    try { db.prepare("DELETE FROM domain_claims WHERE domain = ?").run(domain) } catch {}

    // Claim via API — token gets stored (raw in current code, hashed after fix)
    const r = await apiClaim({ domain })
    assert.ok(r.status === 200 || r.status === 201, `claim failed: ${JSON.stringify(r.body)}`)
    const rawToken = r.body.verification_token
    const hashContent = createHash('sha256').update(rawToken).digest('hex')

    try {
      // Read stored value — after fix, this should be hashContent, not rawToken
      const row = db.prepare('SELECT verification_token FROM domain_claims WHERE domain = ?').get(domain)

      // The .well-known content is SHA-256(rawToken). After fix, stored value IS SHA-256(rawToken).
      // hashMatchesToken must work: direct comparison of stored hash vs received hash.
      // With current code: hashMatchesToken does SHA-256(stored_raw) vs received — also works.
      // So we additionally assert stored != raw (same as Test A, but for the verify flow).
      assert.notEqual(row.verification_token, rawToken,
        'stored token must be hashed, not raw (verify flow)')

      const mockFetchFn = async () => ({
        status: 200,
        headers: { get: () => null },
        text: async () => hashContent,
      })

      const result = await verifyClaim(domain, { fetchFn: mockFetchFn })
      assert.equal(result.status, 200, `verify failed: ${JSON.stringify(result)}`)
      assert.equal(result.data.status, 'verified')
    } finally {
      try { db.prepare("DELETE FROM domain_claims WHERE domain = ?").run(domain) } catch {}
    }
  })
})

// ─── Test C — submitted raw token still authenticates ────────────────────────

describe('Domain token hashing — raw token authenticates', () => {
  it('C: PATCH /api/v1/services/:id with raw token succeeds', async (t) => {
    if (!db) return t.skip('requires DB access')

    const domain = `c-${randomUUID().slice(0, 8)}.hash-test.example.com`
    const r = await apiClaim({ domain })
    assert.equal(r.status, 201)
    const rawToken = r.body.verification_token

    // Manually verify the claim in DB so we can use the token for edits
    db.prepare("UPDATE domain_claims SET status = 'verified', verified_at = datetime('now') WHERE domain = ?")
      .run(domain)

    // Insert a test service under this domain
    const serviceId = `ht-${randomUUID().slice(0, 8)}`
    db.prepare(
      "INSERT INTO services (id, name, url, protocol, source, hostname, status) VALUES (?, ?, ?, 'L402', 'manual', ?, 'active')"
    ).run(serviceId, 'Test Svc', `https://${domain}/api/test`, domain)

    // PATCH with the raw token — should work (server hashes before comparing)
    const patch = await apiPatch(serviceId, {
      domain,
      verification_token: rawToken,
      name: 'Updated Name',
    })
    assert.equal(patch.status, 200, `patch failed: ${JSON.stringify(patch.body)}`)
    assert.equal(patch.body.name, 'Updated Name')
  })
})

// ─── Test D — migration idempotency ─────────────────────────────────────────

describe('Domain token hashing — migration idempotency', () => {
  it('D: raw token rows get hashed; re-running migration is a no-op', async (t) => {
    if (!db) return t.skip('requires DB access')

    const dbMod = await import('../src/db.js')
    const migrateTokenHashes = dbMod.migrateTokenHashes
    assert.ok(typeof migrateTokenHashes === 'function',
      'db.js must export migrateTokenHashes as a named function')

    const rawHex = 'a'.repeat(64)
    const expectedHash = createHash('sha256').update(rawHex).digest('hex')
    const domain = `d-${randomUUID().slice(0, 8)}.hash-test.example.com`
    const id = randomUUID()

    // Seed a row with raw token and token_hashed = 0
    db.prepare(
      "INSERT INTO domain_claims (id, domain, verification_token, token_hashed, status, expires_at) VALUES (?, ?, ?, 0, 'pending', datetime('now', '+3 days'))"
    ).run(id, domain, rawHex)

    // Run migration
    migrateTokenHashes()

    // Verify hashed
    const row1 = db.prepare('SELECT verification_token, token_hashed FROM domain_claims WHERE id = ?').get(id)
    assert.equal(row1.verification_token, expectedHash, 'token must be hashed after migration')
    assert.equal(row1.token_hashed, 1, 'token_hashed flag must be 1')

    // Re-run migration — must be idempotent (no double-hashing)
    migrateTokenHashes()

    const row2 = db.prepare('SELECT verification_token, token_hashed FROM domain_claims WHERE id = ?').get(id)
    assert.equal(row2.verification_token, expectedHash, 'token must not be double-hashed')
    assert.equal(row2.token_hashed, 1, 'token_hashed flag must remain 1')

    // Verify that the raw token still authenticates against the hashed row
    // by running through editService which calls tokensMatch internally
    const { editService } = await import('../src/services/domain-verify.js')

    // Mark claim as verified so editService can use it
    db.prepare("UPDATE domain_claims SET status = 'verified', verified_at = datetime('now') WHERE id = ?").run(id)

    // Insert a test service under the domain
    const svcId = `ht-migr-${randomUUID().slice(0, 8)}`
    db.prepare(
      "INSERT INTO services (id, name, url, protocol, source, hostname, status) VALUES (?, ?, ?, 'L402', 'manual', ?, 'active')"
    ).run(svcId, 'Migration Test', `https://${domain}/api/test`, domain)

    const result = editService(svcId, { domain, verification_token: rawHex, name: 'Post-Migration' })
    assert.equal(result.status, 200, `editService must accept raw token after migration: ${JSON.stringify(result)}`)
    assert.equal(result.data.name, 'Post-Migration')
  })
})
