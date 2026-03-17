#!/usr/bin/env node
// Register Mycelia Signal oracle endpoints (L402 + x402)
// Run on Railway: railway ssh -- node scripts/register-myceliasignal.mjs
//
// Discovery findings (2026-03-17):
// - Provider: Mycelia Signal (myceliasignal.com) — sovereign price oracle
// - Cryptographically signed price attestations (secp256k1 ECDSA for L402, Ed25519 for x402)
// - No API keys, accounts, or SDK required — purely HTTP + payment
// - L402: http://api.myceliasignal.com:8080 (port :8080, HTTP not HTTPS — Cloudflare proxies it)
//   Returns WWW-Authenticate: L402 macaroon="...", invoice="..." (confirmed via curl)
// - x402: https://api.myceliasignal.com (standard port 443, returns payment-required header with x402 JSON)
//   Port :8402 is NOT accessible (Cloudflare blocks non-standard HTTPS ports)
// - All endpoints are GET, no request body needed
// - Pricing: spot/FX 10 sats ($0.01), VWAP 20 sats ($0.02), econ/commodities 1000 sats ($0.10)
// - 56 total endpoints across crypto, FX, commodities, economic indicators
// - Preview data available at /preview suffix (unsigned, free)
// - Discovery endpoint: /sho/info (signing pubkey, payment address, per-endpoint pricing)

import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'

const dbPath = process.env.DB_PATH || '/data/402index.db'
const db = new Database(dbPath)

// --- L402 endpoints (BTC/Lightning) ---
// Port 8080, HTTP (not HTTPS) — confirmed returning valid WWW-Authenticate: L402 header
const L402_BASE = 'http://api.myceliasignal.com:8080'

// --- x402 endpoints (USDC on Base) ---
// Standard HTTPS port 443 — returns payment-required header with x402 JSON body
const X402_BASE = 'https://api.myceliasignal.com'

// Crypto spot pairs (12) — 10 sats / $0.01
const cryptoSpot = [
  { pair: 'btc/usd', name: 'BTC/USD Spot', sources: 9 },
  { pair: 'btc/eur', name: 'BTC/EUR Spot', sources: 9 },
  { pair: 'btc/jpy', name: 'BTC/JPY Spot', sources: 9 },
  { pair: 'eth/usd', name: 'ETH/USD Spot', sources: 9 },
  { pair: 'eth/eur', name: 'ETH/EUR Spot', sources: 9 },
  { pair: 'eth/jpy', name: 'ETH/JPY Spot', sources: 9 },
  { pair: 'sol/usd', name: 'SOL/USD Spot', sources: 9 },
  { pair: 'sol/eur', name: 'SOL/EUR Spot', sources: 9 },
  { pair: 'sol/jpy', name: 'SOL/JPY Spot', sources: 9 },
  { pair: 'xrp/usd', name: 'XRP/USD Spot', sources: 6 },
  { pair: 'ada/usd', name: 'ADA/USD Spot', sources: 6 },
  { pair: 'doge/usd', name: 'DOGE/USD Spot', sources: 6 },
]

// Crypto VWAP pairs (4) — 20 sats / $0.02
const cryptoVwap = [
  { pair: 'btc/usd/vwap', name: 'BTC/USD VWAP' },
  { pair: 'btc/eur/vwap', name: 'BTC/EUR VWAP' },
  { pair: 'btc/jpy/vwap', name: 'BTC/JPY VWAP' },
  { pair: 'eth/usd/vwap', name: 'ETH/USD VWAP' },
]

// FX pairs (20) — 10 sats / $0.01
const fxPairs = [
  'eur/usd', 'eur/jpy', 'eur/gbp', 'eur/chf', 'eur/cny', 'eur/cad',
  'gbp/usd', 'gbp/jpy', 'gbp/chf', 'gbp/cny', 'gbp/cad',
  'usd/jpy', 'usd/chf', 'usd/cny', 'usd/cad',
  'chf/jpy', 'chf/cad',
  'cny/jpy', 'cny/cad',
  'cad/jpy',
]

// Gold pairs (3) — 10 sats / $0.01 (commodity but priced like spot)
const goldPairs = [
  { pair: 'xau/usd', name: 'Gold/USD', sources: 8 },
  { pair: 'xau/eur', name: 'Gold/EUR', sources: 8 },
  { pair: 'xau/jpy', name: 'Gold/JPY', sources: 8 },
]

// Commodity endpoints (5) — 1000 sats / $0.10
const commodities = [
  { path: 'oracle/econ/commodities/wti', name: 'WTI Crude Oil' },
  { path: 'oracle/econ/commodities/brent', name: 'Brent Crude Oil' },
  { path: 'oracle/econ/commodities/natgas', name: 'Natural Gas' },
  { path: 'oracle/econ/commodities/copper', name: 'Copper' },
  { path: 'oracle/econ/commodities/dxy', name: 'US Dollar Index (DXY)' },
]

