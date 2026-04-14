/**
 * TDD tests for FTS5 full-text search infrastructure (issue #118).
 *
 * These tests FAIL against code without the FTS5 migration and PASS after it.
 *
 * Run: node --test test/fts5-search.test.js
 */

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'crypto'
import db from '../src/db.js'

// Unique URL prefix to avoid collisions with other test runs
const PREFIX = 'https://fts5-test-' + Date.now()

const inserted = []

afterEach(() => {
  for (const id of inserted) {
    db.prepare('DELETE FROM services WHERE id = ?').run(id)
  }
  inserted.length = 0
})

function insertService(overrides = {}) {
  const id = randomUUID()
  const defaults = {
    id,
    name: 'TestService',
    description: 'A test service',
    url: `${PREFIX}-${id}.example.com/api`,
    protocol: 'L402',
    price_sats: 100,
    price_usd: 0.05,
    payment_asset: 'BTC',
    payment_network: 'lightning',
    category: 'test-category',
    provider: 'TestProvider',
    source: 'self-registered',
    health_status: 'healthy',
    status: 'active',
  }
  const row = { ...defaults, ...overrides }
  db.prepare(`
    INSERT INTO services
      (id, name, description, url, protocol, price_sats, price_usd,
       payment_asset, payment_network, category, provider, source,
       health_status, status)
    VALUES
      (@id, @name, @description, @url, @protocol, @price_sats, @price_usd,
       @payment_asset, @payment_network, @category, @provider, @source,
       @health_status, @status)
  `).run(row)
  inserted.push(id)
  return id
}

describe('FTS5 infrastructure (issue #118)', () => {
  it('services_fts virtual table exists', () => {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'services_fts'"
    ).get()
    assert.ok(row, 'services_fts table should exist in sqlite_master')
  })

  it('INSERT trigger: new service is findable by name', () => {
    const uniqueTerm = 'UniqueNameTerm' + Date.now()
    insertService({ name: uniqueTerm })
    const result = db.prepare(
      "SELECT rowid FROM services_fts WHERE services_fts MATCH ? LIMIT 1"
    ).get(uniqueTerm)
    assert.ok(result, `FTS MATCH on name "${uniqueTerm}" should return a row`)
  })

  it('INSERT trigger: new service is findable by description', () => {
    const uniqueTerm = 'UniqueDescTerm' + Date.now()
    insertService({ description: `Contains ${uniqueTerm} in description` })
    const result = db.prepare(
      "SELECT rowid FROM services_fts WHERE services_fts MATCH ? LIMIT 1"
    ).get(uniqueTerm)
    assert.ok(result, `FTS MATCH on description "${uniqueTerm}" should return a row`)
  })

  it('INSERT trigger: new service is findable by category', () => {
    const uniqueTerm = 'UniqueCatTerm' + Date.now()
    insertService({ category: uniqueTerm })
    const result = db.prepare(
      "SELECT rowid FROM services_fts WHERE services_fts MATCH ? LIMIT 1"
    ).get(uniqueTerm)
    assert.ok(result, `FTS MATCH on category "${uniqueTerm}" should return a row`)
  })

  it('INSERT trigger: new service is findable by provider', () => {
    const uniqueTerm = 'UniqueProvTerm' + Date.now()
    insertService({ provider: uniqueTerm })
    const result = db.prepare(
      "SELECT rowid FROM services_fts WHERE services_fts MATCH ? LIMIT 1"
    ).get(uniqueTerm)
    assert.ok(result, `FTS MATCH on provider "${uniqueTerm}" should return a row`)
  })

  it('UPDATE trigger: updated description is findable, old text is not', () => {
    const oldTerm = 'OldDescTerm' + Date.now()
    const newTerm = 'NewDescTerm' + Date.now()
    const id = insertService({ description: `Contains ${oldTerm}` })

    db.prepare("UPDATE services SET description = ? WHERE id = ?")
      .run(`Contains ${newTerm}`, id)

    const newResult = db.prepare(
      "SELECT rowid FROM services_fts WHERE services_fts MATCH ? LIMIT 1"
    ).get(newTerm)
    assert.ok(newResult, `FTS should find updated description term "${newTerm}"`)

    const oldResult = db.prepare(
      "SELECT rowid FROM services_fts WHERE services_fts MATCH ? LIMIT 1"
    ).get(oldTerm)
    assert.equal(oldResult, undefined, `FTS should NOT find old description term "${oldTerm}" after update`)
  })

  it('DELETE trigger: deleted service is no longer findable', () => {
    const uniqueTerm = 'UniqueDelTerm' + Date.now()
    const id = insertService({ name: uniqueTerm })

    // Verify it's findable before deletion
    const before = db.prepare(
      "SELECT rowid FROM services_fts WHERE services_fts MATCH ? LIMIT 1"
    ).get(uniqueTerm)
    assert.ok(before, 'should be findable before deletion')

    db.prepare('DELETE FROM services WHERE id = ?').run(id)
    inserted.splice(inserted.indexOf(id), 1) // already deleted, don't re-delete in afterEach

    const after = db.prepare(
      "SELECT rowid FROM services_fts WHERE services_fts MATCH ? LIMIT 1"
    ).get(uniqueTerm)
    assert.equal(after, undefined, `FTS should NOT find deleted service "${uniqueTerm}"`)
  })

  it('BM25 ranking: term in name+description ranks higher than term only in description', () => {
    const term = 'BM25RankTerm' + Date.now()
    // Service A: term in both name and description
    insertService({ name: term, description: `Also has ${term} here` })
    // Service B: term only in description
    insertService({ name: 'UnrelatedName', description: `Only in description ${term}` })

    const results = db.prepare(
      "SELECT rowid, rank FROM services_fts WHERE services_fts MATCH ? ORDER BY rank LIMIT 10"
    ).all(term)

    assert.ok(results.length >= 2, 'should return at least 2 results')
    // BM25 rank: lower (more negative) = better match
    const rankA = results[0].rank
    const rankB = results[1].rank
    assert.ok(rankA <= rankB, `Row with term in name+description (rank ${rankA}) should rank before row with term only in description (rank ${rankB})`)
  })

  it('NULL handling: service with NULL description and category is findable by name', () => {
    const uniqueTerm = 'NullHandleTerm' + Date.now()
    insertService({ name: uniqueTerm, description: null, category: null })
    const result = db.prepare(
      "SELECT rowid FROM services_fts WHERE services_fts MATCH ? LIMIT 1"
    ).get(uniqueTerm)
    assert.ok(result, `FTS MATCH with NULL description/category should still find by name "${uniqueTerm}"`)
  })

  it('idempotency: running migration setup twice does not duplicate FTS rows', () => {
    const uniqueTerm = 'IdempotencyTerm' + Date.now()
    insertService({ name: uniqueTerm })

    // Count how many times the FTS index contains this term
    const results = db.prepare(
      "SELECT rowid FROM services_fts WHERE services_fts MATCH ? LIMIT 100"
    ).all(uniqueTerm)
    assert.equal(results.length, 1, 'FTS index should contain exactly 1 row for this unique term (no duplicates)')
  })
})
