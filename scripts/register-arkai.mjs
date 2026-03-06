#!/usr/bin/env node
// Register The Ark AI L402 endpoint discovered via manual probing
// Run on Railway: railway ssh -- node scripts/register-arkai.mjs
//
// Discovery findings (2026-03-06):
// - Domain: arknode.ai (not thearkai.com — thearkai.com is the marketing site)
// - Single L402 endpoint: POST /l402/task with "task" field selector
// - 110 tasks available (GET /services returns full catalog with pricing)
// - Prices: 10-500 sats per task (varies by complexity)
// - Probe: {"task": "summarize", "input": "test"} → 402 + L402 challenge (10 sats)
// - Also has workflows (POST /workflow) but those return 200 with direct invoice,
//   not L402-gated, so not registered here.
// - No .well-known discovery document available.
//
// This is ONE service registration because all tasks share the same URL.

import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'

const dbPath = process.env.DB_PATH || '/data/402index.db'
const db = new Database(dbPath)

const upsert = db.prepare(`
  INSERT INTO services (id, name, description, url, protocol, price_sats, price_usd,
    payment_asset, payment_network, category, provider, source, http_method, probe_body,
    health_status, registered_at, updated_at)
  VALUES (@id, @name, @description, @url, 'L402', @price_sats, @price_usd,
    'BTC', 'Lightning', @category, @provider, 'discovery', 'POST', @probe_body,
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
    probe_body = excluded.probe_body,
    updated_at = datetime('now')
`)

const url = 'https://arknode.ai/l402/task'
const existing = db.prepare("SELECT id FROM services WHERE url = ? AND protocol = 'L402'").get(url)

const params = {
  id: existing ? existing.id : randomUUID(),
  name: 'The Ark AI: Multi-Tool L402 Gateway',
  description: '110+ developer tools accessible via L402 micropayments. Code review, bug finder, SQL optimizer, unit test generator, Dockerfile generator, CI/CD pipeline, data cleaning, API docs, security scanning, legal drafts, and more. POST with {"task": "tool-name", "input": "..."} — prices vary by task (10-500 sats). Full catalog at GET /services.',
  url,
  price_sats: null, // varies by task (10-500 sats)
  price_usd: null,
  category: 'ai',
  provider: 'The Ark AI',
  probe_body: '{"task":"summarize","input":"test"}', // cheapest task at 10 sats
}

const result = upsert.run(params)

if (existing) {
  console.log(`Updated: ${params.name} (${params.url})`)
} else {
  console.log(`Inserted: ${params.name} (${params.url})`)
}

// Summary
const total = db.prepare("SELECT COUNT(*) as c FROM services WHERE provider = 'The Ark AI'").get()
console.log(`Total The Ark AI services: ${total.c}`)

db.close()
