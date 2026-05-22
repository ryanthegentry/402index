import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'crypto'
import db from '../src/db.js'
import { registerUpsert } from '../src/services/service-registration.js'

// Unit tests for the shared registerUpsert helper. Pins the insert/update
// contract that admin protocol-change approval and self-registration both
// depend on (src/routes/api/admin.js + src/routes/api/register.js).

const TEST_HOST_PREFIX = `svc-reg-test-${process.pid}-${Date.now()}`

function makeParams(overrides = {}) {
  const host = `${TEST_HOST_PREFIX}-${randomUUID().slice(0, 8)}.example.com`
  return {
    id: randomUUID(),
    name: 'Test Service',
    description: 'unit test fixture',
    url: `https://${host}/api`,
    protocol: 'L402',
    price_sats: 100,
    price_usd: 0.01,
    payment_asset: 'BTC',
    payment_network: 'Lightning',
    category: 'tools',
    provider: 'Test Provider',
    contact_email: 'test@example.com',
    http_method: 'GET',
    probe_body: null,
    hostname: host,
    ...overrides,
  }
}

const inserted = []
beforeEach(() => { inserted.length = 0 })
after(() => {
  for (const id of inserted) {
    try { db.prepare('DELETE FROM services WHERE id = ?').run(id) } catch {}
  }
})

describe('service-registration — registerUpsert', () => {
  it('inserts a new row with status=pending and source=self-registered', () => {
    const params = makeParams()
    const row = registerUpsert().get(params)
    inserted.push(row.id)

    assert.equal(row.status, 'pending', 'new row should default to pending')
    assert.equal(row.source, 'self-registered', 'new row should be self-registered')
    assert.equal(row.health_status, 'healthy', 'new row should start healthy (probe validated)')
    assert.equal(row.name, params.name)
    assert.equal(row.url, params.url)
    assert.equal(row.protocol, params.protocol)
    assert.equal(row.price_sats, params.price_sats)
    assert.equal(row.hostname, params.hostname)
  })

  it('preserves status=active on (url, protocol) conflict via CASE clause', () => {
    const params = makeParams()
    const first = registerUpsert().get(params)
    inserted.push(first.id)

    // Promote to active (simulates approval)
    db.prepare("UPDATE services SET status = 'active' WHERE id = ?").run(first.id)

    // Re-register the same (url, protocol) — the CASE clause must NOT downgrade.
    const second = registerUpsert().get({ ...params, id: randomUUID(), name: 'Updated Name' })

    assert.equal(second.status, 'active',
      'CASE clause must preserve active status across re-registration')
    assert.equal(second.id, first.id, 'upsert should return the existing row by (url, protocol)')
    assert.equal(second.name, 'Updated Name', 'name should be updated from new params')
  })

  it('COALESCES nullable params (does not overwrite existing values with NULL)', () => {
    const params = makeParams({
      description: 'original description',
      price_sats: 250,
      payment_asset: 'BTC',
      contact_email: 'original@example.com',
    })
    const first = registerUpsert().get(params)
    inserted.push(first.id)

    // Re-register with NULLs in COALESCED fields. Required fields (name, url,
    // protocol) stay populated because they're not COALESCED.
    const updateParams = {
      ...params,
      id: randomUUID(),
      name: 'New Name',
      description: null,
      price_sats: null,
      payment_asset: null,
      contact_email: null,
    }
    const second = registerUpsert().get(updateParams)

    assert.equal(second.id, first.id)
    assert.equal(second.name, 'New Name', 'name is not COALESCED — it updates')
    assert.equal(second.description, 'original description', 'description must be preserved via COALESCE')
    assert.equal(second.price_sats, 250, 'price_sats must be preserved via COALESCE')
    assert.equal(second.payment_asset, 'BTC', 'payment_asset must be preserved via COALESCE')
    assert.equal(second.contact_email, 'original@example.com', 'contact_email must be preserved via COALESCE')
  })
})
