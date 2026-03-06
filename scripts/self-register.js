#!/usr/bin/env node
// Register 402index's own L402 endpoints with the directory.
// DO NOT run against production without Ryan's review.
//
// Usage: node scripts/self-register.js [base_url]
// Default: http://localhost:3402 (safe default — NOT prod)
//
// To register against production:
//   node scripts/self-register.js https://402index.io
//
// NOTE: Category "data/api-directory" was specified by Ryan.
// Closest existing category is "tools/directory" (3 entries).
// Ryan to confirm before running against prod.

const BASE = process.argv[2] || 'http://localhost:3402'
const API = `${BASE}/api/v1`

const endpoints = [
  {
    url: `${BASE}/api/v1/export.csv`,
    name: '402index CSV Export',
    description: 'Full CSV export of all indexed L402 and x402 paid API endpoints. Includes health status, pricing, latency, and reliability scores.',
    protocol: 'L402',
    category: 'data/api-directory',
    provider: '402index',
    payment_asset: 'BTC',
    payment_network: 'Lightning',
    contact_email: 'hello@402index.io',
    http_method: 'GET',
  },
  {
    url: `${BASE}/api/v1/services`,
    name: '402index Services API',
    description: 'JSON API for querying indexed L402 and x402 paid API endpoints. Supports filtering by protocol, category, health status, and text search. Free tier with L402 upgrade for higher rate limits.',
    protocol: 'L402',
    category: 'data/api-directory',
    provider: '402index',
    payment_asset: 'BTC',
    payment_network: 'Lightning',
    contact_email: 'hello@402index.io',
    http_method: 'GET',
  },
]

async function register(endpoint) {
  const res = await fetch(`${API}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(endpoint),
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

console.log('=== 402index Self-Registration ===')
console.log(`Target: ${BASE}`)
console.log()

for (const ep of endpoints) {
  console.log(`--- ${ep.name} ---`)
  console.log(`URL: ${ep.url}`)

  try {
    const result = await register(ep)
    console.log(`  Status: ${result.status}`)
    if (result.body) {
      if (result.body.service) {
        console.log(`  ID: ${result.body.service.id}`)
        console.log(`  Health: ${result.body.service.health_status}`)
        console.log(`  Action: ${result.body.action}`)
      } else if (result.body.error) {
        console.log(`  Error: ${result.body.error}`)
      }
    }
  } catch (err) {
    console.log(`  Error: ${err.message}`)
  }
  console.log()
}

console.log('=== Done ===')
