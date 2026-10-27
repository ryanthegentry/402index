/**
 * Honest MCP counters (#313 Part C).
 *
 * mcp_queries_total / mcp_active_days were COUNT queries over query_log, which pruneQueryLog
 * deletes at 90 days — rolling-window aggregates mislabeled as lifetime totals. The non-monotonic
 * drops in the 5:30am digest were the oldest day rolling out of the window.
 *
 * Run: node --test test/mcp-counters.test.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import Database from 'better-sqlite3'
import * as dbModule from '../src/db.js'

const db = dbModule.default
const { logQuery, pruneQueryLog } = dbModule

const MCP_UA = '402index-mcp/0.4.1'
const LIFETIME_KEY = 'mcp_queries_lifetime'
const SEEDED_AT_KEY = 'mcp_counter_seeded_at'

describe('MCP user-agent classification', () => {
  it('recognizes the MCP client and nothing else', () => {
    assert.equal(typeof dbModule.isMcpUserAgent, 'function', 'db.js must export isMcpUserAgent')
    assert.equal(dbModule.isMcpUserAgent(MCP_UA), true)
    assert.equal(dbModule.isMcpUserAgent('402index-mcp'), true)
    assert.equal(dbModule.isMcpUserAgent('Mozilla/5.0'), false)
    assert.equal(dbModule.isMcpUserAgent(''), false)
    assert.equal(dbModule.isMcpUserAgent(null), false)
    assert.equal(dbModule.isMcpUserAgent(undefined), false)
  })
})

describe('one predicate classifies MCP traffic everywhere', () => {
  // User-Agent is fully client-controlled. The JS increment used a case-sensitive includes() while
  // the window queries used SQL LIKE, which is case-insensitive for ASCII — so a client sending
  // "402Index-MCP" was counted in the 90d window but never in the lifetime counter, and the digest
  // could report mcp_queries_90d > mcp_queries_lifetime.
  const MIXED_CASE_UA = '402Index-MCP/9.9.9'

  it('classifies a mixed-case user agent as MCP', () => {
    assert.equal(dbModule.isMcpUserAgent(MIXED_CASE_UA), true)
    assert.equal(dbModule.isMcpUserAgent('402INDEX-MCP'), true)
  })

  it('moves the lifetime and 90-day counters together for a mixed-case agent', () => {
    const lifetimeBefore = dbModule.getCounterInt(LIFETIME_KEY)
    const windowBefore = dbModule.mcpQueryWindowStats().queries

    logQuery({ queryText: 'mixed case', userAgent: MIXED_CASE_UA })

    assert.equal(dbModule.getCounterInt(LIFETIME_KEY), lifetimeBefore + 1, 'lifetime counter must see it')
    assert.equal(dbModule.mcpQueryWindowStats().queries, windowBefore + 1, 'window must see the same event')
  })

  it('seeds the lifetime floor from the same predicate that increments it', () => {
    const fixture = new Database(':memory:')
    dbModule.ensureCountersTable(fixture)
    fixture.exec(`
      CREATE TABLE query_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        query_text TEXT, filters TEXT, result_count INTEGER,
        response_time_ms INTEGER, user_agent TEXT, degraded_reason TEXT
      );
    `)
    const insert = fixture.prepare('INSERT INTO query_log (user_agent) VALUES (?)')
    insert.run(MCP_UA)
    insert.run(MIXED_CASE_UA)

    dbModule.seedMcpLifetimeCounter(fixture)
    assert.equal(
      dbModule.getCounterInt(LIFETIME_KEY, fixture), 2,
      'the seed floor must count exactly what later increments will count'
    )
    fixture.close()
  })

  it('the digest does not hand-roll a second MCP predicate', () => {
    const source = readFileSync(new URL('../src/routes/api/digest.js', import.meta.url), 'utf8')
    assert.ok(
      !/user_agent LIKE/.test(source),
      'digest MCP counting must use the shared predicate exported by db.js'
    )
    assert.match(source, /MCP_USER_AGENT_SQL/)
    assert.equal(typeof dbModule.MCP_USER_AGENT_SQL, 'string', 'db.js must export the shared SQL predicate')
  })
})

describe('lifetime counter increments', () => {
  it('increments when an MCP query is logged', () => {
    const before = dbModule.getCounterInt(LIFETIME_KEY)
    logQuery({ queryText: 'weather', userAgent: MCP_UA })
    assert.equal(dbModule.getCounterInt(LIFETIME_KEY), before + 1)
  })

  it('does not increment for browser or plain API agents', () => {
    const before = dbModule.getCounterInt(LIFETIME_KEY)
    logQuery({ queryText: 'weather', userAgent: 'Mozilla/5.0 (Macintosh)' })
    logQuery({ queryText: 'weather', userAgent: null })
    logQuery({ queryText: 'weather', userAgent: 'curl/8.4.0' })
    assert.equal(dbModule.getCounterInt(LIFETIME_KEY), before)
  })

  it('logs the query row and increments the counter together', () => {
    const rowsBefore = db.prepare('SELECT COUNT(*) c FROM query_log').get().c
    const before = dbModule.getCounterInt(LIFETIME_KEY)
    logQuery({ queryText: 'atomic', userAgent: MCP_UA })
    assert.equal(db.prepare('SELECT COUNT(*) c FROM query_log').get().c, rowsBefore + 1)
    assert.equal(dbModule.getCounterInt(LIFETIME_KEY), before + 1)
  })
})

describe('window stats are labeled as a window', () => {
  it('exposes the 90-day MCP window separately from the lifetime counter', () => {
    assert.equal(typeof dbModule.mcpQueryWindowStats, 'function', 'db.js must export mcpQueryWindowStats')
    logQuery({ queryText: 'window', userAgent: MCP_UA })
    const stats = dbModule.mcpQueryWindowStats()
    assert.ok(stats.queries >= 1, 'window query count')
    assert.ok(stats.activeDays >= 1, 'window active-day count')
    assert.equal(dbModule.MCP_QUERY_LOG_RETENTION_DAYS, 90, 'query_log retention stays at 90 days')
  })
})

describe('seeding', () => {
  it('seeds once from the window count and records the seed timestamp', () => {
    const fixture = new Database(':memory:')
    dbModule.ensureCountersTable(fixture)
    fixture.exec(`
      CREATE TABLE query_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        query_text TEXT, filters TEXT, result_count INTEGER,
        response_time_ms INTEGER, user_agent TEXT, degraded_reason TEXT
      );
    `)
    const insert = fixture.prepare('INSERT INTO query_log (user_agent) VALUES (?)')
    insert.run(MCP_UA)
    insert.run(MCP_UA)
    insert.run(MCP_UA)
    insert.run('Mozilla/5.0')

    assert.equal(dbModule.seedMcpLifetimeCounter(fixture), true, 'first call seeds')
    assert.equal(dbModule.getCounterInt(LIFETIME_KEY, fixture), 3, 'seeded from the honest 90-day floor')
    assert.ok(dbModule.getCounter(SEEDED_AT_KEY, fixture), 'seed timestamp recorded')

    // Second call must never re-seed — that would clobber accumulated increments.
    dbModule.incrementCounter(LIFETIME_KEY, 5, fixture)
    assert.equal(dbModule.seedMcpLifetimeCounter(fixture), false, 'second call is a no-op')
    assert.equal(dbModule.getCounterInt(LIFETIME_KEY, fixture), 8)
    fixture.close()
  })

  it('seeded the live DB at boot', () => {
    assert.ok(dbModule.getCounter(SEEDED_AT_KEY), 'boot must expose when the counter was seeded')
  })
})

describe('prune semantics', () => {
  it('changes the window fields but never the lifetime counter', () => {
    // Two MCP queries from an earlier day, inside the 90d window. A 1-day retention sweep stands
    // in for the 90d boundary moving past them — the exact event behind the digest's drops.
    const stale = db.prepare("INSERT INTO query_log (timestamp, user_agent) VALUES (datetime('now', '-2 days'), ?)")
    stale.run(MCP_UA)
    stale.run(MCP_UA)
    logQuery({ queryText: 'recent', userAgent: MCP_UA })

    const lifetime = dbModule.getCounterInt(LIFETIME_KEY)
    const before = dbModule.mcpQueryWindowStats()
    assert.ok(before.queries >= 3, 'the window sees the stale rows')
    assert.ok(before.activeDays >= 2)

    pruneQueryLog(1)

    const after = dbModule.mcpQueryWindowStats()
    assert.equal(after.queries, before.queries - 2, 'the window loses the pruned rows')
    assert.equal(after.activeDays, before.activeDays - 1, 'and loses their active day')
    assert.equal(
      dbModule.getCounterInt(LIFETIME_KEY), lifetime,
      'the lifetime counter is not a query over query_log'
    )
  })
})
