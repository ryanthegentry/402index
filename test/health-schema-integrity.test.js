/**
 * Health-check schema integrity (#313 Part 0 + Part A).
 *
 * The health_checks status enum existed in three unsynchronized copies (inline CREATE TABLE,
 * HEALTH_CHECK_STATUSES, test/helpers/test-db.js), so `not_acceptable` — which the classifier
 * has emitted for HTTP 406 since #297 — silently failed its CHECK constraint on every write.
 *
 * These tests pin the single source of truth, the insertability of every status the classifier
 * can actually emit, and a migration that is explicit-column, abort-safe, and loud on failure.
 *
 * Run: node --test test/health-schema-integrity.test.js
 */

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import Database from 'better-sqlite3'
import * as dbModule from '../src/db.js'
import { classifyHealthStatus } from '../src/health/checker.js'
import { createTestDb } from './helpers/test-db.js'

const db = dbModule.default
const { HEALTH_CHECK_STATUSES } = dbModule

// The constraint as it shipped before this issue — the state real production DBs are in.
const OLD_STATUS_CHECK = "'healthy', 'degraded', 'down', 'timeout', 'error', 'rate_limited', 'method_not_allowed'"

const TEST_PREFIX = 'test-schema-' + Date.now()
let counter = 0
const nextId = () => `${TEST_PREFIX}-${++counter}`

function insertService(database, id) {
  database.prepare(
    "INSERT INTO services (id, name, url, protocol, source) VALUES (?, 'Schema Test', ?, 'L402', 'test')"
  ).run(id, `https://${id}.example.com/api`)
  return id
}

afterEach(() => {
  db.prepare(`DELETE FROM health_checks WHERE service_id LIKE '${TEST_PREFIX}%'`).run()
  db.prepare(`DELETE FROM services WHERE id LIKE '${TEST_PREFIX}%'`).run()
})

/**
 * Drive the classifier across the HTTP status / outcome matrix and collect every checkStatus it
 * can emit. Deliberately derived from behavior — a hand-maintained array in the test would drift
 * exactly the way the three schema copies did.
 */
function emittableCheckStatuses() {
  const found = new Set()
  const httpCases = [200, 201, 204, 301, 302, 400, 401, 402, 403, 404, 405, 406, 410, 429, 500, 502, 503, 504]
  const errorCases = [null, 'timeout', 'fetch failed', 'blocked: non-http(s) scheme']
  const latencyCases = [[null, 100, 0], [100, 500, 0], [100, 500, 2], [100, 500, 5], [100, 100, 0]]

  for (const httpStatus of httpCases) {
    for (const errorMessage of errorCases) {
      for (const prevFailures of [0, 1, 2, 5]) {
        for (const [p50, responseTime, spikes] of latencyCases) {
          const { checkStatus } = classifyHealthStatus(httpStatus, errorMessage, prevFailures, p50, responseTime, spikes)
          found.add(checkStatus)
        }
      }
    }
  }
  return [...found]
}

/** A scratch DB shaped like prod, with the health_checks constraint under test. */
function createFixtureDb({ statusCheck = OLD_STATUS_CHECK, columnOrder = 'canonical' } = {}) {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  database.exec(`
    CREATE TABLE services (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      protocol TEXT NOT NULL CHECK(protocol IN ('L402', 'x402', 'both', 'MPP')),
      source TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      provider_deleted INTEGER DEFAULT 0,
      probe_status TEXT DEFAULT 'probeable',
      deleted_at TEXT
    );
  `)

  // Column order differs between real production DBs (rebuilt by earlier migrations) and a fresh
  // CREATE TABLE. A positional `INSERT INTO ... SELECT *` copy silently shuffles values between
  // columns; the 'shuffled' variant makes that failure observable.
  const columns = columnOrder === 'shuffled'
    ? `id INTEGER PRIMARY KEY AUTOINCREMENT,
       service_id TEXT NOT NULL REFERENCES services(id),
       status TEXT NOT NULL CHECK(status IN (${statusCheck})),
       http_status INTEGER,
       error_message TEXT,
       response_time_ms INTEGER,
       checked_at TEXT NOT NULL DEFAULT (datetime('now'))`
    : `id INTEGER PRIMARY KEY AUTOINCREMENT,
       service_id TEXT NOT NULL REFERENCES services(id),
       checked_at TEXT NOT NULL DEFAULT (datetime('now')),
       status TEXT NOT NULL CHECK(status IN (${statusCheck})),
       response_time_ms INTEGER,
       http_status INTEGER,
       error_message TEXT`

  database.exec(`
    CREATE TABLE health_checks (${columns});
    CREATE INDEX idx_health_checks_service ON health_checks(service_id, checked_at);
  `)
  insertService(database, 'fixture-svc')
  return database
}

