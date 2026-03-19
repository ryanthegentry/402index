#!/usr/bin/env node
/**
 * Backfill historical daily_snapshots from known data points (journal entries, status logs).
 * Idempotent — safe to run multiple times. Uses INSERT OR IGNORE to not overwrite live data.
 */

import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.DB_PATH || join(__dirname, '..', 'data', '402index.db')
mkdirSync(dirname(DB_PATH), { recursive: true })

const db = new Database(DB_PATH)
db.pragma('journal_mode = DELETE')
db.pragma('busy_timeout = 5000')

// Ensure table exists (in case script runs before server boot)
db.exec(`
  CREATE TABLE IF NOT EXISTS daily_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_date TEXT NOT NULL UNIQUE,
    total_endpoints INTEGER,
    verified_endpoints INTEGER,
    total_providers INTEGER,
    verified_providers INTEGER,
    healthy_endpoints INTEGER,
    degraded_endpoints INTEGER,
    down_endpoints INTEGER,
    l402_endpoints INTEGER,
    l402_verified INTEGER,
    l402_healthy INTEGER,
    l402_providers INTEGER,
    x402_endpoints INTEGER,
    x402_verified INTEGER,
    x402_healthy INTEGER,
    x402_providers INTEGER,
    mpp_endpoints INTEGER,
    mpp_verified INTEGER,
    mpp_healthy INTEGER,
    mpp_providers INTEGER,
    avg_reliability_score REAL,
    median_latency_ms INTEGER,
    p90_latency_ms INTEGER,
    categories_json TEXT,
    top_providers_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_daily_snapshots_date ON daily_snapshots(snapshot_date);
`)

// ─── Known Historical Data Points ──────────────────────────────────────────

const HISTORICAL_DATA = [
  {
    date: '2026-02-27',
    total_endpoints: 3098, verified_endpoints: null, total_providers: null,
    l402_endpoints: 94, x402_endpoints: 3004, mpp_endpoints: 0,
    healthy_endpoints: 2548, degraded_endpoints: null, down_endpoints: null,
  },
  {
    date: '2026-02-28',
    total_endpoints: 10588, verified_endpoints: null, total_providers: null,
    l402_endpoints: 94, x402_endpoints: 10494, mpp_endpoints: 0,
    healthy_endpoints: 7033, degraded_endpoints: 434, down_endpoints: 126,
  },
  {
    date: '2026-03-01',
    total_endpoints: 13179, verified_endpoints: null, total_providers: 398,
    l402_endpoints: null, x402_endpoints: null, mpp_endpoints: 0,
    l402_providers: 23, x402_providers: 375,
  },
  {
    date: '2026-03-05',
    total_endpoints: 13695, verified_endpoints: 1441, total_providers: null,
    l402_endpoints: null, x402_endpoints: null, mpp_endpoints: 0,
  },
  {
    date: '2026-03-14',
    total_endpoints: 14441, verified_endpoints: 4837, total_providers: 204,
    l402_endpoints: null, x402_endpoints: null, mpp_endpoints: 0,
  },
  {
    date: '2026-03-16',
    total_endpoints: 14441, verified_endpoints: 4837, total_providers: 204,
    l402_endpoints: null, x402_endpoints: null, mpp_endpoints: 0,
  },
  {
    date: '2026-03-18',
    total_endpoints: 15437, verified_endpoints: 5262, total_providers: 275,
    l402_endpoints: null, x402_endpoints: null, mpp_endpoints: 488,
  },
  {
    date: '2026-03-19',
    total_endpoints: 15440, verified_endpoints: 5502, total_providers: 558, verified_providers: 187,
    l402_endpoints: 477, l402_verified: 214, l402_providers: 52,
    x402_endpoints: 14475, x402_verified: 5085, x402_providers: 473,
    mpp_endpoints: 488, mpp_verified: 203, mpp_providers: 52,
    healthy_endpoints: 12614, degraded_endpoints: 2328, down_endpoints: 490,
  },
]

// ─── Insert Historical Data ────────────────────────────────────────────────

const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO daily_snapshots (
    snapshot_date, total_endpoints, verified_endpoints, total_providers, verified_providers,
    healthy_endpoints, degraded_endpoints, down_endpoints,
    l402_endpoints, l402_verified, l402_healthy, l402_providers,
    x402_endpoints, x402_verified, x402_healthy, x402_providers,
    mpp_endpoints, mpp_verified, mpp_healthy, mpp_providers
  ) VALUES (
    @snapshot_date, @total_endpoints, @verified_endpoints, @total_providers, @verified_providers,
    @healthy_endpoints, @degraded_endpoints, @down_endpoints,
    @l402_endpoints, @l402_verified, @l402_healthy, @l402_providers,
    @x402_endpoints, @x402_verified, @x402_healthy, @x402_providers,
    @mpp_endpoints, @mpp_verified, @mpp_healthy, @mpp_providers
  )
