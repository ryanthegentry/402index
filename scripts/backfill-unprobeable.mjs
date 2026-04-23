#!/usr/bin/env node

/**
 * One-time backfill: mark all active *.mpp.paywithlocus.com services as
 * probe_status = 'unprobeable' and reset their stale health metrics.
 *
 * Run: node scripts/backfill-unprobeable.mjs [--dry-run]
 *
 * See: https://github.com/ryanthegentry/402index/issues/236
 */

import db from '../src/db.js'

const dryRun = process.argv.includes('--dry-run')

const services = db.prepare(`
  SELECT id, name, url, hostname, health_status, probe_status
  FROM services
  WHERE hostname LIKE '%.mpp.paywithlocus.com'
    AND (status = 'active' OR status IS NULL)
    AND (provider_deleted = 0 OR provider_deleted IS NULL)
`).all()

console.log(`[backfill] Found ${services.length} active *.mpp.paywithlocus.com services`)

if (services.length === 0) {
  console.log('[backfill] Nothing to do')
  process.exit(0)
}

const alreadyUnprobeable = services.filter(s => s.probe_status === 'unprobeable')
const toUpdate = services.filter(s => s.probe_status !== 'unprobeable')

console.log(`[backfill] Already unprobeable: ${alreadyUnprobeable.length}`)
console.log(`[backfill] To update: ${toUpdate.length}`)

if (dryRun) {
  console.log('[backfill] DRY RUN — no changes made')
  for (const s of toUpdate) {
    console.log(`  would mark unprobeable: ${s.id} (${s.name}) health=${s.health_status}`)
  }
  process.exit(0)
}

const update = db.prepare(`
  UPDATE services SET
    probe_status = 'unprobeable',
    health_status = 'unknown',
    consecutive_failures = 0,
    uptime_30d = NULL,
    latency_p50_ms = NULL,
    reliability_score = NULL,
    updated_at = datetime('now')
  WHERE id = ?
`)

const backfill = db.transaction(() => {
  for (const s of toUpdate) {
    update.run(s.id)
    console.log(`  marked unprobeable: ${s.id} (${s.name})`)
  }
})

backfill()
console.log(`[backfill] Done — updated ${toUpdate.length} services`)
