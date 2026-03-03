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

describe('reject sets status=rejected (no FK violation)', () => {
  it('reject updates status instead of deleting (avoids FK constraint on health_checks)', () => {
    const url = TEST_URL + '/reject-fk-' + Date.now()
    const id = randomUUID()
    const params = makeParams({ id, url })
    const row = upsertStmt.get(params)
    inserted.push(row.id)
    assert.equal(row.status, 'pending')

    // Insert a health_check referencing this service (simulates scraped listing)
    db.prepare(
      "INSERT INTO health_checks (service_id, status, http_status, response_time_ms) VALUES (?, 'healthy', 402, 100)"
    ).run(id)

    // Reject via UPDATE (not DELETE) — should not throw FK constraint error
    const rejectStmt = db.prepare(
      "UPDATE services SET status = 'rejected', updated_at = datetime('now') WHERE id = @id AND status = 'pending'"
    )
    const result = rejectStmt.run({ id })
    assert.equal(result.changes, 1, 'should update one row')

    // Verify status is now rejected
    const after = db.prepare('SELECT status FROM services WHERE id = ?').get(id)
    assert.equal(after.status, 'rejected')

    // Verify health_check still exists (no cascade delete)
    const hc = db.prepare('SELECT COUNT(*) as c FROM health_checks WHERE service_id = ?').get(id)
    assert.ok(hc.c >= 1, 'health_check row should still exist')

    // Clean up health_checks
    db.prepare('DELETE FROM health_checks WHERE service_id = ?').run(id)
  })

  it('rejected services excluded from public queries', () => {
    const url = TEST_URL + '/reject-excluded-' + Date.now()
    const params = makeParams({ url })
    const row = upsertStmt.get(params)
    inserted.push(row.id)

    // Set to rejected
    db.prepare("UPDATE services SET status = 'rejected' WHERE id = ?").run(row.id)

    // Query with the same base filter used by public API
    const found = db.prepare(
      "SELECT COUNT(*) as c FROM services WHERE id = ? AND (status = 'active' OR status IS NULL)"
    ).get(row.id)
    assert.equal(found.c, 0, 'rejected service should not appear in public queries')
  })
})

describe('notification only fires on new insert (registered_at === updated_at)', () => {
  it('new insert has registered_at === updated_at', () => {
    const url = TEST_URL + '/notify-new-' + Date.now()
    const params = makeParams({ url })
    const row = upsertStmt.get(params)
    inserted.push(row.id)
    assert.equal(row.registered_at, row.updated_at, 'new insert should have matching timestamps')
  })

  it('upsert update has registered_at !== updated_at', () => {
    const url = TEST_URL + '/notify-upsert-' + Date.now()
    const params1 = makeParams({ url })
    const row1 = upsertStmt.get(params1)
    inserted.push(row1.id)

    // Advance time by setting registered_at to the past
    db.prepare("UPDATE services SET registered_at = datetime('now', '-1 hour') WHERE id = ?").run(row1.id)

    // Re-register same URL — updated_at gets datetime('now'), registered_at stays in the past
    const params2 = makeParams({ url, name: 'Updated' })
    const row2 = upsertStmt.get(params2)
    assert.notEqual(row2.registered_at, row2.updated_at, 'upsert should have different timestamps')
  })
})

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
