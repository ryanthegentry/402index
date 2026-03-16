#!/usr/bin/env node
// Register Neynar x402 Farcaster API endpoints
// Run on Railway: railway ssh -- node scripts/register-neynar.mjs
//
// Discovery findings (2026-03-16):
// - Provider: Neynar (neynar.com) — Farcaster social data API
// - Base URL: https://api.neynar.com
// - x402: requests without API key get HTTP 402 + pay-per-request
// - $0.01 USDC per request on Base (EIP-3009 gasless transfer)
// - Also: hub-api.neynar.com for hub data (also x402-enabled)
// - Blog: neynar.com/blog/agents-frames-and-the-future-of-farcaster-neynar-s-vision-for-x402
// - Docs: docs.neynar.com/reference/quickstart
// - Categories: Users, Casts, Social Graph, Feeds
// - Listed on x402.org/ecosystem

import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'

const dbPath = process.env.DB_PATH || '/data/402index.db'
const db = new Database(dbPath)

const upsert = db.prepare(`
  INSERT INTO services (id, name, description, url, protocol, price_usd,
    payment_asset, payment_network, category, provider, source, http_method,
    health_status, registered_at, updated_at)
  VALUES (@id, @name, @description, @url, 'x402', @price_usd,
    'USDC', 'Base', @category, 'Neynar', 'discovery', @http_method,
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
    name: 'Neynar: User Lookup',
    description: 'Look up Farcaster user profiles by FID. Returns profile info, bio, follower counts, and connected addresses. Pay per request via x402 — no API key required.',
    url: 'https://api.neynar.com/v2/farcaster/user/bulk',
    http_method: 'GET',
    category: 'social',
  },
  {
    name: 'Neynar: Cast Lookup',
    description: 'Retrieve Farcaster casts (posts) by hash or URL. Returns full cast data including reactions, replies, and embeds.',
    url: 'https://api.neynar.com/v2/farcaster/cast',
    http_method: 'GET',
    category: 'social',
  },
  {
    name: 'Neynar: Feed',
    description: 'Get Farcaster feeds — trending, following, or channel-specific. Returns curated cast collections.',
    url: 'https://api.neynar.com/v2/farcaster/feed',
    http_method: 'GET',
    category: 'social',
  },
  {
    name: 'Neynar: Search Users',
    description: 'Search Farcaster users by name or username. Returns matching profiles with follower data.',
    url: 'https://api.neynar.com/v2/farcaster/user/search',
    http_method: 'GET',
    category: 'social',
  },
  {
    name: 'Neynar: Search Casts',
    description: 'Search Farcaster casts by keyword. Returns matching posts with author info and engagement.',
    url: 'https://api.neynar.com/v2/farcaster/cast/search',
    http_method: 'GET',
    category: 'social',
  },
]

let inserted = 0
let updated = 0

for (const ep of endpoints) {
  const existing = findExisting.get(ep.url)
  upsert.run({
    id: existing ? existing.id : randomUUID(),
    ...ep,
    price_usd: 0.01,
  })
  if (existing) {
    updated++
    console.log(`Updated: ${ep.name}`)
  } else {
    inserted++
    console.log(`Inserted: ${ep.name}`)
  }
}

const total = db.prepare("SELECT COUNT(*) as c FROM services WHERE provider = 'Neynar'").get()
console.log(`\nNeynar registration: ${inserted} inserted, ${updated} updated`)
console.log(`Total Neynar services in DB: ${total.c}`)

db.close()
