#!/usr/bin/env node
// Register Firecrawl x402 search endpoint
// Run on Railway: railway ssh -- node scripts/register-firecrawl.mjs
//
// Discovery findings (2026-03-16):
// - Provider: Firecrawl (firecrawl.dev) — web scraping API, converts sites to LLM-ready data
// - x402 endpoint: POST https://api.firecrawl.dev/v1/x402/search
// - $0.01 USDC per request on Base
// - No API key required — payment via x402 (HTTP 402 + USDC on Base)
// - Accepts: { query, limit (max 10), scrapeOptions: { formats: ["markdown"] } }
// - Returns search results; with scrapeOptions gets full markdown content
// - Coinbase case study: coinbase.com/developer-platform/discover/case-studies/firecrawl
// - Docs: docs.firecrawl.dev/x402/search
// - Note: Firecrawl also appears in Bazaar via third-party integrations (Heurist, Questflow)
//   but those are wrappers — this is Firecrawl's own native x402 endpoint.

import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'

const dbPath = process.env.DB_PATH || '/data/402index.db'
const db = new Database(dbPath)

const upsert = db.prepare(`
  INSERT INTO services (id, name, description, url, protocol, price_usd,
    payment_asset, payment_network, category, provider, source, http_method,
    health_status, registered_at, updated_at)
  VALUES (@id, @name, @description, @url, 'x402', @price_usd,
    'USDC', 'Base', @category, @provider, 'discovery', @http_method,
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
    name: 'Firecrawl: x402 Web Search',
    description: 'Search the web and optionally scrape results into clean markdown. Returns up to 10 results per request. Supports location-aware search, time filtering, and structured data extraction. No API key needed — pay per request via x402.',
    url: 'https://api.firecrawl.dev/v1/x402/search',
    price_usd: 0.01,
    category: 'data',
    provider: 'Firecrawl',
    http_method: 'POST',
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

const total = db.prepare("SELECT COUNT(*) as c FROM services WHERE provider = 'Firecrawl'").get()
console.log(`\nFirecrawl registration: ${inserted} inserted, ${updated} updated`)
console.log(`Total Firecrawl services in DB: ${total.c}`)

db.close()
