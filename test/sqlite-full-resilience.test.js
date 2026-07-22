// Regression guards for the 2026-07-22 SQLITE_FULL crash loop.
//
// The Railway volume filled up. Four separate defects turned "disk is full" into "the site is
// down twice in twelve hours", and each one is pinned here.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {
  migrateHealthChecksStatusConstraint,
  purgeSoftDeleted,
  HEALTH_CHECK_STATUSES,
} from '../src/db.js'
import { refreshDerivedState } from '../src/scheduler.js'
import { checkDiskSpace } from '../src/health/checker.js'
import { installProcessGuards } from '../src/util/process-guards.js'

const OLD_STATUSES = "'healthy', 'degraded', 'down', 'timeout', 'error'"

/** A scratch DB shaped like prod: services plus its two FK children. */
function createTestDb({ statusCheck = OLD_STATUSES } = {}) {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE services (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      protocol TEXT NOT NULL,
      provider_deleted INTEGER DEFAULT 0,
      deleted_at TEXT
    );
    CREATE TABLE health_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_id TEXT NOT NULL REFERENCES services(id),
      checked_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL CHECK(status IN (${statusCheck})),
      response_time_ms INTEGER,
      http_status INTEGER,
      error_message TEXT
    );
    CREATE TABLE service_embeddings (
      service_id TEXT PRIMARY KEY REFERENCES services(id) ON DELETE NO ACTION,
      embedding BLOB NOT NULL,
      model TEXT NOT NULL,
      embedded_at INTEGER NOT NULL
    );
  `)
  return db
}

function seedService(db, id, { deleted = false, ageDays = 0 } = {}) {
  db.prepare(
    `INSERT INTO services (id, name, url, protocol, provider_deleted, deleted_at)
     VALUES (?, ?, ?, 'L402', ?, ?)`
  ).run(
    id, `svc-${id}`, `https://example.com/${id}`,
    deleted ? 1 : 0,
    deleted ? new Date(Date.now() - ageDays * 86400_000).toISOString().replace('T', ' ').slice(0, 19) : null
  )
  db.prepare("INSERT INTO health_checks (service_id, status) VALUES (?, 'healthy')").run(id)
  db.prepare('INSERT INTO service_embeddings (service_id, embedding, model, embedded_at) VALUES (?, ?, ?, ?)')
    .run(id, Buffer.alloc(16), 'test-model', 1)
}

describe('health_checks status CHECK migration', () => {
  it('rebuilds the table when the constraint is missing values, preserving rows', () => {
    const db = createTestDb()
    seedService(db, 'a')

    assert.equal(migrateHealthChecksStatusConstraint(db), true, 'should report a rebuild')
    assert.equal(db.prepare('SELECT COUNT(*) c FROM health_checks').get().c, 1, 'rows preserved')

    // The whole point of the migration: the new statuses now insert cleanly.
    assert.doesNotThrow(() =>
      db.prepare("INSERT INTO health_checks (service_id, status) VALUES ('a', 'rate_limited')").run()
    )
    assert.doesNotThrow(() =>
      db.prepare("INSERT INTO health_checks (service_id, status) VALUES ('a', 'method_not_allowed')").run()
    )
  })

  it('is a no-op on second run — does not rewrite the table every boot', () => {
    const db = createTestDb()
    seedService(db, 'a')

    assert.equal(migrateHealthChecksStatusConstraint(db), true, 'first run migrates')
    // Regression: detection used a probe INSERT that always failed the services FK under
    // `foreign_keys = ON`, so every boot rewrote the entire table.
    assert.equal(migrateHealthChecksStatusConstraint(db), false, 'second run must be a no-op')
  })

  it('recovers when a previous run died part-way and left health_checks_new behind', () => {
    const db = createTestDb()
    seedService(db, 'a')
    // Exactly the prod wedge: an orphan table blocked the migration on every subsequent boot.
    db.exec('CREATE TABLE health_checks_new (id INTEGER PRIMARY KEY)')

    assert.equal(migrateHealthChecksStatusConstraint(db), true, 'should clear the orphan and migrate')
    assert.equal(db.prepare('SELECT COUNT(*) c FROM health_checks').get().c, 1)
    const leftovers = db.prepare(
      "SELECT COUNT(*) c FROM sqlite_master WHERE name = 'health_checks_new'"
    ).get().c
    assert.equal(leftovers, 0, 'orphan table must be gone')
  })

  it('accepts every status the checker can emit', () => {
    const db = createTestDb()
    seedService(db, 'a')
    migrateHealthChecksStatusConstraint(db)

    for (const status of HEALTH_CHECK_STATUSES) {
      assert.doesNotThrow(
        () => db.prepare('INSERT INTO health_checks (service_id, status) VALUES (?, ?)').run('a', status),
        `status ${status} should be allowed`
      )
    }
  })
})

