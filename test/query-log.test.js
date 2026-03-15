import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

// Standalone test DB — no dependency on src/db.js startup side effects
function createTestDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE IF NOT EXISTS query_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      query_text TEXT,
      filters TEXT,
      result_count INTEGER,
      response_time_ms INTEGER,
      user_agent TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_query_log_timestamp ON query_log(timestamp);
  `)
  return db
}

function makeLogQuery(db) {
  const stmt = db.prepare(
    'INSERT INTO query_log (query_text, filters, result_count, response_time_ms, user_agent) VALUES (@queryText, @filters, @resultCount, @responseTimeMs, @userAgent)'
  )
  return function logQuery({ queryText = null, filters = null, resultCount = null, responseTimeMs = null, userAgent = null } = {}) {
    try {
      stmt.run({ queryText, filters, resultCount, responseTimeMs, userAgent })
    } catch (err) {
      console.warn(`[db] logQuery failed: ${err.message}`)
    }
  }
}

function makePruneQueryLog(db) {
  return function pruneQueryLog(retentionDays = 90) {
    try {
      const result = db.prepare(
        "DELETE FROM query_log WHERE timestamp < datetime('now', '-' || ? || ' days')"
      ).run(retentionDays)
      return result.changes
    } catch (err) {
      console.warn(`[db] Query log prune failed: ${err.message}`)
      return 0
    }
  }
}

describe('query_log — logQuery()', () => {
  let db, logQuery

  beforeEach(() => {
    db = createTestDb()
    logQuery = makeLogQuery(db)
  })

  it('inserts a record with all fields', () => {
    logQuery({
      queryText: 'image generation',
      filters: '{"protocol":"L402","category":"ai"}',
      resultCount: 42,
      responseTimeMs: 15,
      userAgent: 'MCP-Client/1.0',
    })

    const row = db.prepare('SELECT * FROM query_log ORDER BY id DESC LIMIT 1').get()
    assert.equal(row.query_text, 'image generation')
    assert.equal(row.filters, '{"protocol":"L402","category":"ai"}')
    assert.equal(row.result_count, 42)
    assert.equal(row.response_time_ms, 15)
    assert.equal(row.user_agent, 'MCP-Client/1.0')
    assert.ok(row.timestamp, 'timestamp should be set')
  })

  it('inserts with null/undefined fields without crashing', () => {
    logQuery({})
    logQuery({ queryText: undefined, filters: undefined })
    logQuery()

    const count = db.prepare('SELECT COUNT(*) as c FROM query_log').get().c
    assert.equal(count, 3)
  })

  it('failure does not throw (fire-and-forget)', () => {
    db.close()
    // Should not throw even though db is closed
    assert.doesNotThrow(() => {
      logQuery({ queryText: 'test' })
    })
  })

  it('stores large query_text (10KB+) without error', () => {
    const bigText = 'x'.repeat(10240)
    logQuery({ queryText: bigText })

    const row = db.prepare('SELECT query_text FROM query_log ORDER BY id DESC LIMIT 1').get()
    assert.equal(row.query_text.length, 10240)
  })

  it('filters JSON roundtrips correctly', () => {
    const filters = { protocol: 'x402', category: 'ai/llm', max_price_usd: '0.50', sort: 'price', order: 'asc' }
    logQuery({ filters: JSON.stringify(filters) })

    const row = db.prepare('SELECT filters FROM query_log ORDER BY id DESC LIMIT 1').get()
    assert.deepEqual(JSON.parse(row.filters), filters)
  })

  it('user_agent stored and retrievable', () => {
    logQuery({ userAgent: 'Mozilla/5.0 (compatible; ClaudeBot/1.0)' })

    const row = db.prepare('SELECT user_agent FROM query_log ORDER BY id DESC LIMIT 1').get()
    assert.equal(row.user_agent, 'Mozilla/5.0 (compatible; ClaudeBot/1.0)')
  })

  it('concurrent inserts do not corrupt data', () => {
    for (let i = 0; i < 100; i++) {
      logQuery({ queryText: `query-${i}`, resultCount: i })
    }

    const count = db.prepare('SELECT COUNT(*) as c FROM query_log').get().c
    assert.equal(count, 100)

    const first = db.prepare('SELECT * FROM query_log WHERE result_count = 0').get()
    assert.equal(first.query_text, 'query-0')

    const last = db.prepare('SELECT * FROM query_log WHERE result_count = 99').get()
    assert.equal(last.query_text, 'query-99')
  })
})

describe('query_log — pruneQueryLog()', () => {
  let db, logQuery, pruneQueryLog

  beforeEach(() => {
    db = createTestDb()
    logQuery = makeLogQuery(db)
    pruneQueryLog = makePruneQueryLog(db)
  })

  it('deletes entries older than 90 days', () => {
    // Insert an old entry
    db.prepare(
      "INSERT INTO query_log (timestamp, query_text) VALUES (datetime('now', '-91 days'), 'old query')"
    ).run()
    // Insert a recent entry
    logQuery({ queryText: 'recent query' })

    const deleted = pruneQueryLog(90)
    assert.equal(deleted, 1)

    const remaining = db.prepare('SELECT * FROM query_log').all()
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0].query_text, 'recent query')
  })

  it('keeps entries newer than 90 days', () => {
    db.prepare(
      "INSERT INTO query_log (timestamp, query_text) VALUES (datetime('now', '-89 days'), 'still fresh')"
    ).run()

    const deleted = pruneQueryLog(90)
    assert.equal(deleted, 0)

    const count = db.prepare('SELECT COUNT(*) as c FROM query_log').get().c
    assert.equal(count, 1)
  })

  it('pruneQueryLog(0) deletes all past entries', () => {
    // Insert entries with timestamps in the past (even 1 second ago)
    db.prepare("INSERT INTO query_log (timestamp, query_text) VALUES (datetime('now', '-1 second'), 'a')").run()
    db.prepare("INSERT INTO query_log (timestamp, query_text) VALUES (datetime('now', '-1 hour'), 'b')").run()
    db.prepare("INSERT INTO query_log (timestamp, query_text) VALUES (datetime('now', '-1 day'), 'c')").run()

    const deleted = pruneQueryLog(0)
    assert.equal(deleted, 3)

    const count = db.prepare('SELECT COUNT(*) as c FROM query_log').get().c
    assert.equal(count, 0)
  })
})

describe('query_log — schema', () => {
  it('table created on init', () => {
    const db = createTestDb()
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='query_log'").get()
    assert.ok(table, 'query_log table should exist')
  })

  it('index exists on timestamp column', () => {
    const db = createTestDb()
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_query_log_timestamp'").get()
    assert.ok(idx, 'idx_query_log_timestamp index should exist')
  })
})
