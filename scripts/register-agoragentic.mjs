#!/usr/bin/env node
// Register Agoragentic x402 agent marketplace endpoints
// Run on Railway: railway ssh -- node scripts/register-agoragentic.mjs
//
// Discovery findings (2026-03-16):
// - Provider: Agoragentic (agoragentic.com) — agent-to-agent marketplace
// - Base URL: https://agoragentic.com/api
// - x402 flow: GET /api/x402/listings → POST /api/x402/invoke/{id} → 402 → pay → result
// - USDC on Base — no registration, no API key for x402 path
// - Minimum invocation: $0.10 USDC, platform fee 3%
// - Also has registration flow with $0.50 USDC starter balance
// - Integrations: MCP (npx agoragentic-mcp), Python (pip install agoragentic)
// - Docs: agoragentic.com/docs.html, /openapi.json, /skill.md
// - GitHub: github.com/rhein1/agoragentic-integrations
// - Listed on x402.org/ecosystem

import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'

const dbPath = process.env.DB_PATH || '/data/402index.db'
const db = new Database(dbPath)

const API = 'https://agoragentic.com/api'

const upsert = db.prepare(`
  INSERT INTO services (id, name, description, url, protocol, price_usd,
    payment_asset, payment_network, category, provider, source, http_method,
    health_status, registered_at, updated_at)
  VALUES (@id, @name, @description, @url, 'x402', @price_usd,
    'USDC', 'Base', @category, 'Agoragentic', 'discovery', @http_method,
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
    name: 'Agoragentic: Capability Catalog',
    description: 'Browse the public catalog of agent capabilities available for invocation. Free to query.',
    url: `${API}/capabilities`,
    price_usd: 0,
    http_method: 'GET',
    category: 'marketplace',
  },
  {
    name: 'Agoragentic: Task Execution',
    description: 'Route and execute tasks across marketplace providers. Auto provider matching, fallback, and refund on failure. Min $0.10 USDC.',
    url: `${API}/execute`,
    price_usd: 0.10,
    http_method: 'POST',
    category: 'marketplace',
  },
  {
    name: 'Agoragentic: x402 Listings',
    description: 'Browse x402-enabled capabilities. No registration needed — pay per invocation with USDC on Base.',
    url: `${API}/x402/listings`,
    price_usd: 0,
    http_method: 'GET',
    category: 'marketplace',
  },
  {
    name: 'Agoragentic: x402 Invoke',
    description: 'Invoke a marketplace capability via x402 payment flow. No API key — HTTP 402 with USDC on Base.',
    url: `${API}/x402/invoke`,
    price_usd: 0.10,
    http_method: 'POST',
    category: 'marketplace',
  },
  {
    name: 'Agoragentic: Provider Match',
    description: 'Preview available providers for a task without executing. Returns capabilities and pricing.',
    url: `${API}/execute/match`,
    price_usd: 0,
    http_method: 'GET',
    category: 'marketplace',
  },
]

let inserted = 0
let updated = 0

const runAll = db.transaction(() => {
  for (const ep of endpoints) {
    const existing = findExisting.get(ep.url)
    upsert.run({
      id: existing ? existing.id : randomUUID(),
      ...ep,
    })
    if (existing) {
      updated++
    } else {
      inserted++
    }
  }
})

runAll()

const total = db.prepare("SELECT COUNT(*) as c FROM services WHERE provider = 'Agoragentic'").get()
console.log(`Agoragentic registration: ${inserted} inserted, ${updated} updated`)
console.log(`Total Agoragentic services in DB: ${total.c}`)

db.close()
