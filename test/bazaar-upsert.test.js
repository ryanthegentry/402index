/**
 * TDD tests for Bazaar poller upsert bugs (issue #112).
 *
 * Bug A: ON CONFLICT WHERE guard silently drops re-listed soft-deleted services.
 * Bug B (normalizeItem): normalizeItem() throws on items with resource but no accepts array.
 *
 * These tests MUST FAIL against the current code and PASS after the fix.
 *
 * Run: DB_PATH=:memory: node --test test/bazaar-upsert.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'crypto'
import db from '../src/db.js'
import { normalizeItem } from '../src/aggregators/bazaar-utils.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function seedService(url, overrides = {}) {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO services (id, name, url, protocol, source, price_usd, payment_asset, payment_network, category, provider)
    VALUES (?, ?, ?, 'x402', 'bazaar', 0.01, 'USDC', 'Base', 'uncategorized', 'example')
  `).run(id, overrides.name || 'Test Service', url)
  if (Object.keys(overrides).length > 0) {
    for (const [col, val] of Object.entries(overrides)) {
      if (col === 'name') continue
      db.prepare(`UPDATE services SET ${col} = ? WHERE id = ?`).run(val, id)
    }
  }
  return id
}

function makeBazaarItem(url) {
  return {
    resource: url,
    accepts: [{
      resource: url,
      maxAmountRequired: '10000',
      network: 'base',
      description: 'Test service',
    }],
  }
}

// ─── Bug A: Upsert WHERE guard silently drops re-listed soft-deleted services ─

describe('Bug A: upsert reactivates soft-deleted services', () => {
  let originalFetch
  const testUrl = `https://bazaar-upsert-test-${Date.now()}.example.com/api`
  let serviceId

  beforeEach(() => {
    originalFetch = globalThis.fetch
    // Seed a soft-deleted service
    serviceId = seedService(testUrl, { provider_deleted: 1 })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    db.prepare('DELETE FROM services WHERE url = ? AND protocol = ?').run(testUrl, 'x402')
    db.prepare("DELETE FROM sync_state WHERE key IN ('bazaar_offset', 'bazaar_last_full_pass')").run()
  })

  it('sets provider_deleted = 0 when soft-deleted service reappears in Bazaar', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        pagination: { total: 1 },
        items: [makeBazaarItem(testUrl)],
      }),
    })

    const { pollBazaar } = await import(`../src/aggregators/bazaar.js?t=${Date.now()}`)
    await pollBazaar()

    const service = db.prepare('SELECT provider_deleted FROM services WHERE url = ? AND protocol = ?').get(testUrl, 'x402')
    assert.ok(service, 'service should exist in DB')
    // FAILS currently: WHERE guard prevents update → provider_deleted stays 1
    assert.equal(service.provider_deleted, 0, 'provider_deleted should be reset to 0 on reactivation')
  })

  it('sets approval_reason = "bazaar-relisted" on reactivation', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        pagination: { total: 1 },
        items: [makeBazaarItem(testUrl)],
      }),
    })

    const { pollBazaar } = await import(`../src/aggregators/bazaar.js?t=${Date.now() + 1}`)
    await pollBazaar()

    const service = db.prepare('SELECT approval_reason FROM services WHERE url = ? AND protocol = ?').get(testUrl, 'x402')
    assert.ok(service, 'service should exist in DB')
    // FAILS currently: WHERE guard prevents update → approval_reason stays NULL
    assert.equal(service.approval_reason, 'bazaar-relisted', 'approval_reason should be set to bazaar-relisted on reactivation')
  })

  it('counts reactivated service as new (findExisting excludes soft-deleted rows)', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        pagination: { total: 1 },
        items: [makeBazaarItem(testUrl)],
      }),
    })

    const { pollBazaar } = await import(`../src/aggregators/bazaar.js?t=${Date.now() + 2}`)
    const result = await pollBazaar()

    // FAILS currently: findExisting has no provider_deleted filter → returns the soft-deleted
    // row → updatedCount++ instead of newCount++
    assert.equal(result.new, 1, 'reactivated service should be counted as new (was soft-deleted)')
    assert.equal(result.updated, 0, 'updated count should not include soft-deleted reactivations')
  })
})

// ─── Bug B (normalizeItem): graceful degradation when accepts missing ──────────

describe('Bug B (normalizeItem): graceful degradation on missing accepts', () => {
  it('returns valid object with null price when accepts missing but resource present', () => {
    const item = { resource: 'https://example.com/api/v1' }

    // FAILS currently: normalizeItem throws 'missing accepts array'
    const result = normalizeItem(item)
    assert.ok(result, 'should return a valid object instead of throwing')
    assert.equal(result.url, 'https://example.com/api/v1', 'url should come from item.resource')
    assert.equal(result.price_usd, null, 'price_usd should be null when accepts is missing')
    assert.ok(result.id, 'should have a generated id')
  })

  it('throws when neither accepts nor resource is present', () => {
    // This should throw both before and after the fix
    assert.throws(() => normalizeItem({}), /missing accepts/)
    assert.throws(() => normalizeItem({ accepts: [] }), /missing accepts/)
  })
})