function captureLogger() {
  const calls = { error: [], warn: [], log: [] }
  return {
    calls,
    error: (...args) => calls.error.push(args.join(' ')),
    warn: (...args) => calls.warn.push(args.join(' ')),
    log: (...args) => calls.log.push(args.join(' ')),
  }
}

describe('HEALTH_CHECK_STATUSES is the single source of truth', () => {
  it('includes not_acceptable — the status the classifier emits for HTTP 406', () => {
    assert.ok(
      HEALTH_CHECK_STATUSES.includes('not_acceptable'),
      'HEALTH_CHECK_STATUSES must include not_acceptable'
    )
  })

  it('exports a DDL generator derived from the list', () => {
    assert.equal(typeof dbModule.healthChecksTableDDL, 'function', 'db.js must export healthChecksTableDDL')
    const ddl = dbModule.healthChecksTableDDL()
    for (const status of HEALTH_CHECK_STATUSES) {
      assert.ok(ddl.includes(`'${status}'`), `generated DDL must allow ${status}`)
    }
    assert.ok(ddl.includes('CREATE TABLE health_checks'), 'defaults to the real table name')
    assert.ok(
      dbModule.healthChecksTableDDL('health_checks_new').includes('CREATE TABLE health_checks_new'),
      'accepts an alternate table name for the rebuild'
    )
  })

  it('the live schema allows exactly the canonical list', () => {
    const ddl = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'health_checks'"
    ).get().sql
    for (const status of HEALTH_CHECK_STATUSES) {
      assert.ok(ddl.includes(`'${status}'`), `live health_checks DDL must allow ${status}`)
    }
  })

  it('every canonical status inserts through the real src/db.js schema', () => {
    const id = insertService(db, nextId())
    for (const status of HEALTH_CHECK_STATUSES) {
      assert.doesNotThrow(
        () => db.prepare('INSERT INTO health_checks (service_id, status) VALUES (?, ?)').run(id, status),
        `status ${status} must be insertable`
      )
    }
  })

  it('the test helper derives its schema from the same list', () => {
    const testDb = createTestDb()
    insertService(testDb, 'helper-svc')
    for (const status of HEALTH_CHECK_STATUSES) {
      assert.doesNotThrow(
        () => testDb.prepare('INSERT INTO health_checks (service_id, status) VALUES (?, ?)').run('helper-svc', status),
        `test-db.js must allow ${status}`
      )
    }
    testDb.close()
  })
})

describe('emittable-status coverage', () => {
  it('the classifier matrix reaches not_acceptable (matrix sanity)', () => {
    assert.ok(emittableCheckStatuses().includes('not_acceptable'), 'matrix must exercise HTTP 406')
  })

  it('every status the classifier can emit is in the canonical list', () => {
    for (const status of emittableCheckStatuses()) {
      assert.ok(HEALTH_CHECK_STATUSES.includes(status), `classifier emits ${status}, which the enum omits`)
    }
  })

  it('every status the classifier can emit inserts through the real schema', () => {
    const id = insertService(db, nextId())
    for (const status of emittableCheckStatuses()) {
      assert.doesNotThrow(
        () => db.prepare('INSERT INTO health_checks (service_id, status) VALUES (?, ?)').run(id, status),
        `emitted status ${status} must be insertable`
      )
    }
  })

  it('every emittable status inserts on an old-constraint DB after the real migration path', () => {
    const fixture = createFixtureDb()
    assert.equal(dbModule.migrateHealthChecksStatusConstraint(fixture), true, 'old constraint needs migrating')

    for (const status of emittableCheckStatuses()) {
      assert.doesNotThrow(
        () => fixture.prepare('INSERT INTO health_checks (service_id, status) VALUES (?, ?)').run('fixture-svc', status),
        `migrated DB must accept ${status}`
      )
    }
    fixture.close()
  })
})

