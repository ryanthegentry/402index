#!/usr/bin/env node
// Register Pinata x402 IPFS endpoints (platform-level, not individual CIDs)
// Run on Railway: railway ssh -- node scripts/register-pinata.mjs
//
// Discovery findings (2026-03-16):
// - Provider: Pinata (pinata.cloud) — IPFS pinning & retrieval
// - x402 gateway: https://402.pinata.cloud
// - Endpoints:
//   POST /v1/pin/{network} — upload/pin files (network: "public" or "private")
//     Body: { fileSize } → returns presigned upload URL
//     Pricing: ~$0.10/GB × 12 months pinning
//   GET /v1/retrieve/private/{cid} — retrieve private files by CID
//     Returns temporary access URL
//     Pricing: $0.0001 per request
// - Payment: USDC on Base (contract 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
// - Also supports Base Sepolia testnet
// - No account or API key needed — pay per request via x402
// - Note: 80+ individual CID entries already in DB from Bazaar (mypinata.cloud subdomains).
//   These are the platform-level API endpoints, not per-CID content paywalls.

import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'

const dbPath = process.env.DB_PATH || '/data/402index.db'
const db = new Database(dbPath)

const upsert = db.prepare(`
  INSERT INTO services (id, name, description, url, protocol, price_usd,
    payment_asset, payment_network, category, provider, source, http_method,
    health_status, registered_at, updated_at)
  VALUES (@id, @name, @description, @url, 'x402', @price_usd,
    'USDC', 'Base', @category, 'Pinata', 'discovery', @http_method,
    'unknown', datetime('now'), datetime('now'))
  ON CONFLICT(url, protocol) DO UPDATE SET
    name = excluded.name,
    description = excluded.description,
    price_usd = excluded.price_usd,
    category = excluded.category,
    provider = excluded.provider,
    source = excluded.source,
    http_method = excluded.http_method,
    updated_at = datetime('now')
`)

const findExisting = db.prepare("SELECT id FROM services WHERE url = ? AND protocol = 'x402'")

const endpoints = [
  {
    name: 'Pinata: Pin to Public IPFS',
    description: 'Upload and pin files to the public IPFS network. Send fileSize in body to get a presigned upload URL. Pricing scales with file size (~$0.10/GB for 12 months pinning). No account needed — pay via x402.',
    url: 'https://402.pinata.cloud/v1/pin/public',
    price_usd: 0.10,
    http_method: 'POST',
    category: 'storage',
  },
  {
    name: 'Pinata: Pin to Private IPFS',
    description: 'Upload and pin files to Pinata private IPFS storage. Send fileSize in body to get a presigned upload URL. Files are encrypted and only accessible via paid retrieval. No account needed.',
    url: 'https://402.pinata.cloud/v1/pin/private',
    price_usd: 0.10,
    http_method: 'POST',
    category: 'storage',
  },
  {
    name: 'Pinata: Retrieve Private File',
    description: 'Retrieve a private file from Pinata by CID. Returns a temporary access URL. $0.0001 per request. No account needed — pay via x402.',
    url: 'https://402.pinata.cloud/v1/retrieve/private',
    price_usd: 0.0001,
    http_method: 'GET',
    category: 'storage',
  },
]

let inserted = 0
let updated = 0

for (const ep of endpoints) {
  const existing = findExisting.get(ep.url)
  upsert.run({
    id: existing ? existing.id : randomUUID(),
    ...ep,
  })
  if (existing) {
    updated++
    console.log(`Updated: ${ep.name} (${ep.url})`)
  } else {
    inserted++
    console.log(`Inserted: ${ep.name} (${ep.url})`)
  }
}

const total = db.prepare("SELECT COUNT(*) as c FROM services WHERE provider = 'Pinata'").get()
console.log(`\nPinata registration: ${inserted} inserted, ${updated} updated`)
console.log(`Total Pinata services in DB: ${total.c}`)

db.close()