// US economic indicators (8) — 1000 sats / $0.10
const usEcon = [
  { path: 'oracle/econ/us/cpi', name: 'US CPI' },
  { path: 'oracle/econ/us/cpi_core', name: 'US Core CPI' },
  { path: 'oracle/econ/us/unrate', name: 'US Unemployment Rate' },
  { path: 'oracle/econ/us/fedfunds', name: 'Fed Funds Rate' },
  { path: 'oracle/econ/us/nfp', name: 'US Nonfarm Payrolls' },
  { path: 'oracle/econ/us/gdp', name: 'US GDP' },
  { path: 'oracle/econ/us/pce', name: 'US PCE' },
  { path: 'oracle/econ/us/yield_curve', name: 'US Yield Curve' },
]

// EU economic indicators (6) — 1000 sats / $0.10
const euEcon = [
  { path: 'oracle/econ/eu/hicp', name: 'EU HICP' },
  { path: 'oracle/econ/eu/hicp_core', name: 'EU Core HICP' },
  { path: 'oracle/econ/eu/hicp_services', name: 'EU HICP Services' },
  { path: 'oracle/econ/eu/unrate', name: 'EU Unemployment Rate' },
  { path: 'oracle/econ/eu/gdp', name: 'EU GDP' },
  { path: 'oracle/econ/eu/employment', name: 'EU Employment' },
]

// Build the full endpoint list
const endpoints = []

// Crypto spot (10 sats / $0.01)
for (const c of cryptoSpot) {
  endpoints.push({
    path: `oracle/price/${c.pair}`,
    name: `Mycelia Signal: ${c.name}`,
    description: `Cryptographically signed ${c.name} price attestation from ${c.sources} exchanges. Verifiable secp256k1 ECDSA (L402) or Ed25519 (x402) signature.`,
    price_sats: 10,
    price_usd: 0.01,
    category: 'data/oracle',
    subcategory: 'crypto',
  })
}

// Crypto VWAP (20 sats / $0.02)
for (const c of cryptoVwap) {
  endpoints.push({
    path: `oracle/price/${c.pair}`,
    name: `Mycelia Signal: ${c.name}`,
    description: `Volume-weighted average price for ${c.name.replace(' VWAP', '')}. Cryptographically signed attestation.`,
    price_sats: 20,
    price_usd: 0.02,
    category: 'data/oracle',
    subcategory: 'crypto',
  })
}

// FX pairs (10 sats / $0.01)
for (const pair of fxPairs) {
  const label = pair.toUpperCase().replace('/', '/')
  endpoints.push({
    path: `oracle/price/${pair}`,
    name: `Mycelia Signal: ${label} Spot`,
    description: `Cryptographically signed ${label} foreign exchange rate from central banks and exchanges.`,
    price_sats: 10,
    price_usd: 0.01,
    category: 'data/oracle',
    subcategory: 'fx',
  })
}

// Gold (10 sats / $0.01)
for (const g of goldPairs) {
  endpoints.push({
    path: `oracle/price/${g.pair}`,
    name: `Mycelia Signal: ${g.name}`,
    description: `Cryptographically signed ${g.name} price from ${g.sources} sources. Precious metals oracle.`,
    price_sats: 10,
    price_usd: 0.01,
    category: 'data/oracle',
    subcategory: 'commodities',
  })
}

// Commodities (1000 sats / $0.10)
for (const c of commodities) {
  endpoints.push({
    path: c.path,
    name: `Mycelia Signal: ${c.name}`,
    description: `Cryptographically signed ${c.name} price attestation. Sovereign oracle, no API keys required.`,
    price_sats: 1000,
    price_usd: 0.10,
    category: 'data/oracle',
    subcategory: 'commodities',
  })
}

// US economic indicators (1000 sats / $0.10)
for (const e of usEcon) {
  endpoints.push({
    path: e.path,
    name: `Mycelia Signal: ${e.name}`,
    description: `Cryptographically signed ${e.name} economic indicator. Official source data with verifiable attestation.`,
    price_sats: 1000,
    price_usd: 0.10,
    category: 'data/oracle',
    subcategory: 'economics',
  })
}

// EU economic indicators (1000 sats / $0.10)
for (const e of euEcon) {
  endpoints.push({
    path: e.path,
    name: `Mycelia Signal: ${e.name}`,
    description: `Cryptographically signed ${e.name} economic indicator. Eurostat source data with verifiable attestation.`,
    price_sats: 1000,
    price_usd: 0.10,
    category: 'data/oracle',
    subcategory: 'economics',
  })
}