describe('migration detection by insertability probe', () => {
  it('reports the statuses the current constraint rejects', () => {
    const fixture = createFixtureDb()
    assert.equal(typeof dbModule.probeHealthCheckStatuses, 'function', 'db.js must export probeHealthCheckStatuses')
    assert.deepEqual(dbModule.probeHealthCheckStatuses(fixture), ['not_acceptable'])
    fixture.close()
  })

  it('reports nothing once the table is current', () => {
    const fixture = createFixtureDb()
    dbModule.migrateHealthChecksStatusConstraint(fixture)
    assert.deepEqual(dbModule.probeHealthCheckStatuses(fixture), [])
    fixture.close()
  })

  it('leaves no rows behind — the probe runs inside a rolled-back transaction', () => {
    const fixture = createFixtureDb()
    fixture.prepare("INSERT INTO health_checks (service_id, status) VALUES ('fixture-svc', 'healthy')").run()
    const servicesBefore = fixture.prepare('SELECT COUNT(*) c FROM services').get().c
    const checksBefore = fixture.prepare('SELECT COUNT(*) c FROM health_checks').get().c

    dbModule.probeHealthCheckStatuses(fixture)

    assert.equal(fixture.prepare('SELECT COUNT(*) c FROM services').get().c, servicesBefore)
    assert.equal(fixture.prepare('SELECT COUNT(*) c FROM health_checks').get().c, checksBefore)
    fixture.close()
  })

  it('detects a stale constraint even when the DDL text mentions the status', () => {
    // DDL-substring detection is fooled by a status name appearing anywhere in the CREATE TABLE
    // text (a column default, a comment). Only an insert proves insertability.
    const fixture = new Database(':memory:')
    fixture.exec(`
      CREATE TABLE services (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL,
        protocol TEXT NOT NULL, source TEXT NOT NULL
      );
      CREATE TABLE health_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service_id TEXT NOT NULL REFERENCES services(id),
        checked_at TEXT NOT NULL DEFAULT (datetime('now')),
        status TEXT NOT NULL CHECK(status IN (${OLD_STATUS_CHECK})),
        response_time_ms INTEGER,
        http_status INTEGER,
        error_message TEXT DEFAULT 'not_acceptable placeholder'
      );
    `)
    assert.deepEqual(dbModule.probeHealthCheckStatuses(fixture), ['not_acceptable'])
    fixture.close()
  })
})

describe('migration rebuild', () => {
  it('copies rows by explicit column list, not positional SELECT *', () => {
    const fixture = createFixtureDb({ columnOrder: 'shuffled' })
    fixture.prepare(`
      INSERT INTO health_checks (service_id, status, http_status, error_message, response_time_ms, checked_at)
      VALUES ('fixture-svc', 'down', 503, 'HTTP 503', 42, datetime('now', '-1 hour'))
    `).run()
    const before = fixture.prepare('SELECT * FROM health_checks').get()

    assert.equal(dbModule.migrateHealthChecksStatusConstraint(fixture), true)

    const row = fixture.prepare('SELECT * FROM health_checks').get()
    assert.equal(row.status, 'down', 'status must land in status')
    assert.equal(row.http_status, 503, 'http_status must land in http_status')
    assert.equal(row.error_message, 'HTTP 503')
    assert.equal(row.response_time_ms, 42)
    assert.equal(row.checked_at, before.checked_at)
    fixture.close()
  })

  it('prunes beyond retention before rebuilding', () => {
    const fixture = createFixtureDb()
    fixture.prepare(
      "INSERT INTO health_checks (service_id, status, checked_at) VALUES ('fixture-svc', 'healthy', datetime('now', '-10 days'))"
    ).run()
    fixture.prepare(
      "INSERT INTO health_checks (service_id, status) VALUES ('fixture-svc', 'healthy')"
    ).run()

    dbModule.migrateHealthChecksStatusConstraint(fixture)

    assert.equal(fixture.prepare('SELECT COUNT(*) c FROM health_checks').get().c, 1, 'stale row pruned, fresh row kept')
    fixture.close()
  })

  it('aborts without free space and leaves the original table intact and queryable', () => {
    const fixture = createFixtureDb()
    fixture.prepare("INSERT INTO health_checks (service_id, status) VALUES ('fixture-svc', 'healthy')").run()
    const noSpace = () => ({ blocks: 1000, bsize: 4096, bfree: 0 })

    assert.throws(
      () => dbModule.migrateHealthChecksStatusConstraint(fixture, { statfsSyncFn: noSpace }),
      /space/i
    )
    assert.equal(fixture.prepare('SELECT COUNT(*) c FROM health_checks').get().c, 1, 'rows survive')
    assert.deepEqual(dbModule.probeHealthCheckStatuses(fixture), ['not_acceptable'], 'still on the old constraint')
    fixture.close()
  })

  it('is idempotent and clears a leftover _new table from a killed run', () => {
    const fixture = createFixtureDb()
    fixture.exec('CREATE TABLE health_checks_new (id INTEGER PRIMARY KEY)')

    assert.equal(dbModule.migrateHealthChecksStatusConstraint(fixture), true, 'first run migrates')
    assert.equal(dbModule.migrateHealthChecksStatusConstraint(fixture), false, 'second run is a no-op')
    assert.equal(
      fixture.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name = 'health_checks_new'").get().c,
      0,
      'leftover table gone'
    )
    fixture.close()
  })
})

