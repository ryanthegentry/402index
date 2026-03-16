#!/usr/bin/env node
// Register Ordiscan x402 Bitcoin Ordinals API endpoints
// Run on Railway: railway ssh -- node scripts/register-ordiscan.mjs
//
// Discovery findings (2026-03-16):
// - Provider: Ordiscan (ordiscan.com) — Bitcoin Ordinals explorer & API
// - Base URL: https://api.ordiscan.com/v1
// - x402: HTTP 402 + Payment-Required header (base64-encoded JSON)
// - ~$0.01 USDC per GET request on Base
// - No API key required — pay per request via x402
// - SDK: npm "ordiscan" — github.com/ordiscan/ordiscan-sdk
// - MCP server: github.com/ordiscan/ordiscan-mcp
// - Docs: ordiscan.com/docs/api
// - Data: inscriptions, runes, rare sats, UTXOs, collections
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
    'USDC', 'Base', @category, 'Ordiscan', 'discovery', @http_method,
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
    name: 'Ordiscan: Inscription Info',
    description: 'Get details about a specific Bitcoin Ordinals inscription by ID. Returns content type, owner, genesis transaction, and metadata.',
    url: 'https://api.ordiscan.com/v1/inscription',
    http_method: 'GET',
  },
  {
    name: 'Ordiscan: Address Inscriptions',
    description: 'Get all inscriptions owned by a Bitcoin address. Returns inscription IDs, content types, and metadata. Paginated.',
    url: 'https://api.ordiscan.com/v1/address/inscriptions',
    http_method: 'GET',
  },
  {
    name: 'Ordiscan: Address Runes',
    description: 'Get rune balances for a Bitcoin address. Returns rune names, amounts, and divisibility info.',
    url: 'https://api.ordiscan.com/v1/address/runes',
    http_method: 'GET',
  },
  {
    name: 'Ordiscan: Rune Market Info',
    description: 'Get market data for a specific rune — price, volume, holders, and supply.',
    url: 'https://api.ordiscan.com/v1/rune/market',
    http_method: 'GET',
  },
  {
    name: 'Ordiscan: Address Rare Sats',
    description: 'Get rare satoshis (uncommon, rare, epic, legendary) in UTXOs owned by a Bitcoin address.',
    url: 'https://api.ordiscan.com/v1/address/rare-sats',
    http_method: 'GET',
  },
  {
    name: 'Ordiscan: Inscribe',
    description: 'Create a new Bitcoin Ordinals inscription. Submit content to be inscribed on-chain via x402 payment.',
    url: 'https://api.ordiscan.com/v1/inscribe',
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
    price_usd: 0.01,
    category: 'bitcoin',
  })
  if (existing) {
    updated++
    console.log(`Updated: ${ep.name}`)
  } else {
    inserted++
    console.log(`Inserted: ${ep.name}`)
  }
}

const total = db.prepare("SELECT COUNT(*) as c FROM services WHERE provider = 'Ordiscan'").get()
console.log(`\nOrdiscan registration: ${inserted} inserted, ${updated} updated`)
console.log(`Total Ordiscan services in DB: ${total.c}`)

db.close()
