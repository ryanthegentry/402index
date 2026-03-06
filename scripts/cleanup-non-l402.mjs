#!/usr/bin/env node
// Remove confirmed non-L402 entries from the database
// Run on Railway: railway ssh -- node scripts/cleanup-non-l402.mjs
//
// These providers were investigated on 2026-03-06 and confirmed NOT L402-compliant:
//
// LightningProx ecosystem (prepaid spend tokens, not per-request L402 challenges):
//   - aiprox.dev — 401, LightningProx spend tokens
//   - certvera.com — API endpoint 404 (broken)
//   - isitarug.com — LightningProx tokens + broken address parsing
//   - lightningprox.com — 402 without WWW-Authenticate (custom JSON payment)
//   - lpxpoly.com — 404 (not deployed)
//   - satsforai.com — 402 without WWW-Authenticate (LightningProx-powered)
//
// LightningEnable (api.lightningenable.com):
//   - Infrastructure-only (Stripe for Lightning)
//   - All endpoints require API keys (X-API-Key), not public L402 payments
//   - L402 proxy is dynamic per-merchant, no public endpoints

import Database from 'better-sqlite3'

const dbPath = process.env.DB_PATH || '/data/402index.db'
const db = new Database(dbPath)

const domains = [
  'aiprox.dev',
  'certvera.com',
  'isitarug.com',
  'lightningprox.com',
  'lpxpoly.com',
  'satsforai.com',
  'lightningenable.com',
]

console.log('=== Cleanup: Non-L402 Entries ===')
console.log()

let totalRemoved = 0

for (const domain of domains) {
  const entries = db.prepare(
    "SELECT id, url, name, health_status, source FROM services WHERE url LIKE ?"
  ).all(`%${domain}%`)

  if (entries.length === 0) {
    console.log(`${domain}: no entries found`)
    continue
  }

  console.log(`${domain}: ${entries.length} entries`)
  for (const entry of entries) {
    try {
      db.prepare('DELETE FROM health_checks WHERE service_id = ?').run(entry.id)
      db.prepare('DELETE FROM services WHERE id = ?').run(entry.id)
      totalRemoved++
      console.log(`  Removed: ${entry.url} [${entry.source}, ${entry.health_status}]`)
    } catch (err) {
      console.log(`  Error removing ${entry.url}: ${err.message}`)
    }
  }
}

console.log()
console.log(`=== Summary ===`)
console.log(`  Total removed: ${totalRemoved}`)

// Verify none remain
for (const domain of domains) {
  const remaining = db.prepare(
    "SELECT COUNT(*) as c FROM services WHERE url LIKE ?"
  ).get(`%${domain}%`)
  if (remaining.c > 0) {
    console.log(`  WARNING: ${remaining.c} entries still remain for ${domain}`)
  }
}

db.close()
