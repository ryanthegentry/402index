#!/usr/bin/env node
// Register Lightning Enable L402 endpoints
// Run on Railway: railway ssh -- node scripts/register-lightningenable.mjs
//
// Discovery findings (2026-03-17):
// - Provider: Lightning Enable (lightningenable.com) — L402 infrastructure platform
// - Demoing at Lightning Labs Community Call 2026-03-18
// - Two confirmed L402 endpoints (proper WWW-Authenticate: L402 headers):
//   1. GET api.lightningenable.com/l402/test/ping — 1 sat, public test endpoint
//   2. POST store.lightningenable.com/api/store/checkout — dynamic price, merch store
// - Store also has free catalog: GET /api/store/catalog (200 OK, no L402)
// - Store claim endpoint (POST /api/store/claim) requires L402 auth from checkout flow
// - API registry/discovery endpoints all 401 (API key required, not L402) — skip
// - .well-known/l402-manifest.json: 401 on API (key-gated), 404 on store
// - L402 proxy routes: /l402/proxy/ returns 404
// - llms.txt present on store (standard adoption signal)

import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'

const dbPath = process.env.DB_PATH || '/data/402index.db'
const db = new Database(dbPath)

const endpoints = [
  {
    name: 'Lightning Enable: L402 Test Ping',
    description: 'Public L402 test endpoint. Pay 1 sat to verify your L402 integration works. Returns pong on successful payment. No API key required.',
    url: 'https://api.lightningenable.com/l402/test/ping',
    http_method: 'GET',
    price_sats: 1,
    price_usd: 0.00,
    category: 'tools/testing',
  },
  {
    name: 'Lightning Enable Store: Checkout',
    description: 'L402-powered merch store checkout. POST cart items to receive Lightning invoice. Pay invoice, then claim order with L402 credential. Ships physical goods (t-shirts, hats) via Printful.',
    url: 'https://store.lightningenable.com/api/store/checkout',
    http_method: 'POST',
    price_sats: null,
    price_usd: null,
    category: 'commerce/retail',
  },
  {
    name: 'Lightning Enable Store: Claim Order',
    description: 'Claim a paid store order using L402 credential (macaroon:preimage). Returns a claimUrl for the buyer to enter shipping details. Requires prior checkout + Lightning payment.',
    url: 'https://store.lightningenable.com/api/store/claim',
    http_method: 'POST',
    price_sats: null,
    price_usd: null,
    category: 'commerce/retail',
  },
]

console.log(`\n=== Lightning Enable Registration ===`)
console.log(`Endpoints to register: ${endpoints.length}\n`)

const upsertL402 = db.prepare(`
  INSERT INTO services (id, name, description, url, protocol, price_sats, price_usd,
    payment_asset, payment_network, category, provider, source, http_method,
    health_status, registered_at, updated_at)
  VALUES (@id, @name, @description, @url, 'L402', @price_sats, @price_usd,
    'BTC', 'Lightning', @category, 'Lightning Enable', 'discovery', @http_method,
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

const total = db.prepare("SELECT COUNT(*) as c FROM services WHERE provider = 'Lightning Enable'").get()
console.log(`L402: ${inserted} inserted, ${updated} updated (${total.c} total Lightning Enable services)`)

db.close()
