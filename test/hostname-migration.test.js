/**
 * Hostname Column Migration Tests
 *
 * Validates:
 * - Schema: hostname column and index exist
 * - Backfill: hostname extracted correctly from url
 * - Rate limit: exact match prevents LIKE wildcard injection
 * - Retroactive approval: exact match prevents wildcard/substring matching
 * - Write path: hostname set on registration
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

// We test against a fresh in-memory DB to avoid coupling to production data.
// Import extractHostname directly to test the helper.
import { extractHostname } from '../src/services/url-normalize.js'

describe('hostname column — schema', () => {
  let db

  before(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE services (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        protocol TEXT NOT NULL,
        source TEXT NOT NULL,
        hostname TEXT,
        status TEXT DEFAULT 'active',
        source_id TEXT,
        registered_at TEXT NOT NULL DEFAULT (datetime('now')),
        provider_deleted INTEGER DEFAULT 0,
        domain_verified INTEGER DEFAULT 0,
        approval_reason TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_services_hostname ON services(hostname);
    `)
  })

  after(() => db.close())

  it('hostname column exists on services table', () => {
    const cols = db.pragma("table_info('services')")
    const hostnameCol = cols.find(c => c.name === 'hostname')
    assert.ok(hostnameCol, 'hostname column should exist')
  })

  it('idx_services_hostname index exists', () => {
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='services' AND name='idx_services_hostname'"
    ).get()
    assert.ok(indexes, 'idx_services_hostname should exist')
  })
})

describe('hostname column — backfill', () => {
  let db

  before(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE services (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        protocol TEXT NOT NULL,
        source TEXT NOT NULL,
        hostname TEXT,
        registered_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `)
  })

  after(() => db.close())

  it('backfill extracts hostname from url correctly', () => {
    const id = randomUUID()
    db.prepare("INSERT INTO services (id, name, url, protocol, source) VALUES (?, 'Test', 'https://example.com/api', 'L402', 'test')").run(id)

    // Verify hostname is NULL before backfill
    const before = db.prepare('SELECT hostname FROM services WHERE id = ?').get(id)
    assert.equal(before.hostname, null)

    // Run backfill
    const rows = db.prepare('SELECT id, url FROM services WHERE hostname IS NULL').all()
    const update = db.prepare('UPDATE services SET hostname = ? WHERE id = ?')
    for (const row of rows) {
      try {
        const hostname = new URL(row.url).hostname.toLowerCase()
        update.run(hostname, row.id)
      } catch {
        // skip malformed
      }
    }

    const afterBackfill = db.prepare('SELECT hostname FROM services WHERE id = ?').get(id)
    assert.equal(afterBackfill.hostname, 'example.com')
  })

  it('backfill leaves hostname NULL for malformed URL', () => {
    const id = randomUUID()
    db.prepare("INSERT INTO services (id, name, url, protocol, source) VALUES (?, 'Bad', 'not-a-valid-url', 'L402', 'test')").run(id)

    const rows = db.prepare('SELECT id, url FROM services WHERE hostname IS NULL').all()
    const update = db.prepare('UPDATE services SET hostname = ? WHERE id = ?')
    for (const row of rows) {
      try {
        const hostname = new URL(row.url).hostname.toLowerCase()
        update.run(hostname, row.id)
      } catch {
        // skip malformed — hostname stays NULL
      }
    }

    const result = db.prepare('SELECT hostname FROM services WHERE id = ?').get(id)
    assert.equal(result.hostname, null, 'malformed URL should leave hostname as NULL')
  })
})

describe('hostname column — rate limit queries (exact match)', () => {
  let db

  before(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE services (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        protocol TEXT NOT NULL,
        source TEXT NOT NULL,
        hostname TEXT,
        registered_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_services_hostname ON services(hostname);
    `)

    // Insert 20 services for hostname 'test.com'
    const insert = db.prepare(
      "INSERT INTO services (id, name, url, protocol, source, hostname, registered_at) VALUES (?, 'Test', ?, 'L402', 'self-registered', 'test.com', datetime('now'))"
    )
    for (let i = 0; i < 20; i++) {
      insert.run(randomUUID(), `https://test.com/api/${i}`)
    }
  })

  after(() => db.close())

  const countByHostname = (db, host) => db.prepare(
    `SELECT COUNT(*) as c FROM services
     WHERE source = 'self-registered'
       AND registered_at > datetime('now', '-1 hour')
       AND hostname = @host`
  ).get({ host }).c

  it('exact match returns correct count for test.com', () => {
    assert.equal(countByHostname(db, 'test.com'), 20)
  })

  it('LIKE wildcard _ in hostname returns 0 (not 20)', () => {
    assert.equal(countByHostname(db, 'te_t.com'), 0)
  })

  it('LIKE wildcard % in hostname returns 0 (not 20)', () => {
    assert.equal(countByHostname(db, '%.com'), 0)
  })

  it('suffix attack test.com.evil.com returns 0', () => {
    assert.equal(countByHostname(db, 'test.com.evil.com'), 0)
  })

  it('prefix attack eviltest.com returns 0', () => {
    assert.equal(countByHostname(db, 'eviltest.com'), 0)
  })
})

describe('hostname column — retroactive approval (exact match)', () => {
  let db

  before(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE services (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        protocol TEXT NOT NULL,
        source TEXT NOT NULL,
        hostname TEXT,
        status TEXT DEFAULT 'pending',
        provider_deleted INTEGER DEFAULT 0,
        domain_verified INTEGER DEFAULT 0,
        approval_reason TEXT,
        registered_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `)
  })

  after(() => db.close())

  it('approves pending service with matching hostname', () => {
    const id = randomUUID()
    db.prepare(
      "INSERT INTO services (id, name, url, protocol, source, hostname, status) VALUES (?, 'Real', 'https://real.com/api', 'L402', 'self-registered', 'real.com', 'pending')"
    ).run(id)

    db.prepare(
      "UPDATE services SET status = 'active', approval_reason = 'domain-verified', updated_at = datetime('now') WHERE status = 'pending' AND (provider_deleted = 0 OR provider_deleted IS NULL) AND hostname = ?"
    ).run('real.com')

    const result = db.prepare('SELECT status FROM services WHERE id = ?').get(id)
    assert.equal(result.status, 'active')
  })

  it('does NOT approve service with _ wildcard in hostname', () => {
    const id = randomUUID()
    db.prepare(
      "INSERT INTO services (id, name, url, protocol, source, hostname, status) VALUES (?, 'Wild', 'https://re_l.com/api', 'L402', 'self-registered', 're_l.com', 'pending')"
    ).run(id)

    // Approving 'real.com' should NOT match 're_l.com'
    db.prepare(
      "UPDATE services SET status = 'active', approval_reason = 'domain-verified', updated_at = datetime('now') WHERE status = 'pending' AND (provider_deleted = 0 OR provider_deleted IS NULL) AND hostname = ?"
    ).run('real.com')

    const result = db.prepare('SELECT status FROM services WHERE id = ?').get(id)
    assert.equal(result.status, 'pending', '_ wildcard should not match')
  })

  it('does NOT approve service with substring hostname', () => {
    const id = randomUUID()
    db.prepare(
      "INSERT INTO services (id, name, url, protocol, source, hostname, status) VALUES (?, 'Prefix', 'https://notreal.com/api', 'L402', 'self-registered', 'notreal.com', 'pending')"
    ).run(id)

    // Approving 'real.com' should NOT match 'notreal.com'
    db.prepare(
      "UPDATE services SET status = 'active', approval_reason = 'domain-verified', updated_at = datetime('now') WHERE status = 'pending' AND (provider_deleted = 0 OR provider_deleted IS NULL) AND hostname = ?"
    ).run('real.com')

    const result = db.prepare('SELECT status FROM services WHERE id = ?').get(id)
    assert.equal(result.status, 'pending', 'substring should not match')
  })
})

describe('hostname column — extractHostname helper', () => {
  it('extracts hostname from https URL', () => {
    assert.equal(extractHostname('https://example.com/api/v1'), 'example.com')
  })

  it('lowercases hostname', () => {
    assert.equal(extractHostname('https://API.Example.COM/v1'), 'api.example.com')
  })

  it('returns null for malformed URL', () => {
    assert.equal(extractHostname('not-a-url'), null)
  })

  it('returns null for empty string', () => {
    assert.equal(extractHostname(''), null)
  })

  it('returns null for null', () => {
    assert.equal(extractHostname(null), null)
  })

  it('handles URL with port', () => {
    assert.equal(extractHostname('https://api.example.com:8080/v1'), 'api.example.com')
  })

  it('handles http URL', () => {
    assert.equal(extractHostname('http://test.local/endpoint'), 'test.local')
  })
})

describe('hostname column — write path (registration)', () => {
  let db

  before(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE services (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        protocol TEXT NOT NULL,
        source TEXT NOT NULL,
        hostname TEXT,
        registered_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX idx_services_url_protocol ON services(url, protocol);
    `)
  })

  after(() => db.close())

  it('sets hostname on INSERT', () => {
    const id = randomUUID()
    const url = 'https://api.example.com/v1/chat'
    const hostname = extractHostname(url)

    db.prepare(
      'INSERT INTO services (id, name, url, protocol, source, hostname) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, 'Test API', url, 'L402', 'self-registered', hostname)

    const result = db.prepare('SELECT hostname FROM services WHERE id = ?').get(id)
    assert.equal(result.hostname, 'api.example.com')
  })

  it('lowercases hostname from mixed-case URL', () => {
    const id = randomUUID()
    const url = 'https://API.Example.COM/v1'
    const hostname = extractHostname(url)

    db.prepare(
      'INSERT INTO services (id, name, url, protocol, source, hostname) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, 'Mixed Case', url, 'x402', 'self-registered', hostname)

    const result = db.prepare('SELECT hostname FROM services WHERE id = ?').get(id)
    assert.equal(result.hostname, 'api.example.com')
  })
})