describe('migration failure is loud', () => {
  it('sets health_schema_invalid and logs at error level when the rebuild fails', () => {
    const fixture = createFixtureDb()
    // Orphan row: a health_check whose service no longer exists. The post-rebuild
    // foreign_key_check refuses to commit a table carrying it.
    fixture.pragma('foreign_keys = OFF')
    fixture.prepare("INSERT INTO health_checks (service_id, status) VALUES ('ghost-svc', 'healthy')").run()
    fixture.pragma('foreign_keys = ON')

    assert.equal(typeof dbModule.runHealthChecksSchemaGuard, 'function', 'db.js must export runHealthChecksSchemaGuard')
    const logger = captureLogger()
    const result = dbModule.runHealthChecksSchemaGuard(fixture, { logger })

    assert.equal(result.valid, false, 'guard must report an invalid schema')
    assert.ok(logger.calls.error.length > 0, 'must log at error level')
    assert.equal(logger.calls.warn.length, 0, 'must not downgrade the failure to a warning')
    assert.equal(dbModule.getCounter('health_schema_invalid', fixture), '1')
    // Abort-safe: the original table is intact and still queryable.
    assert.equal(fixture.prepare('SELECT COUNT(*) c FROM health_checks').get().c, 1)
    fixture.close()
  })

  it('clears health_schema_invalid once the schema is current', () => {
    const fixture = createFixtureDb()
    dbModule.ensureCountersTable(fixture)
    dbModule.setCounter('health_schema_invalid', '1', fixture)

    const result = dbModule.runHealthChecksSchemaGuard(fixture, { logger: captureLogger() })

    assert.equal(result.valid, true)
    assert.equal(result.migrated, true)
    assert.equal(dbModule.getCounter('health_schema_invalid', fixture), null, 'key removed when healthy')
    fixture.close()
  })

  it('the live boot left no invalid-schema flag', () => {
    assert.equal(dbModule.getCounter('health_schema_invalid'), null)
  })

  it('src/db.js no longer swallows the migration failure in a console.warn', () => {
    const source = readFileSync(new URL('../src/db.js', import.meta.url), 'utf8')
    assert.ok(
      !/health_checks migration note/.test(source),
      'the console.warn swallow path must be deleted, not reworded'
    )
  })
})

describe('counters table', () => {
  it('exists on the live DB with a key/value/updated_at shape', () => {
    const cols = db.pragma("table_info('counters')").map(c => c.name)
    assert.deepEqual(cols.sort(), ['key', 'updated_at', 'value'])
  })

  it('reads, writes, deletes and increments', () => {
    const fixture = new Database(':memory:')
    dbModule.ensureCountersTable(fixture)

    assert.equal(dbModule.getCounter('nope', fixture), null)
    assert.equal(dbModule.getCounterInt('nope', fixture), 0)

    dbModule.setCounter('thing', 'value', fixture)
    assert.equal(dbModule.getCounter('thing', fixture), 'value')

    assert.equal(dbModule.incrementCounter('tally', 1, fixture), 1)
    assert.equal(dbModule.incrementCounter('tally', 4, fixture), 5)
    assert.equal(dbModule.getCounterInt('tally', fixture), 5)

    dbModule.deleteCounter('tally', fixture)
    assert.equal(dbModule.getCounter('tally', fixture), null)
    fixture.close()
  })

  it('carries no retention', () => {
    const source = readFileSync(new URL('../src/db.js', import.meta.url), 'utf8')
    // Single-key deletes are key management (clearing health_schema_invalid); an age-based sweep
    // would make the lifetime counters lie the same way query_log did.
    assert.ok(
      !/DELETE FROM counters WHERE[^']*datetime\(/.test(source),
      'counters must have no age-based delete'
    )
    const pruneAll = source.match(/function pruneAll\(\)\s*\{[\s\S]*?\n\}/)
    assert.ok(pruneAll, 'pruneAll must exist')
    assert.ok(!/counter/i.test(pruneAll[0]), 'pruneAll must not touch counters')
  })

  it('is created by the test helper too', () => {
    const testDb = createTestDb()
    const cols = testDb.pragma("table_info('counters')").map(c => c.name)
    assert.deepEqual(cols.sort(), ['key', 'updated_at', 'value'])
    testDb.close()
  })
})
