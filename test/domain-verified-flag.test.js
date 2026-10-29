/**
 * domain_verified flag on services approved because their domain is verified (#300)
 *
 * Run: node --test test/domain-verified-flag.test.js
 *
 * Tests cover:
 *   verifyClaim             — pending rows it retro-approves also get domain_verified=1
 *   approveDomainVerified   — the register auto-approve path sets domain_verified=1
 *   backfillDomainVerified  — repairs active rows on verified domains that missed the flag
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

function hashToken(raw) { return createHash('sha256').update(raw).digest('hex') }

let db, backfillDomainVerified, verifyClaim, approveDomainVerified
before(async () => {
  const dbMod = await import('../src/db.js')
  db = dbMod.default
  backfillDomainVerified = dbMod.backfillDomainVerified
  const dv = await import('../src/services/domain-verify.js')
  verifyClaim = dv.verifyClaim
  approveDomainVerified = dv.approveDomainVerified
})

function insertClaim(domain, status) {
  db.prepare(
    "INSERT INTO domain_claims (id, domain, verification_token, status, expires_at) VALUES (?, ?, ?, ?, datetime('now', '+3 days'))"
  ).run(randomUUID(), domain, hashToken(randomUUID()), status)
}

function insertService(id, hostname, status, domainVerified = 0) {
  db.prepare(
    "INSERT INTO services (id, name, url, protocol, source, status, domain_verified, hostname) VALUES (?, ?, ?, 'x402', 'self-registered', ?, ?, ?)"
  ).run(id, id, `https://${hostname}/api/${id}`, status, domainVerified, hostname)
}

function row(id) {
  return db.prepare('SELECT status, approval_reason, domain_verified FROM services WHERE id = ?').get(id)
}

after(() => {
  db.prepare("DELETE FROM services WHERE id LIKE 'dvf-%'").run()
  db.prepare("DELETE FROM domain_claims WHERE domain = 'example.com' OR domain LIKE '%.dvf-test.example'").run()
})

describe('domain_verified on domain-verified approvals (#300)', () => {
  it('verifyClaim sets domain_verified=1 on pending rows it approves', async () => {
    // example.com: verifyClaim resolves the domain for its SSRF check
    const domain = 'example.com'
    const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
    db.prepare(
      "INSERT INTO domain_claims (id, domain, verification_token, status, expires_at) VALUES (?, ?, ?, 'pending', datetime('now', '+3 days'))"
    ).run(randomUUID(), domain, hashToken(token))
    insertService('dvf-verify-active', domain, 'active')
    insertService('dvf-verify-pending', domain, 'pending')

    const hash = createHash('sha256').update(token).digest('hex')
    const mockFetch = async () => ({ status: 200, text: async () => hash, headers: { get: () => null } })
    const result = await verifyClaim(domain, { fetchFn: mockFetch })
    assert.equal(result.status, 200)

    assert.equal(row('dvf-verify-active').domain_verified, 1)
    const approved = row('dvf-verify-pending')
    assert.equal(approved.status, 'active')
    assert.equal(approved.approval_reason, 'domain-verified')
    assert.equal(approved.domain_verified, 1, 'a row approved by verification must carry the flag')
  })

  it('approveDomainVerified activates a pending row and sets domain_verified=1', () => {
    insertService('dvf-approve', 'a.dvf-test.example', 'pending')
    insertService('dvf-approve-other', 'a.dvf-test.example', 'pending')

    approveDomainVerified('dvf-approve')

    assert.deepEqual({ ...row('dvf-approve') }, { status: 'active', approval_reason: 'domain-verified', domain_verified: 1 })
    assert.equal(row('dvf-approve-other').status, 'pending', 'only the given row is approved')
  })

  it('register route approves verified-domain rows through approveDomainVerified', () => {
    const src = readFileSync(new URL('../src/routes/api/register.js', import.meta.url), 'utf8')
    assert.equal(src.match(/approveDomainVerified\(/g)?.length, 2, 'primary and bonus rows both use the helper')
    assert.ok(!/approval_reason = 'domain-verified'/.test(src), 'no inline UPDATE that could drop the flag')
  })

  it('backfillDomainVerified flags active rows on verified domains only, and is idempotent', () => {
    insertClaim('verified.dvf-test.example', 'verified')
    insertClaim('pending.dvf-test.example', 'pending')
    insertClaim('revoked.dvf-test.example', 'revoked')
    insertService('dvf-bf-verified-active', 'verified.dvf-test.example', 'active')
    insertService('dvf-bf-verified-pending', 'verified.dvf-test.example', 'pending')
    insertService('dvf-bf-pending-claim', 'pending.dvf-test.example', 'active')
    insertService('dvf-bf-revoked-claim', 'revoked.dvf-test.example', 'active')
    insertService('dvf-bf-no-claim', 'none.dvf-test.example', 'active')

    assert.equal(backfillDomainVerified(), 1)

    assert.equal(row('dvf-bf-verified-active').domain_verified, 1)
    assert.equal(row('dvf-bf-verified-pending').domain_verified, 0, 'matches verifyClaim: active rows only')
    assert.equal(row('dvf-bf-pending-claim').domain_verified, 0)
    assert.equal(row('dvf-bf-revoked-claim').domain_verified, 0)
    assert.equal(row('dvf-bf-no-claim').domain_verified, 0)

    assert.equal(backfillDomainVerified(), 0, 'second run changes nothing')
  })
})
