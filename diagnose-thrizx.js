#!/usr/bin/env node
/**
 * Diagnostic script for TheRizx/jsonrecon domain verification issue.
 * Run on Railway: node diagnose-thrizx.js
 *
 * Checks:
 * 1. domain_claims table for jsonrecon.com (or similar)
 * 2. services table for the specific service ID
 * 3. Last Bazaar poll timestamp vs service updated_at
 * 4. Whether any domain-verified claims exist at all
 */

import Database from 'better-sqlite3'

const DB_PATH = process.env.DB_PATH || '/data/402index.db'
const db = new Database(DB_PATH, { readonly: true })

console.log('=== Domain Claims (all) ===')
const claims = db.prepare('SELECT * FROM domain_claims ORDER BY claimed_at DESC').all()
if (claims.length === 0) {
  console.log('  (none)')
} else {
  for (const c of claims) {
    console.log(`  domain=${c.domain} status=${c.status} claimed=${c.claimed_at} verified=${c.verified_at || 'n/a'} token=${c.verification_token?.slice(0, 8)}...`)
  }
}

console.log('\n=== JsonRecon Service ===')
const svc = db.prepare("SELECT id, name, description, url, protocol, category, source, provider, updated_at, health_status FROM services WHERE id = 'ce0e933f-68ac-4ff2-8c39-3c095d83ee0e'").get()
if (svc) {
  for (const [k, v] of Object.entries(svc)) {
    console.log(`  ${k}: ${v}`)
  }
} else {
  console.log('  Service not found by ID, searching by URL...')
  const byUrl = db.prepare("SELECT id, name, category, source, updated_at FROM services WHERE url LIKE '%jsonrecon%'").all()
  for (const s of byUrl) console.log(`  ${JSON.stringify(s)}`)
}

console.log('\n=== All services with jsonrecon in URL ===')
const allJsonrecon = db.prepare("SELECT id, name, url, category, source, updated_at FROM services WHERE url LIKE '%jsonrecon%' ORDER BY updated_at DESC").all()
for (const s of allJsonrecon) {
  console.log(`  id=${s.id.slice(0,8)}... name="${s.name}" cat=${s.category} src=${s.source} updated=${s.updated_at}`)
}

console.log('\n=== Bazaar Sync State ===')
const syncState = db.prepare("SELECT * FROM sync_state WHERE key LIKE '%bazaar%'").all()
for (const s of syncState) {
  console.log(`  ${s.key}: ${s.value} (updated: ${s.updated_at})`)
}

console.log('\n=== Recent Bazaar-sourced updates (last 10) ===')
const recentBazaar = db.prepare("SELECT id, name, category, updated_at FROM services WHERE source = 'bazaar' ORDER BY updated_at DESC LIMIT 10").all()
for (const s of recentBazaar) {
  console.log(`  ${s.updated_at} | cat=${s.category} | ${s.name?.slice(0, 60)}`)
}

db.close()
console.log('\nDone.')
