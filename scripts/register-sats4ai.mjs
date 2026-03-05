#!/usr/bin/env node
// Register Sats4AI L402 endpoints discovered from .well-known/l402-services
// Run on Railway: railway ssh -- node scripts/register-sats4ai.mjs

import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'

const dbPath = process.env.DB_PATH || '/data/402index.db'
const db = new Database(dbPath)

const BTC_USD = 90000
const SATS_PER_BTC = 100_000_000

function satsToUsd(sats) {
  return Math.round((sats / SATS_PER_BTC) * BTC_USD * 1000000) / 1000000
}

// Probe bodies discovered 2026-03-05 — each endpoint validates request body
// before issuing L402 challenge, so we need endpoint-specific probe payloads.
const endpoints = [
  {
    name: 'Sats4AI: Image Generation',
    description: 'Generate AI images from text prompts. Returns base64-encoded image data.',
    url: 'https://sats4ai.com/api/l402/image',
    price_sats: 100,
    category: 'ai',
    probe_body: '{"input":{"prompt":"test"},"model":"Standard"}',
  },
  {
    name: 'Sats4AI: Text Generation',
    description: 'Generate text responses using open-source LLMs (Groq, DeepInfra, Replicate).',
    url: 'https://sats4ai.com/api/l402/text-generation',
    price_sats: 21,
    category: 'ai',
    probe_body: '{"input":[{"role":"User","content":"test"}],"model":"Standard"}',
  },
  {
    name: 'Sats4AI: SMS Messaging',
    description: 'Send SMS messages worldwide. Max 120 characters. Price varies by destination.',
    url: 'https://sats4ai.com/api/l402/sms',
    price_sats: 1500,
    category: 'communication',
    probe_body: '{"phone_number":"+15551234567","message":"test"}',
  },
  {
    name: 'Sats4AI: Video Generation',
    description: 'Generate video from text prompts.',
    url: 'https://sats4ai.com/api/l402/video',
    price_sats: 50,
    category: 'media',
    probe_body: '{"prompt":"test","model":"Video Generation","duration":5}',
  },
  {
    name: 'Sats4AI: Video from Image',
    description: 'Generate video from an image with text guidance.',
    url: 'https://sats4ai.com/api/l402/video-image',
    price_sats: 100,
    category: 'media',
    probe_body: '{"prompt":"test","model":"Image to Video","image":"data:image/png;base64,dGVzdA==","duration":5}',
  },
  {
    name: 'Sats4AI: Music Generation',
    description: 'Create original songs with AI-composed music and vocals.',
    url: 'https://sats4ai.com/api/l402/music',
    price_sats: 200,
    category: 'media',
    probe_body: '{"prompt":"test rock song","lyrics":"la la la test","model":"Music Generation"}',
  },
  {
    name: 'Sats4AI: Speech Transcription',
    description: 'Transcribe or translate audio files.',
    url: 'https://sats4ai.com/api/l402/speech',
    price_sats: 10,
    category: 'ai',
    probe_body: '{"file":"data:audio/mp3;base64,dGVzdA==","type":"transcription","model":"Transcription"}',
  },
  {
    name: 'Sats4AI: Image Analysis',
    description: 'Analyze and describe image content using vision models.',
    url: 'https://sats4ai.com/api/l402/vision',
    price_sats: 21,
    category: 'ai',
    probe_body: '{"image":"data:image/png;base64,dGVzdA==","prompt":"describe this","model":"Vision Chat"}',
  },
  {
    name: 'Sats4AI: 3D Model Generation',
    description: 'Generate 3D models from images.',
    url: 'https://sats4ai.com/api/l402/3d-model',
    price_sats: 350,
    category: 'ai',
    probe_body: '{"image":"data:image/png;base64,dGVzdA=="}',
  },
  {
    name: 'Sats4AI: File Conversion',
    description: 'Convert files between formats using CloudConvert.',
    url: 'https://sats4ai.com/api/l402/file-conversion',
    price_sats: 100,
    category: 'utility',
    probe_body: '{"file":"dGVzdA==","file_name":"test.txt","extensionFrom":"txt","extensionTo":"pdf"}',
  },
]

// Step 1: Remove old .well-known entry
console.log('=== Removing old .well-known entry ===')
const oldEntry = db.prepare("SELECT id, url, name FROM services WHERE url LIKE '%sats4ai.com/.well-known%'").get()
if (oldEntry) {
  db.prepare('DELETE FROM health_checks WHERE service_id = ?').run(oldEntry.id)
  db.prepare('DELETE FROM services WHERE id = ?').run(oldEntry.id)
  console.log(`  Removed: ${oldEntry.name} (${oldEntry.url})`)
} else {
  console.log('  No .well-known entry found')
}

// Step 2: Upsert endpoints
console.log('\n=== Registering Sats4AI endpoints ===')
const upsert = db.prepare(`
  INSERT INTO services (id, name, description, url, protocol, price_sats, price_usd,
    payment_asset, payment_network, category, provider, source, http_method, probe_body,
    health_status, registered_at, updated_at)
  VALUES (@id, @name, @description, @url, 'L402', @price_sats, @price_usd,
    'BTC', 'Lightning', @category, 'Sats4AI', 'well-known', 'POST', @probe_body,
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

let inserted = 0
let updated = 0
for (const ep of endpoints) {
  const existing = db.prepare("SELECT id FROM services WHERE url = ? AND protocol = 'L402'").get(ep.url)
  const result = upsert.run({
    id: existing ? existing.id : randomUUID(),
    name: ep.name,
    description: ep.description,
    url: ep.url,
    price_sats: ep.price_sats,
    price_usd: satsToUsd(ep.price_sats),
    category: ep.category,
    probe_body: ep.probe_body,
  })
  if (existing) {
    updated++
    console.log(`  Updated: ${ep.name} (${ep.url})`)
  } else {
    inserted++
    console.log(`  Inserted: ${ep.name} (${ep.url})`)
  }
}

// Step 3: Summary
console.log(`\n=== Summary ===`)
console.log(`  Inserted: ${inserted}`)
console.log(`  Updated: ${updated}`)
if (oldEntry) console.log(`  Removed old .well-known entry: ${oldEntry.id}`)

const total = db.prepare("SELECT COUNT(*) as c FROM services WHERE provider = 'Sats4AI'").get()
const l402 = db.prepare("SELECT COUNT(*) as c FROM services WHERE provider = 'Sats4AI' AND protocol = 'L402'").get()
console.log(`  Total Sats4AI services: ${total.c} (${l402.c} L402)`)

db.close()
