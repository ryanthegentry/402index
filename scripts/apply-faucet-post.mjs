#!/usr/bin/env node
// One-time script: Set http_method=POST for Lightning Faucet L402 endpoints
// These are POST-only APIs (confirmed by L402 discovery scan 2026-03-05)

import Database from 'better-sqlite3'

const dbPath = process.env.DB_PATH || '/data/402index.db'
const db = new Database(dbPath)

const ids = [
  '56a82c3e-6923-49a8-8679-a2f1c0b7050d',
  'd23e850c-a661-4134-9e06-928ce81e0a00',
  '367cdc78-7f10-45dd-a465-3e1f9a277e3f',
  '146410a2-87eb-4409-b3af-8669c4259a14',
  '9e16873c-0843-4901-912d-14c124b516ef',
  '337e38fc-7b3a-4c77-a91e-154f77a6f4da',
  'fa7369a7-42ac-4e0b-a898-38132c89d2dc',
  'fb5db14c-179e-47c1-94cd-b1915b18320c',
  'c6903d9b-5064-41c6-ae5d-169ef9267ce1',
  'c7dba6b7-273d-4dc7-b9a8-4620e97a31da',
  '66cba30f-8113-43a4-b9fc-266f79ad3628',
  'bb542ead-aa09-484c-a1ef-bad5bc161bb1',
  '8ed31217-3659-475d-ade7-c9b61c6f04ee',
  '5a20c7b1-8dc0-4759-bf83-866a8f7e5b54',
  '2652ed8b-06b8-4d0a-aec2-2f5d39bc9e07',
  'c35d317f-889c-48fb-a39e-daeec1c3bd5f',
  'd2d9a3a1-6a6e-4a22-888b-4168b859c264',
  'a2c35d58-1bde-4c6c-aaf5-ae37c7d5d08f',
  'e9ee9c6a-1ad9-4135-9a5f-2d85ddf56ab5',
  'cf3abf5d-347e-4a2c-ad91-1d318179e734',
  '35680e68-d656-4e58-b6fd-0cf2120229e0',
  '9179ceb4-9eda-4828-8378-fefd2e644424',
  'aedb2052-159b-4721-9f0a-7327ed587709',
  '335f850b-e27f-402a-8067-d99a6c1e158d',
]

console.log('Before:')
const before = db.prepare("SELECT http_method, COUNT(*) as c FROM services WHERE url LIKE '%lightningfaucet.com/api/l402/%' GROUP BY http_method").all()
before.forEach(r => console.log('  method=' + (r.http_method || 'NULL') + ': ' + r.c))

const stmt = db.prepare("UPDATE services SET http_method = 'POST', updated_at = datetime('now') WHERE id = ?")
let updated = 0
for (const id of ids) {
  const r = stmt.run(id)
  if (r.changes > 0) updated++
}
console.log(`\nUpdated ${updated} of ${ids.length} endpoints to http_method=POST`)

console.log('\nAfter:')
const after = db.prepare("SELECT http_method, COUNT(*) as c FROM services WHERE url LIKE '%lightningfaucet.com/api/l402/%' GROUP BY http_method").all()
after.forEach(r => console.log('  method=' + (r.http_method || 'NULL') + ': ' + r.c))

const healthy = db.prepare("SELECT COUNT(*) as c FROM services WHERE protocol='L402' AND health_status='healthy'").get()
const degraded = db.prepare("SELECT COUNT(*) as c FROM services WHERE protocol='L402' AND health_status='degraded'").get()
console.log(`\nL402 healthy: ${healthy.c}, degraded: ${degraded.c}`)

db.close()
