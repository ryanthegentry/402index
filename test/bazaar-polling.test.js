/**
 * TDD tests for Bazaar poller behavior bugs (issue #112).
 *
 * Bug B (error logging): Normalization errors suppressed after 5.
 * Bug C: No 24h forced offset reset safeguard.
 *
 * These tests MUST FAIL against the current code and PASS after the fix.
 *
 * Run: DB_PATH=:memory: node --test test/bazaar-polling.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import db from '../src/db.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setSyncState(key, value) {
  db.prepare(`
    INSERT INTO sync_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, value)
}

function cleanSyncState() {
  db.prepare("DELETE FROM sync_state WHERE key IN ('bazaar_offset', 'bazaar_last_full_pass')").run()
}

function makeBazaarItem(n) {
  const url = `https://bazaar-polling-test-${n}-${Date.now()}.example.com/api`
  return {
    resource: url,
    accepts: [{
      resource: url,
      maxAmountRequired: '10000',
      network: 'base',
      description: `Test service ${n}`,
    }],
  }
}

function makeBadItem(n) {
  // No resource, no accepts — normalizeItem will throw on this both before and after the fix
  return { bad_field: `item-${n}` }
}

// ─── Bug C: No 24h forced offset reset ───────────────────────────────────────

describe('Bug C: 24h forced offset reset', () => {
  let originalFetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    cleanSyncState()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    cleanSyncState()
    db.prepare("DELETE FROM services WHERE url LIKE 'https://bazaar-polling-test-%'").run()
  })

  it('resets bazaar_offset to 0 when last full pass was >24h ago', async () => {
    // Seed: offset at 5000, last full pass 48h ago
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
    setSyncState('bazaar_offset', '5000')
    setSyncState('bazaar_last_full_pass', fortyEightHoursAgo)

    const fetchedUrls = []
    globalThis.fetch = async (url) => {
      fetchedUrls.push(url)
      // Return empty result so poll exits quickly
      return {
        ok: true,
        status: 200,
        json: async () => ({ pagination: { total: 0 }, items: [] }),
      }
    }

    const { pollBazaar } = await import(`../src/aggregators/bazaar.js?t=${Date.now()}`)
    await pollBazaar()

    assert.ok(fetchedUrls.length > 0, 'fetch should have been called')
    const firstUrl = fetchedUrls[0]

    // FAILS currently: no 24h reset logic → first fetch still uses offset=5000
    assert.ok(
      firstUrl.includes('offset=0'),
      `first fetch should use offset=0 after forced reset, got: ${firstUrl}`
    )
  })

  it('does NOT reset offset when last full pass was <24h ago', async () => {
    // Seed: offset at 5000, last full pass 1h ago (recent)
    const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString()
    setSyncState('bazaar_offset', '5000')
    setSyncState('bazaar_last_full_pass', oneHourAgo)

    const fetchedUrls = []
    globalThis.fetch = async (url) => {
      fetchedUrls.push(url)
      return {
        ok: true,
        status: 200,
        json: async () => ({ pagination: { total: 0 }, items: [] }),
      }
    }

    const { pollBazaar } = await import(`../src/aggregators/bazaar.js?t=${Date.now() + 1}`)
    await pollBazaar()

    assert.ok(fetchedUrls.length > 0, 'fetch should have been called')
    const firstUrl = fetchedUrls[0]
    // Recent full pass → should resume from offset=5000
    assert.ok(
      firstUrl.includes('offset=5000'),
      `first fetch should preserve offset=5000 when last pass was recent, got: ${firstUrl}`
    )
  })

  it('resets offset when bazaar_last_full_pass is missing', async () => {
    // No last_full_pass entry at all, but offset is at 5000
    setSyncState('bazaar_offset', '5000')
    // Do NOT set bazaar_last_full_pass

    const fetchedUrls = []
    globalThis.fetch = async (url) => {
      fetchedUrls.push(url)
      return {
        ok: true,
        status: 200,
        json: async () => ({ pagination: { total: 0 }, items: [] }),
      }
    }

    const { pollBazaar } = await import(`../src/aggregators/bazaar.js?t=${Date.now() + 2}`)
    await pollBazaar()

    assert.ok(fetchedUrls.length > 0, 'fetch should have been called')
    const firstUrl = fetchedUrls[0]

    // FAILS currently: no reset logic → uses offset=5000 when last_full_pass is missing
    assert.ok(
      firstUrl.includes('offset=0'),
      `first fetch should use offset=0 when bazaar_last_full_pass is missing, got: ${firstUrl}`
    )
  })
})

// ─── Bug B (error logging): All errors logged, not just first 5 ──────────────

describe('Bug B (error logging): all normalization errors are logged', () => {
  let originalFetch
  let originalConsoleError
  let errorLogs

  beforeEach(() => {
    originalFetch = globalThis.fetch
    originalConsoleError = console.error
    errorLogs = []
    console.error = (...args) => {
      errorLogs.push(args.map(a => String(a)).join(' '))
    }
    cleanSyncState()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    console.error = originalConsoleError
    cleanSyncState()
    db.prepare("DELETE FROM services WHERE url LIKE 'https://bazaar-polling-test-%'").run()
  })

  it('logs all 7 normalization errors (not just first 5)', async () => {
    // Build 10 items: 3 valid, 7 bad (no resource, no accepts → always throws)
    const items = [
      makeBazaarItem('a'),
      makeBazaarItem('b'),
      makeBazaarItem('c'),
      makeBadItem(1),
      makeBadItem(2),
      makeBadItem(3),
      makeBadItem(4),
      makeBadItem(5),
      makeBadItem(6),
      makeBadItem(7),
    ]

    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        pagination: { total: items.length },
        items,
      }),
    })

    const { pollBazaar } = await import(`../src/aggregators/bazaar.js?t=${Date.now() + 10}`)
    const result = await pollBazaar()

    assert.equal(result.errors, 7, 'should report 7 errors in return value')

    // Count per-item normalization error lines (excludes the >50% ALERT summary line)
    const normalizationErrors = errorLogs.filter(msg =>
      msg.includes('[bazaar] Error normalizing item')
    )

    // FAILS currently: errorCount <= 5 gate → only 5 errors logged, not 7
    assert.equal(
      normalizationErrors.length,
      7,
      `expected 7 normalization error log lines, got ${normalizationErrors.length}. Logs: ${JSON.stringify(normalizationErrors)}`
    )
  })

  it('logs a normalization summary line with succeeded/failed counts', async () => {
    const items = [makeBazaarItem('d'), makeBadItem(8), makeBadItem(9)]

    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        pagination: { total: items.length },
        items,
      }),
    })

    // Capture console.log too for summary check
    const originalLog = console.log
    const logLines = []
    console.log = (...args) => {
      logLines.push(args.map(a => String(a)).join(' '))
    }

    try {
      const { pollBazaar } = await import(`../src/aggregators/bazaar.js?t=${Date.now() + 11}`)
      await pollBazaar()
    } finally {
      console.log = originalLog
    }

    const summaryLine = logLines.find(line =>
      line.includes('[bazaar]') && line.toLowerCase().includes('normalization')
    )

    // FAILS currently: no summary line exists
    assert.ok(
      summaryLine,
      `expected a normalization summary log line, got lines: ${JSON.stringify(logLines)}`
    )
  })
})
