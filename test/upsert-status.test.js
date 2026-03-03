/**
 * Unit test: upsert preserves active status on re-registration.
 *
 * Run: node --test test/upsert-status.test.js
 */

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'crypto'
import db from '../src/db.js'

const TEST_URL = 'https://upsert-test-' + Date.now() + '.example.com/api'
const TEST_PROTOCOL = 'L402'

// Clean up test rows after each test
const inserted = []
afterEach(() => {
  for (const id of inserted) {
    db.prepare('DELETE FROM services WHERE id = ?').run(id)
  }
  inserted.length = 0
})

const upsertStmt = db.prepare(`
  INSERT INTO services (id, name, description, url, protocol, price_sats, price_usd, payment_asset, payment_network, category, provider, source, contact_email, health_status, status)
  VALUES (@id, @name, @description, @url, @protocol, @price_sats, @price_usd, @payment_asset, @payment_network, @category, @provider, 'self-registered', @contact_email, 'healthy', 'pending')
  ON CONFLICT(url, protocol) DO UPDATE SET
    name = excluded.name,
    description = COALESCE(excluded.description, services.description),
    price_sats = COALESCE(excluded.price_sats, services.price_sats),
    price_usd = COALESCE(excluded.price_usd, services.price_usd),
    payment_asset = COALESCE(excluded.payment_asset, services.payment_asset),
    payment_network = COALESCE(excluded.payment_network, services.payment_network),
    category = COALESCE(excluded.category, services.category),
    provider = COALESCE(excluded.provider, services.provider),
    contact_email = COALESCE(excluded.contact_email, services.contact_email),
    health_status = 'healthy',
    status = CASE WHEN services.status = 'active' THEN 'active' ELSE services.status END,
    updated_at = datetime('now')
  RETURNING *
`)

function makeParams(overrides = {}) {
  return {
    id: randomUUID(),
    name: 'Test Service',
    description: null,
    url: TEST_URL,
    protocol: TEST_PROTOCOL,
    price_sats: null,
    price_usd: null,
    payment_asset: null,
    payment_network: null,
    category: 'uncategorized',
    provider: null,
    contact_email: null,
    ...overrides,
  }
}

describe('registerUpsert status handling', () => {
  it('new insert gets status=pending', () => {
    const url = TEST_URL + '/new-' + Date.now()
    const params = makeParams({ url })
    const row = upsertStmt.get(params)
    inserted.push(row.id)
    assert.equal(row.status, 'pending')
  })

  it('re-register preserves active status', () => {
    const url = TEST_URL + '/active-' + Date.now()
    // First insert
    const params1 = makeParams({ url })
    const row1 = upsertStmt.get(params1)
    inserted.push(row1.id)
    assert.equal(row1.status, 'pending')

    // Approve it
    db.prepare("UPDATE services SET status = 'active' WHERE id = ?").run(row1.id)

    // Re-register same URL — status should stay active
    const params2 = makeParams({ url, name: 'Updated Name' })
    const row2 = upsertStmt.get(params2)
    assert.equal(row2.status, 'active', 'active status should be preserved on re-registration')
    assert.equal(row2.name, 'Updated Name', 'name should be updated')
  })

  it('re-register preserves pending status (does not re-pending)', () => {
    const url = TEST_URL + '/pending-' + Date.now()
    const params1 = makeParams({ url })
    const row1 = upsertStmt.get(params1)
    inserted.push(row1.id)
    assert.equal(row1.status, 'pending')

    // Re-register same URL — should stay pending
    const params2 = makeParams({ url, name: 'Updated' })
    const row2 = upsertStmt.get(params2)
    assert.equal(row2.status, 'pending')
  })
})
