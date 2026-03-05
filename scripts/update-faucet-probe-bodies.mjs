#!/usr/bin/env node
// Update probe_body for Lightning Faucet L402 endpoints that return 400 without a valid request body.
// These endpoints validate the request body before issuing the L402 challenge (same pattern as Sats4AI).
//
// Run on Railway: railway ssh -- node scripts/update-faucet-probe-bodies.mjs

import Database from 'better-sqlite3'

const dbPath = process.env.DB_PATH || '/data/402index.db'
const db = new Database(dbPath)

// Map of URL suffix → probe_body (verified via curl 2026-03-05)
const probeBodyMap = {
  'invoice_decode': '{"invoice":"lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq8rkx3yf5tcsyz3d73gafnh3cax9rn449d9p5uxz9ezhhypd0elx87sjle52x86fux2ypatgddc6k63n7erqz25le42c4u4ecky03ylcqca784w"}',
  'keywords': '{"text":"Bitcoin Lightning Network L402 protocol test","count":3}',
  'llm_prompt': '{"prompt":"test"}',
  'lnurl_metadata': '{"lnurl":"lnurl1dp68gurn8ghj7em9w3skccne9e3k7mf09emk2mrv944kummhdchkcmn4wfk8qtmsdqhf6mm4d9hxwt"}',
  'memory': '{"agent_id":"402index-probe","mode":"list"}',
  'profanity_filter': '{"text":"hello world test","mode":"check"}',
  'sentiment': '{"text":"Bitcoin is great"}',
  'summarize_title': '{"text":"Bitcoin is a decentralized digital currency","max_words":5}',
}

const findByUrlSuffix = db.prepare(
  "SELECT id, url, name, probe_body FROM services WHERE url LIKE ? AND protocol = 'L402'"
)

const updateProbeBody = db.prepare(
  "UPDATE services SET probe_body = @probe_body, updated_at = datetime('now') WHERE id = @id"
)

console.log('=== Lightning Faucet Probe Body Update ===\n')

let updated = 0
let skipped = 0
let notFound = 0

for (const [suffix, probeBody] of Object.entries(probeBodyMap)) {
  const pattern = `%lightningfaucet.com/api/l402/${suffix}`
  const rows = findByUrlSuffix.all(pattern)

  if (rows.length === 0) {
    console.log(`  [NOT FOUND] ${suffix} — no matching service in DB`)
    notFound++
    continue
  }

  for (const row of rows) {
    if (row.probe_body === probeBody) {
      console.log(`  [SKIP] ${row.name} — probe_body already set`)
      skipped++
      continue
    }

    const before = row.probe_body || '(none)'
    updateProbeBody.run({ id: row.id, probe_body: probeBody })
    console.log(`  [UPDATED] ${row.name}`)
    console.log(`    URL: ${row.url}`)
    console.log(`    Before: ${before}`)
    console.log(`    After:  ${probeBody}`)
    updated++
  }
}

// Clean up stale .well-known entries imported by aggregators
console.log('\n=== Cleaning stale .well-known aggregator entries ===\n')
const wellKnownCleanup = db.prepare(
  "DELETE FROM services WHERE url LIKE '%/.well-known/%' AND source NOT IN ('well-known') AND source NOT LIKE '%well-known%'"
)
const cleanupResult = wellKnownCleanup.run()
if (cleanupResult.changes > 0) {
  console.log(`  Deleted ${cleanupResult.changes} stale .well-known entries from aggregator sources`)
} else {
  console.log('  No stale .well-known entries found')
}

console.log(`\n=== Summary ===`)
console.log(`  Updated: ${updated}`)
console.log(`  Skipped (already set): ${skipped}`)
console.log(`  Not found: ${notFound}`)

// Show L402 health status
const healthStats = db.prepare(
  "SELECT health_status, COUNT(*) as c FROM services WHERE protocol = 'L402' GROUP BY health_status"
).all()
console.log(`\nL402 health status:`)
healthStats.forEach(r => console.log(`  ${r.health_status}: ${r.c}`))

db.close()