`)

let inserted = 0
let skipped = 0

for (const data of HISTORICAL_DATA) {
  const result = insertStmt.run({
    snapshot_date: data.date,
    total_endpoints: data.total_endpoints ?? null,
    verified_endpoints: data.verified_endpoints ?? null,
    total_providers: data.total_providers ?? null,
    verified_providers: data.verified_providers ?? null,
    healthy_endpoints: data.healthy_endpoints ?? null,
    degraded_endpoints: data.degraded_endpoints ?? null,
    down_endpoints: data.down_endpoints ?? null,
    l402_endpoints: data.l402_endpoints ?? null,
    l402_verified: data.l402_verified ?? null,
    l402_healthy: data.l402_healthy ?? null,
    l402_providers: data.l402_providers ?? null,
    x402_endpoints: data.x402_endpoints ?? null,
    x402_verified: data.x402_verified ?? null,
    x402_healthy: data.x402_healthy ?? null,
    x402_providers: data.x402_providers ?? null,
    mpp_endpoints: data.mpp_endpoints ?? null,
    mpp_verified: data.mpp_verified ?? null,
    mpp_healthy: data.mpp_healthy ?? null,
    mpp_providers: data.mpp_providers ?? null,
  })
  if (result.changes > 0) inserted++
  else skipped++
}

// ─── Interpolate Between Known Points ──────────────────────────────────────

// Only interpolate total_endpoints where we have two known values
const knownTotals = HISTORICAL_DATA
  .filter(d => d.total_endpoints != null)
  .map(d => ({ date: d.date, value: d.total_endpoints }))
  .sort((a, b) => a.date.localeCompare(b.date))

let interpolated = 0

for (let i = 0; i < knownTotals.length - 1; i++) {
  const start = knownTotals[i]
  const end = knownTotals[i + 1]
  const startDate = new Date(start.date)
  const endDate = new Date(end.date)
  const daysBetween = Math.round((endDate - startDate) / 86400000)

  if (daysBetween <= 1) continue

  for (let d = 1; d < daysBetween; d++) {
    const date = new Date(startDate.getTime() + d * 86400000)
    const dateStr = date.toISOString().slice(0, 10)
    const ratio = d / daysBetween
    const interpolatedValue = Math.round(start.value + (end.value - start.value) * ratio)

    const result = insertStmt.run({
      snapshot_date: dateStr,
      total_endpoints: interpolatedValue,
      verified_endpoints: null,
      total_providers: null,
      verified_providers: null,
      healthy_endpoints: null,
      degraded_endpoints: null,
      down_endpoints: null,
      l402_endpoints: null,
      l402_verified: null,
      l402_healthy: null,
      l402_providers: null,
      x402_endpoints: null,
      x402_verified: null,
      x402_healthy: null,
      x402_providers: null,
      mpp_endpoints: null,
      mpp_verified: null,
      mpp_healthy: null,
      mpp_providers: null,
    })
    if (result.changes > 0) interpolated++
    else skipped++
  }
}

// Also interpolate verified_endpoints where we have two known values
const knownVerified = HISTORICAL_DATA
  .filter(d => d.verified_endpoints != null)
  .map(d => ({ date: d.date, value: d.verified_endpoints }))
  .sort((a, b) => a.date.localeCompare(b.date))

for (let i = 0; i < knownVerified.length - 1; i++) {
  const start = knownVerified[i]
  const end = knownVerified[i + 1]
  const startDate = new Date(start.date)
  const endDate = new Date(end.date)
  const daysBetween = Math.round((endDate - startDate) / 86400000)

  if (daysBetween <= 1) continue

  for (let d = 1; d < daysBetween; d++) {
    const date = new Date(startDate.getTime() + d * 86400000)
    const dateStr = date.toISOString().slice(0, 10)
    const ratio = d / daysBetween
    const interpolatedValue = Math.round(start.value + (end.value - start.value) * ratio)

    // Update only if row exists (from total_endpoints interpolation) and verified is NULL
    db.prepare(
      'UPDATE daily_snapshots SET verified_endpoints = ? WHERE snapshot_date = ? AND verified_endpoints IS NULL'
    ).run(interpolatedValue, dateStr)
  }
}

console.log(`Backfill complete: ${inserted} inserted, ${interpolated} interpolated, ${skipped} skipped (already exist)`)

// Summary
const total = db.prepare('SELECT COUNT(*) as c FROM daily_snapshots').get().c
const dateRange = db.prepare('SELECT MIN(snapshot_date) as min, MAX(snapshot_date) as max FROM daily_snapshots').get()
console.log(`Total snapshots: ${total} (${dateRange.min} to ${dateRange.max})`)

db.close()