describe('purgeSoftDeleted', () => {
  it('deletes FK children first so the purge actually succeeds', () => {
    const db = createTestDb()
    seedService(db, 'old', { deleted: true, ageDays: 45 })

    // Regression: deleting services while health_checks/service_embeddings still referenced them
    // failed with "FOREIGN KEY constraint failed", so nothing was ever purged.
    assert.equal(purgeSoftDeleted(db), 1, 'one service purged')
    assert.equal(db.prepare('SELECT COUNT(*) c FROM services').get().c, 0)
    assert.equal(db.prepare('SELECT COUNT(*) c FROM health_checks').get().c, 0)
    assert.equal(db.prepare('SELECT COUNT(*) c FROM service_embeddings').get().c, 0, 'embeddings freed too')
  })

  it('leaves recent soft-deletes and live services alone', () => {
    const db = createTestDb()
    seedService(db, 'recent', { deleted: true, ageDays: 5 })
    seedService(db, 'live')

    assert.equal(purgeSoftDeleted(db), 0)
    assert.equal(db.prepare('SELECT COUNT(*) c FROM services').get().c, 2)
    assert.equal(db.prepare('SELECT COUNT(*) c FROM health_checks').get().c, 2)
  })

  it('purges only the doomed rows when live services share the table', () => {
    const db = createTestDb()
    seedService(db, 'old', { deleted: true, ageDays: 45 })
    seedService(db, 'live')

    assert.equal(purgeSoftDeleted(db), 1)
    const survivors = db.prepare('SELECT id FROM services').all().map(r => r.id)
    assert.deepEqual(survivors, ['live'])
    assert.equal(db.prepare('SELECT COUNT(*) c FROM health_checks').get().c, 1)
  })
})

describe('scheduler refreshDerivedState', () => {
  it('returns true when both refreshes succeed', () => {
    assert.equal(refreshDerivedState({ featured: () => {}, classify: () => {} }), true)
  })

  it('swallows a SQLITE_FULL throw from classify instead of crashing the process', () => {
    // Regression: runPolls() had no .catch(), so this threw into an unhandled rejection and
    // Node exited. Stack from prod: classifyServices → scheduler.js:26.
    const boom = () => { const e = new Error('database or disk is full'); e.code = 'SQLITE_FULL'; throw e }
    let result
    assert.doesNotThrow(() => { result = refreshDerivedState({ featured: () => {}, classify: boom }) })
    assert.equal(result, false)
  })

  it('swallows a throw from the featured refresh too', () => {
    const boom = () => { throw new Error('listings blew up') }
    let result
    assert.doesNotThrow(() => { result = refreshDerivedState({ featured: boom, classify: () => {} }) })
    assert.equal(result, false)
  })
})

describe('checkDiskSpace', () => {
  const statfsFor = (usedPct) => async () => ({
    blocks: 1000,
    bsize: 4096,
    bfree: Math.round(1000 * (1 - usedPct / 100)),
  })

  it('skips the run when the volume is critically full', async () => {
    const db = createTestDb()
    // Regression: the >90% branch pruned and then returned 'continue', walking every endpoint
    // and writing hundreds of thousands of rows to the volume that just reported itself full.
    assert.equal(await checkDiskSpace({ statfsFn: statfsFor(97.6), database: db }), 'skip')
  })

  it('still skips when the emergency prune itself fails on a full disk', async () => {
    const db = createTestDb()
    db.exec('DROP TABLE health_checks') // force the prune to throw
    assert.equal(await checkDiskSpace({ statfsFn: statfsFor(97.6), database: db }), 'skip')
  })

  it('skips at the warning threshold', async () => {
    const db = createTestDb()
    assert.equal(await checkDiskSpace({ statfsFn: statfsFor(85), database: db }), 'skip')
  })

  it('continues when there is plenty of room', async () => {
    const db = createTestDb()
    assert.equal(await checkDiskSpace({ statfsFn: statfsFor(20), database: db }), 'continue')
  })

  it('skips when the disk-space check itself hits SQLITE_FULL', async () => {
    const db = createTestDb()
    const throwFull = async () => { const e = new Error('database or disk is full'); e.code = 'SQLITE_FULL'; throw e }
    assert.equal(await checkDiskSpace({ statfsFn: throwFull, database: db }), 'skip')
  })

  it('continues when statfs fails for an unrelated reason', async () => {
    const db = createTestDb()
    const throwOther = async () => { throw new Error('ENOSYS not supported') }
    assert.equal(await checkDiskSpace({ statfsFn: throwOther, database: db }), 'continue')
  })
})

describe('process guards', () => {
  it('registers handlers for unhandled rejections and uncaught exceptions', () => {
    const registered = []
    const proc = { on: (event) => registered.push(event) }
    installProcessGuards({ proc, logger: { error: () => {} } })
    assert.deepEqual(registered.sort(), ['uncaughtException', 'unhandledRejection'])
  })

  it('logs an unhandled rejection without rethrowing', () => {
    const logged = []
    const proc = { on: () => {} }
    const { unhandledRejection } = installProcessGuards({ proc, logger: { error: m => logged.push(m) } })

    assert.doesNotThrow(() => unhandledRejection(new Error('database or disk is full')))
    assert.match(logged[0], /Unhandled promise rejection/)
    assert.match(logged[0], /database or disk is full/)
  })

  it('handles a non-Error rejection reason', () => {
    const logged = []
    const { unhandledRejection } = installProcessGuards({
      proc: { on: () => {} },
      logger: { error: m => logged.push(m) },
    })
    assert.doesNotThrow(() => unhandledRejection('plain string reason'))
    assert.match(logged[0], /plain string reason/)
  })
})
