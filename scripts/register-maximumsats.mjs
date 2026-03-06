#!/usr/bin/env node
// Register MaximumSats L402 endpoints discovered via /api/catalog
// Run on Railway: railway ssh -- node scripts/register-maximumsats.mjs
//
// Discovery findings (2026-03-06):
// - Provider: MaximumSats (maximumsats.com), by Joel Klabo (@joelklabo)
// - Catalog: GET /api/catalog returns 50 paid endpoints
// - All POST, all L402 (DVM also supports x402)
// - Body validation happens BEFORE L402 challenge
// - Lightning node was down during probing ("failed to create invoice")
//   but L402 flow is confirmed: validate body → create invoice → 402 challenge
// - Prices: 4-100 sats per call
// - No .well-known discovery document
// - Existing DB entries: wot.klabo.world (Satring, different domain),
//   maximumsats.com/ root (L402Apps) — neither conflicts with these API endpoints

import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'

const dbPath = process.env.DB_PATH || '/data/402index.db'
const db = new Database(dbPath)

const HEX64 = 'a'.repeat(64)

const endpoints = [
  // --- AI & ML (4) ---
  { path: '/api/dvm', name: 'AI DVM', price_sats: 21, category: 'ai/ml',
    description: 'General-purpose AI assistant via DVM (Data Vending Machine). Free tier: 1 query/24h, then L402. Also supports x402 (USDC).',
    probe_body: '{"prompt":"test"}' },
  { path: '/api/imagegen', name: 'AI Image Generation', price_sats: 100, category: 'ai/ml',
    description: 'AI-powered image generation from text prompts.',
    probe_body: '{"prompt":"test"}' },
  { path: '/api/nostr-summary', name: 'Nostr Profile Summary', price_sats: 50, category: 'ai/ml',
    description: 'AI-generated summary of a Nostr user profile and activity.',
    probe_body: `{"pubkey":"${HEX64}"}` },
  { path: '/api/ln-analysis', name: 'Lightning Network Analysis', price_sats: 75, category: 'ai/ml',
    description: 'AI-powered analysis of Lightning Network nodes and channels.',
    probe_body: '{"query":"test"}' },

  // --- BOLT11 (17) ---
  { path: '/api/bolt11-decode', name: 'BOLT11 Invoice Decoder', price_sats: 10, category: 'bitcoin/bolt11',
    description: 'Decode a BOLT11 Lightning invoice into its component fields.',
    probe_body: '{"invoice":"lnbc1test"}' },
  { path: '/api/bolt11-inspect', name: 'BOLT11 Invoice Inspector', price_sats: 6, category: 'bitcoin/bolt11',
    description: 'Deep inspection of BOLT11 invoice structure and metadata.',
    probe_body: '{"invoice":"lnbc1test"}' },
  { path: '/api/bolt11-expiry', name: 'BOLT11 Expiry Checker', price_sats: 5, category: 'bitcoin/bolt11',
    description: 'Check expiry time and status of a BOLT11 invoice.',
    probe_body: '{"invoice":"lnbc1test"}' },
  { path: '/api/bolt11-amount', name: 'BOLT11 Amount Extractor', price_sats: 5, category: 'bitcoin/bolt11',
    description: 'Extract payment amount from a BOLT11 invoice.',
    probe_body: '{"invoice":"lnbc1test"}' },
  { path: '/api/bolt11-description', name: 'BOLT11 Description Inspector', price_sats: 5, category: 'bitcoin/bolt11',
    description: 'Extract description or description hash from a BOLT11 invoice.',
    probe_body: '{"invoice":"lnbc1test"}' },
  { path: '/api/bolt11-network', name: 'BOLT11 Network Classifier', price_sats: 5, category: 'bitcoin/bolt11',
    description: 'Identify the Bitcoin network (mainnet/testnet/regtest) of a BOLT11 invoice.',
    probe_body: '{"invoice":"lnbc1test"}' },
  { path: '/api/bolt11-payee', name: 'BOLT11 Payee Inspector', price_sats: 5, category: 'bitcoin/bolt11',
    description: 'Extract payee public key from a BOLT11 invoice.',
    probe_body: '{"invoice":"lnbc1test"}' },
  { path: '/api/bolt11-payment-secret', name: 'BOLT11 Payment Secret Inspector', price_sats: 5, category: 'bitcoin/bolt11',
    description: 'Extract payment secret from a BOLT11 invoice.',
    probe_body: '{"invoice":"lnbc1test"}' },
  { path: '/api/bolt11-created-at', name: 'BOLT11 Created-At Inspector', price_sats: 5, category: 'bitcoin/bolt11',
    description: 'Extract creation timestamp from a BOLT11 invoice.',
    probe_body: '{"invoice":"lnbc1test"}' },
  { path: '/api/bolt11-min-final-cltv', name: 'BOLT11 Min-Final-CLTV Inspector', price_sats: 5, category: 'bitcoin/bolt11',
    description: 'Extract minimum final CLTV expiry delta from a BOLT11 invoice.',
    probe_body: '{"invoice":"lnbc1test"}' },
  { path: '/api/bolt11-route-hints', name: 'BOLT11 Route Hints Inspector', price_sats: 5, category: 'bitcoin/bolt11',
    description: 'Extract routing hints from a BOLT11 invoice.',
    probe_body: '{"invoice":"lnbc1test"}' },
  { path: '/api/bolt11-tag-inventory', name: 'BOLT11 Tag Inventory', price_sats: 5, category: 'bitcoin/bolt11',
    description: 'List all tagged fields present in a BOLT11 invoice.',
    probe_body: '{"invoice":"lnbc1test"}' },
  { path: '/api/bolt11-fallbacks', name: 'BOLT11 Fallbacks Inspector', price_sats: 5, category: 'bitcoin/bolt11',
    description: 'Extract fallback on-chain addresses from a BOLT11 invoice.',
    probe_body: '{"invoice":"lnbc1test"}' },
  { path: '/api/bolt11-payment-hash', name: 'BOLT11 Payment Hash Inspector', price_sats: 5, category: 'bitcoin/bolt11',
    description: 'Extract payment hash from a BOLT11 invoice.',
    probe_body: '{"invoice":"lnbc1test"}' },
  { path: '/api/bolt11-description-hash', name: 'BOLT11 Description Hash Inspector', price_sats: 5, category: 'bitcoin/bolt11',
    description: 'Extract description hash from a BOLT11 invoice.',
    probe_body: '{"invoice":"lnbc1test"}' },
  { path: '/api/bolt11-features', name: 'BOLT11 Features Inspector', price_sats: 5, category: 'bitcoin/bolt11',
    description: 'Extract feature bits from a BOLT11 invoice.',
    probe_body: '{"invoice":"lnbc1test"}' },
  { path: '/api/bolt11-signature', name: 'BOLT11 Signature Inspector', price_sats: 5, category: 'bitcoin/bolt11',
    description: 'Extract and display the signature from a BOLT11 invoice.',
    probe_body: '{"invoice":"lnbc1test"}' },

  // --- Nostr (14) ---
  { path: '/api/nip05-verify', name: 'NIP-05 Verifier', price_sats: 20, category: 'nostr',
    description: 'Verify a NIP-05 identifier (name@domain) resolves to a valid Nostr pubkey.',
    probe_body: '{"identifier":"test@example.com"}' },
  { path: '/api/npub-decode', name: 'npub Decoder', price_sats: 5, category: 'nostr',
    description: 'Decode a Nostr npub identifier to its hex public key.',
    probe_body: '{"npub":"npub1test"}' },
  { path: '/api/npub-encode', name: 'npub Encoder', price_sats: 5, category: 'nostr',
    description: 'Encode a hex public key as an npub identifier.',
    probe_body: `{"pubkey":"${HEX64}"}` },
  { path: '/api/nprofile-decode', name: 'nprofile Decoder', price_sats: 5, category: 'nostr',
    description: 'Decode an nprofile identifier to its pubkey and relay list.',
    probe_body: '{"nprofile":"nprofile1test"}' },
  { path: '/api/nprofile-encode', name: 'nprofile Encoder', price_sats: 5, category: 'nostr',
    description: 'Encode a pubkey and relay list as an nprofile identifier.',
    probe_body: `{"pubkey":"${HEX64}"}` },
  { path: '/api/nevent-decode', name: 'nevent Decoder', price_sats: 5, category: 'nostr',
    description: 'Decode an nevent identifier to its event ID, relays, and author.',
    probe_body: '{"nevent":"nevent1test"}' },
  { path: '/api/nevent-encode', name: 'nevent Encoder', price_sats: 5, category: 'nostr',
    description: 'Encode an event ID as an nevent identifier.',
    probe_body: `{"event_id":"${HEX64}"}` },
  { path: '/api/naddr-decode', name: 'naddr Decoder', price_sats: 5, category: 'nostr',
    description: 'Decode an naddr identifier to its address components.',
    probe_body: '{"naddr":"naddr1test"}' },
  { path: '/api/naddr-encode', name: 'naddr Encoder', price_sats: 5, category: 'nostr',
    description: 'Encode an address as an naddr identifier.',
    probe_body: `{"identifier":"test","author_pubkey":"${HEX64}","kind":30023}` },
  { path: '/api/nrelay-decode', name: 'nrelay Decoder', price_sats: 5, category: 'nostr',
    description: 'Decode an nrelay identifier to its relay URL.',
    probe_body: '{"nrelay":"nrelay1test"}' },
  { path: '/api/note-decode', name: 'note Decoder', price_sats: 5, category: 'nostr',
    description: 'Decode a note identifier to its hex event ID.',
    probe_body: '{"note":"note1test"}' },
  { path: '/api/note-encode', name: 'note Encoder', price_sats: 5, category: 'nostr',
    description: 'Encode a hex event ID as a note identifier.',
    probe_body: `{"event_id":"${HEX64}"}` },
  { path: '/api/nostr-id-inspect', name: 'Nostr ID Inspector', price_sats: 6, category: 'nostr',
    description: 'Inspect any Nostr identifier (npub, note, nprofile, nevent, naddr, nrelay) and decode its contents.',
    probe_body: '{"identifier":"npub1test"}' },

  // --- Lightning (5) ---
  { path: '/api/lnurlp-resolve', name: 'LNURL-pay Resolver', price_sats: 15, category: 'lightning',
    description: 'Resolve a Lightning address to its LNURL-pay endpoint and metadata.',
    probe_body: '{"address":"test@example.com"}' },
  { path: '/api/lightning-address-parse', name: 'Lightning Address Parser', price_sats: 4, category: 'lightning',
    description: 'Parse a Lightning address into its username and domain components.',
    probe_body: '{"address":"test@example.com"}' },
  { path: '/api/lnurl-decode', name: 'LNURL Decoder', price_sats: 5, category: 'lightning',
    description: 'Decode a bech32-encoded LNURL to its plain URL.',
    probe_body: '{"lnurl":"lnurl1test"}' },
  { path: '/api/lnurl-encode', name: 'LNURL Encoder', price_sats: 5, category: 'lightning',
    description: 'Encode a URL as a bech32 LNURL.',
    probe_body: '{"url":"https://example.com"}' },
  { path: '/api/fee-estimate', name: 'Bitcoin Fee Estimate', price_sats: 5, category: 'lightning',
    description: 'Get current Bitcoin network fee estimates.',
    probe_body: '{"amount":1000}' },

  // --- Bitcoin (5) ---
  { path: '/api/bip21-parse', name: 'BIP21 URI Parser', price_sats: 4, category: 'bitcoin',
    description: 'Parse a BIP21 bitcoin: URI into its address and parameters.',
    probe_body: '{"uri":"bitcoin:1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"}' },
  { path: '/api/bip21-build', name: 'BIP21 URI Builder', price_sats: 4, category: 'bitcoin',
    description: 'Build a BIP21 bitcoin: URI from an address and optional parameters.',
    probe_body: '{"address":"1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"}' },
  { path: '/api/bip21-normalize', name: 'BIP21 URI Normalizer', price_sats: 4, category: 'bitcoin',
    description: 'Normalize a BIP21 bitcoin: URI to canonical form.',
    probe_body: '{"uri":"bitcoin:1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"}' },
  { path: '/api/bitcoin-address-validate', name: 'Bitcoin Address Validator', price_sats: 4, category: 'bitcoin',
    description: 'Validate a Bitcoin address and identify its type (P2PKH, P2SH, bech32, taproot).',
    probe_body: '{"address":"1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"}' },
  { path: '/api/bolt12-decode', name: 'BOLT12 Offer Decoder', price_sats: 5, category: 'bitcoin',
    description: 'Decode a BOLT12 offer string into its component fields.',
    probe_body: null }, // BOLT12 has strict bech32 validation; no trivial probe body

  // --- L402 Debugging (5) ---
  { path: '/api/proof-replay', name: 'L402 Proof Replay Generator', price_sats: 7, category: 'l402/tools',
    description: 'Generate L402 proof-of-payment replay tokens for authenticated requests.',
    probe_body: '{"url":"https://example.com/test"}' },
  { path: '/api/l402-parse', name: 'L402 Challenge Parser', price_sats: 8, category: 'l402/tools',
    description: 'Parse an L402 WWW-Authenticate challenge header into its components (macaroon, invoice).',
    probe_body: '{"www_authenticate":"L402 macaroon=test, invoice=lnbc1test"}' },
  { path: '/api/l402-hash-verify', name: 'L402 Hash Verifier', price_sats: 8, category: 'l402/tools',
    description: 'Verify L402 payment hash consistency between invoice and macaroon.',
    probe_body: `{"endpoint_payment_hash":"${HEX64}"}` },
  { path: '/api/l402-auth-build', name: 'L402 Auth Builder', price_sats: 9, category: 'l402/tools',
    description: 'Build an L402 Authorization header from payment hash and macaroon.',
    probe_body: `{"endpoint_payment_hash":"${HEX64}"}` },
  { path: '/api/l402-auth-diagnose', name: 'L402 Auth Diagnoser', price_sats: 9, category: 'l402/tools',
    description: 'Diagnose L402 authentication issues by analyzing challenge and payment data.',
    probe_body: `{"endpoint_payment_hash":"${HEX64}"}` },

  // --- Web of Trust (1) ---
  { path: '/api/wot-report', name: 'Web of Trust Report', price_sats: 100, category: 'nostr/wot',
    description: 'Generate a Web of Trust report for a Nostr pubkey, analyzing trust graph and social connections.',
    probe_body: `{"pubkey":"${HEX64}"}` },
]

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

const findExisting = db.prepare("SELECT id FROM services WHERE url = ? AND protocol = 'L402'")

let inserted = 0
let updated = 0

const runAll = db.transaction(() => {
  for (const ep of endpoints) {
    const url = `https://maximumsats.com${ep.path}`
    const existing = findExisting.get(url)
    const params = {
      id: existing ? existing.id : randomUUID(),
      name: ep.name,
      description: ep.description,
      url,
      price_sats: ep.price_sats,
      price_usd: null,
      category: ep.category,
      provider: 'MaximumSats',
      probe_body: ep.probe_body,
    }
    upsert.run(params)
    if (existing) {
      updated++
    } else {
      inserted++
    }
  }
})

runAll()

const total = db.prepare("SELECT COUNT(*) as c FROM services WHERE provider = 'MaximumSats'").get()
console.log(`MaximumSats registration complete: ${inserted} inserted, ${updated} updated`)
console.log(`Total MaximumSats services in DB: ${total.c}`)

db.close()