console.log(`\n=== Mycelia Signal Registration ===`)
console.log(`Total endpoints to register: ${endpoints.length}`)
console.log(`  Registering as both L402 and x402 (${endpoints.length * 2} total rows)\n`)

// Step 0: Clean up old Satring-sourced entries with wrong URLs
// Satring imported these on port 443 (https) which returns x402 headers, not L402.
// Old format: /oracle/btcusd (301 redirect) and /oracle/price/btc/usd on https (x402 only)
console.log('=== Cleaning up old Satring-sourced Mycelia Signal entries ===')
const oldEntries = db.prepare(
  "SELECT id, url, protocol FROM services WHERE provider = 'Mycelia Signal' AND source = 'satring'"
).all()
let cleaned = 0
for (const entry of oldEntries) {
  // Remove health checks for the old entry
  db.prepare('DELETE FROM health_checks WHERE service_id = ?').run(entry.id)
  // Remove the service
  db.prepare('DELETE FROM services WHERE id = ?').run(entry.id)
  cleaned++
  console.log(`  Removed: ${entry.protocol} ${entry.url}`)
}
console.log(`  Cleaned ${cleaned} old Satring entries\n`)

// Upsert for L402
const upsertL402 = db.prepare(`
  INSERT INTO services (id, name, description, url, protocol, price_sats, price_usd,
    payment_asset, payment_network, category, provider, source, http_method, probe_body,
    health_status, registered_at, updated_at)
  VALUES (@id, @name, @description, @url, 'L402', @price_sats, @price_usd,
    'BTC', 'Lightning', @category, 'Mycelia Signal', 'discovery', 'GET', NULL,
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

// Upsert for x402
const upsertX402 = db.prepare(`
  INSERT INTO services (id, name, description, url, protocol, price_sats, price_usd,
    payment_asset, payment_network, category, provider, source, http_method, probe_body,
    health_status, registered_at, updated_at)
  VALUES (@id, @name, @description, @url, 'x402', NULL, @price_usd,
    'USDC', 'Base', @category, 'Mycelia Signal', 'discovery', 'GET', NULL,
    'unknown', datetime('now'), datetime('now'))
  ON CONFLICT(url, protocol) DO UPDATE SET
    name = excluded.name,
    description = excluded.description,
    price_usd = excluded.price_usd,
    category = excluded.category,
    provider = excluded.provider,
    source = excluded.source,
    http_method = excluded.http_method,
    probe_body = excluded.probe_body,
    updated_at = datetime('now')
`)

const findL402 = db.prepare("SELECT id FROM services WHERE url = ? AND protocol = 'L402'")
const findX402 = db.prepare("SELECT id FROM services WHERE url = ? AND protocol = 'x402'")

let l402Inserted = 0, l402Updated = 0
let x402Inserted = 0, x402Updated = 0

const runAll = db.transaction(() => {
  for (const ep of endpoints) {
    const l402Url = `${L402_BASE}/${ep.path}`
    const x402Url = `${X402_BASE}/${ep.path}`

    // L402 registration (port 8080, HTTP)
    const existingL402 = findL402.get(l402Url)
    upsertL402.run({
      id: existingL402 ? existingL402.id : randomUUID(),
      name: ep.name,
      description: ep.description,
      url: l402Url,
      price_sats: ep.price_sats,
      price_usd: ep.price_usd,
      category: ep.category,
    })
    if (existingL402) { l402Updated++ } else { l402Inserted++ }

    // x402 registration (port 443, HTTPS)
    const existingX402 = findX402.get(x402Url)
    upsertX402.run({
      id: existingX402 ? existingX402.id : randomUUID(),
      name: ep.name,
      description: ep.description,
      url: x402Url,
      price_usd: ep.price_usd,
      category: ep.category,
    })
    if (existingX402) { x402Updated++ } else { x402Inserted++ }
  }
})

runAll()

// Summary
const totalL402 = db.prepare("SELECT COUNT(*) as c FROM services WHERE provider = 'Mycelia Signal' AND protocol = 'L402'").get()
const totalX402 = db.prepare("SELECT COUNT(*) as c FROM services WHERE provider = 'Mycelia Signal' AND protocol = 'x402'").get()

console.log(`L402: ${l402Inserted} inserted, ${l402Updated} updated (${totalL402.c} total)`)
console.log(`x402: ${x402Inserted} inserted, ${x402Updated} updated (${totalX402.c} total)`)
console.log(`\nGrand total Mycelia Signal services: ${totalL402.c + totalX402.c}`)

db.close()
