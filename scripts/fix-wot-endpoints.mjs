#!/usr/bin/env node
// Fix WoT Scoring API (wot.klabo.world) entries in the database
// Run on Railway: railway ssh -- node scripts/fix-wot-endpoints.mjs
//
// Investigation findings (2026-03-06):
// - GET /pricing returns {"l402_enabled": false} — L402 paywall is DISABLED
// - All endpoints return 200 (free tier) or 400 (missing params), never 402
// - 12 consecutive requests to /score all returned 200 — no rate-limited 402 challenge
// - ~51 entries exist in prod DB from Satring/L402Apps aggregation, all "degraded"
// - MaximumSats (maximumsats.com) has a separate L402-gated WoT endpoint — that stays
//
// Action: Remove ALL wot.klabo.world entries. L402 is disabled, these are not L402 services.
// If L402 is re-enabled in the future, they can be re-registered via discovery.

import Database from 'better-sqlite3'

const dbPath = process.env.DB_PATH || '/data/402index.db'
const db = new Database(dbPath)

console.log('=== WoT Scoring API (wot.klabo.world) Cleanup ===')
console.log('Reason: L402 paywall is disabled (l402_enabled: false)')
console.log()

// Find all wot.klabo.world entries
const entries = db.prepare(
  "SELECT id, url, name, health_status, source FROM services WHERE url LIKE '%wot.klabo.world%'"
).all()

console.log(`Found ${entries.length} wot.klabo.world entries to remove`)
console.log()

let removed = 0
for (const entry of entries) {
  try {
    db.prepare('DELETE FROM health_checks WHERE service_id = ?').run(entry.id)
    db.prepare('DELETE FROM services WHERE id = ?').run(entry.id)
    removed++
    console.log(`  Removed: ${entry.name} (${entry.url}) [${entry.source}, ${entry.health_status}]`)
  } catch (err) {
    console.log(`  Error removing ${entry.url}: ${err.message}`)
  }
}

console.log()
console.log(`=== Summary ===`)
console.log(`  Removed: ${removed}/${entries.length} entries`)

// Verify none remain
const remaining = db.prepare(
  "SELECT COUNT(*) as c FROM services WHERE url LIKE '%wot.klabo.world%'"
).get()
console.log(`  Remaining wot.klabo.world entries: ${remaining.c}`)

// Confirm MaximumSats WoT endpoint is untouched
const maxsats = db.prepare(
  "SELECT COUNT(*) as c FROM services WHERE url LIKE '%maximumsats.com/api/wot%'"
).get()
console.log(`  MaximumSats WoT endpoints (untouched): ${maxsats.c}`)

db.close()
