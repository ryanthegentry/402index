#!/usr/bin/env node
// Read-only database diagnostic — prints issues but does NOT modify anything
// Run on Railway: railway ssh -- node scripts/db-diagnostic.mjs

import Database from 'better-sqlite3'

const dbPath = process.env.DB_PATH || '/data/402index.db'
const db = new Database(dbPath, { readonly: true })

console.log('=== 402index Database Diagnostic ===')
console.log(`DB: ${dbPath}`)
console.log()

// 1. Services with zero health checks (registered but never checked)
const noChecks = db.prepare(`
  SELECT s.id, s.url, s.name, s.provider, s.source, s.health_status, s.registered_at
  FROM services s
  LEFT JOIN health_checks h ON h.service_id = s.id
  WHERE h.id IS NULL
  ORDER BY s.registered_at DESC
`).all()
console.log(`=== 1. Services with zero health checks (${noChecks.length}) ===`)
for (const r of noChecks) {
  console.log(`  [${r.health_status}] ${r.url}`)
  console.log(`    name: ${r.name} | provider: ${r.provider} | source: ${r.source} | registered: ${r.registered_at}`)
}
console.log()

// 2. Persistent failures (7+ consecutive)
const persistentDown = db.prepare(`
  SELECT id, url, name, provider, consecutive_failures, health_status, last_checked
  FROM services
  WHERE consecutive_failures >= 7
  ORDER BY consecutive_failures DESC
`).all()
console.log(`=== 2. Persistent failures — 7+ consecutive (${persistentDown.length}) ===`)
for (const r of persistentDown) {
  console.log(`  [${r.consecutive_failures} failures] ${r.url}`)
  console.log(`    name: ${r.name} | provider: ${r.provider} | status: ${r.health_status} | last_checked: ${r.last_checked}`)
}
console.log()

// 3. .well-known zombie URLs
const wellknown = db.prepare(
  "SELECT id, url, name, source FROM services WHERE url LIKE '%/.well-known/%'"
).all()
console.log(`=== 3. .well-known zombie URLs (${wellknown.length}) ===`)
for (const r of wellknown) {
  console.log(`  ${r.url} | name: ${r.name} | source: ${r.source}`)
}
console.log()

// 4. Duplicate URLs (same URL, multiple entries)
const dupes = db.prepare(`
  SELECT url, COUNT(*) as cnt, GROUP_CONCAT(protocol) as protocols, GROUP_CONCAT(id) as ids
  FROM services
  GROUP BY url
  HAVING cnt > 1
`).all()
console.log(`=== 4. Duplicate URLs (${dupes.length}) ===`)
for (const r of dupes) {
  console.log(`  ${r.url} (${r.cnt}x) protocols: ${r.protocols}`)
}
console.log()

// 5. Non-L402 batch providers (confirmed 2026-03-06)
const nonL402Domains = [
  'aiprox.dev', 'certvera.com', 'isitarug.com',
  'lightningprox.com', 'lpxpoly.com', 'satsforai.com'
]
const nonL402 = db.prepare(`
  SELECT id, url, name, health_status, source FROM services
  WHERE ${nonL402Domains.map(() => "url LIKE ?").join(' OR ')}
`).all(nonL402Domains.map(d => `%${d}%`))
console.log(`=== 5. Non-L402 batch providers (${nonL402.length}) ===`)
for (const r of nonL402) {
  console.log(`  [${r.health_status}] ${r.url} | name: ${r.name} | source: ${r.source}`)
}
console.log()

// 6. LightningEnable entries (confirmed infra-only, API-key-gated)
const lnEnable = db.prepare(
  "SELECT id, url, name, health_status, source FROM services WHERE url LIKE '%lightningenable%'"
).all()
console.log(`=== 6. LightningEnable entries — infra-only (${lnEnable.length}) ===`)
for (const r of lnEnable) {
  console.log(`  [${r.health_status}] ${r.url} | name: ${r.name} | source: ${r.source}`)
}
console.log()

// 7. WoT Scoring (wot.klabo.world) entries (L402 disabled)
const wot = db.prepare(
  "SELECT COUNT(*) as c FROM services WHERE url LIKE '%wot.klabo.world%'"
).get()
console.log(`=== 7. WoT Scoring (wot.klabo.world) entries — L402 disabled (${wot.c}) ===`)
console.log(`  Run fix-wot-endpoints.mjs to remove these`)
console.log()

// Overall stats
const total = db.prepare('SELECT COUNT(*) as c FROM services').get()
const l402 = db.prepare("SELECT COUNT(*) as c FROM services WHERE protocol = 'L402'").get()
const healthy = db.prepare("SELECT COUNT(*) as c FROM services WHERE health_status = 'healthy'").get()
const degraded = db.prepare("SELECT COUNT(*) as c FROM services WHERE health_status = 'degraded'").get()
const down = db.prepare("SELECT COUNT(*) as c FROM services WHERE health_status = 'down'").get()
console.log(`=== Overall Stats ===`)
console.log(`  Total services: ${total.c}`)
console.log(`  L402 services: ${l402.c}`)
console.log(`  Healthy: ${healthy.c} | Degraded: ${degraded.c} | Down: ${down.c}`)

db.close()
