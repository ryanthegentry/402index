#!/usr/bin/env node
// Register proxy402.fun L402 endpoints
// Run on Railway: railway ssh -- node scripts/register-proxy402.mjs
//
// Discovery findings (2026-03-17):
// - Provider: proxy402 by Fewsats — Lightning-native AI inference proxy
// - IMPORTANT: Despite the name, this is L402 (Lightning), NOT x402 (USDC/Base)
// - OpenAI-compatible API at api.proxy402.fun
// - 348 models available via OpenRouter (GPT, Claude, Mistral, Grok, etc.)
// - No account/email required — agents create keys programmatically
// - Keys funded via Lightning invoices
// - Confirmed 402 response on /v1/chat/completions without auth
// - WWW-Authenticate: L402 invoice="lnbc..." header present
// - /v1/models is free (no auth needed, returns full model list)
// - /v1/keys/create is free (creates a new API key)
// - Only /v1/chat/completions is the paid inference endpoint
// - No /v1/embeddings, /v1/images, /v1/audio (all 404)

import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'

const dbPath = process.env.DB_PATH || '/data/402index.db'
const db = new Database(dbPath)

const BASE = 'https://api.proxy402.fun'

const endpoints = [
  {
    name: 'proxy402: Chat Completions (348 models)',
    description: 'OpenAI-compatible chat completions API proxying 348+ models via OpenRouter. Pay-per-request with Lightning. Supports GPT, Claude, Mistral, Grok, Gemini, and more. No account required.',
    url: `${BASE}/v1/chat/completions`,
    http_method: 'POST',
    price_sats: 2,
    price_usd: 0.002,
    category: 'ai/ml',
  },
]

console.log(`\n=== proxy402.fun Registration ===`)
console.log(`Endpoints to register: ${endpoints.length}\n`)

const upsertL402 = db.prepare(`
  INSERT INTO services (id, name, description, url, protocol, price_sats, price_usd,
    payment_asset, payment_network, category, provider, source, http_method,
    health_status, registered_at, updated_at)
  VALUES (@id, @name, @description, @url, 'L402', @price_sats, @price_usd,
    'BTC', 'Lightning', @category, 'proxy402', 'discovery', @http_method,
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

const total = db.prepare("SELECT COUNT(*) as c FROM services WHERE provider = 'proxy402'").get()
console.log(`L402: ${inserted} inserted, ${updated} updated (${total.c} total proxy402 services)`)

db.close()
