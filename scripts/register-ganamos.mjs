#!/usr/bin/env node
// Register Ganamos.earth L402 endpoints
// Run on Railway: railway ssh -- node scripts/register-ganamos.mjs
//
// Discovery findings (2026-03-17):
// - Provider: Ganamos (ganamos.earth) — Bitcoin-powered job/bounty marketplace
// - L402-native platform: agents post tasks, submit fixes, earn sats via Lightning
// - No accounts required — L402 tokens serve as identity
// - OpenAPI 3.0.3 spec at /openapi.json
// - Base URL: https://www.ganamos.earth/api (www subdomain required, naked domain 403s curl)
// - Confirmed 402 responses on POST /api/posts and POST /api/fixes
// - WWW-Authenticate: L402 macaroon="...", invoice="lnbc..." (proper L402 challenge)
// - GET endpoints are free (no L402 required)
// - Only L402 protocol — no x402 headers found

import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'

const dbPath = process.env.DB_PATH || '/data/402index.db'
const db = new Database(dbPath)

const BASE = 'https://www.ganamos.earth/api'

const endpoints = [
  {
    name: 'Ganamos: Create Job',
    description: 'Post a Bitcoin-funded bounty job. Costs reward amount + 10 sat API fee via L402 Lightning payment. Returns post_id and status URL.',
    url: `${BASE}/posts`,
    http_method: 'POST',
    price_sats: 10,
    price_usd: 0.01,
    category: 'tools/marketplace',
  },
  {
    name: 'Ganamos: Submit Fix',
    description: 'Submit a fix/solution to an open bounty. 10 sat anti-spam fee via L402. Include proof_text or proof_image_url.',
    url: `${BASE}/fixes`,
    http_method: 'POST',
    price_sats: 10,
    price_usd: 0.01,
    category: 'tools/marketplace',
  },
]

console.log(`\n=== Ganamos Registration ===`)
console.log(`Endpoints to register: ${endpoints.length}\n`)

const upsertL402 = db.prepare(`
  INSERT INTO services (id, name, description, url, protocol, price_sats, price_usd,
    payment_asset, payment_network, category, provider, source, http_method,
    health_status, registered_at, updated_at)
  VALUES (@id, @name, @description, @url, 'L402', @price_sats, @price_usd,
    'BTC', 'Lightning', @category, 'Ganamos', 'discovery', @http_method,
    'unknown', datetime('now'), datetime('now'))
  ON CONFLICT(url, protocol) DO UPDATE SET
    name = excluded.name,
    description = excluded.description,
    price_sats = excluded.price_sats,
    price_usd = excluded.price_usd,
    category = excluded.category,
    provider = excluded.provider,
    source = excluded.source,
    http_method = excluded.http_method,
    updated_at = datetime('now')
`)

const findExisting = db.prepare("SELECT id FROM services WHERE url = ? AND protocol = 'L402'")

let inserted = 0
let updated = 0

const runAll = db.transaction(() => {
  for (const ep of endpoints) {
    const existing = findExisting.get(ep.url)
    upsertL402.run({
      id: existing ? existing.id : randomUUID(),
      name: ep.name,
      description: ep.description,
      url: ep.url,
      price_sats: ep.price_sats,
      price_usd: ep.price_usd,
      category: ep.category,
      http_method: ep.http_method,
    })
    if (existing) { updated++ } else { inserted++ }
  }
})

runAll()

const total = db.prepare("SELECT COUNT(*) as c FROM services WHERE provider = 'Ganamos'").get()
console.log(`L402: ${inserted} inserted, ${updated} updated (${total.c} total Ganamos services)`)

db.close()
