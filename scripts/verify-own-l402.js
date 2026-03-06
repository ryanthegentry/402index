#!/usr/bin/env node
// Verify 402index's own L402 endpoints are compliant.
// Usage: node scripts/verify-own-l402.js [base_url]
// Default: https://402index.io

import { verifyL402 } from '../src/services/l402-verify.js'

const BASE = process.argv[2] || 'https://402index.io'

const endpoints = [
  {
    name: '402index CSV Export',
    url: `${BASE}/api/v1/export.csv`,
    method: 'GET',
  },
  {
    name: '402index Services API (rate-limited)',
    url: `${BASE}/api/v1/services`,
    method: 'GET',
    note: 'L402 only triggers after exceeding free tier rate limit — may return 200 on first probe',
  },
]

console.log(`=== Verifying 402index L402 endpoints ===`)
console.log(`Base URL: ${BASE}`)
console.log()

let allPassed = true

for (const ep of endpoints) {
  console.log(`--- ${ep.name} ---`)
  console.log(`URL: ${ep.url}`)
  if (ep.note) console.log(`Note: ${ep.note}`)

  try {
    const result = await verifyL402(ep.url, ep.method)
    console.log(`  HTTP status: ${result.httpStatus}`)
    console.log(`  Valid L402:  ${result.valid}`)
    console.log(`  WWW-Auth:   ${result.hasWwwAuthenticate}`)
    console.log(`  Scheme:     ${result.scheme || 'n/a'}`)
    console.log(`  Macaroon:   ${result.hasMacaroon}`)
    console.log(`  Invoice:    ${result.hasInvoice}`)
    if (result.error) console.log(`  Error:      ${result.error}`)

    if (!result.valid && !ep.note) {
      allPassed = false
      console.log(`  ❌ FAILED`)
    } else if (result.valid) {
      console.log(`  ✅ PASSED`)
    } else {
      console.log(`  ⚠️  SKIPPED (rate limit not triggered)`)
    }
  } catch (err) {
    allPassed = false
    console.log(`  ❌ ERROR: ${err.message}`)
  }
  console.log()
}

console.log(`=== Result: ${allPassed ? 'All checks passed' : 'Some checks failed'} ===`)
process.exit(allPassed ? 0 : 1)
