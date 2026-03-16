#!/usr/bin/env node
// Register x402engine pay-per-call API endpoints
// Run on Railway: railway ssh -- node scripts/register-x402engine.mjs
//
// Discovery findings (2026-03-16):
// - Provider: x402engine (x402engine.app)
// - Gateway: https://x402-gateway-production.up.railway.app
// - 68 live APIs across 5 categories: LLM/AI, Compute, Crypto, Web, Travel/Storage
// - Payment: USDC on Base, USDm on MegaETH, USDC on Solana
// - No accounts, keys, or subscriptions — just stablecoins
// - Prices: $0.001 - $0.30 per call
//
// Registering representative endpoints per category.
// Full catalog at x402engine.app.

import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'

const dbPath = process.env.DB_PATH || '/data/402index.db'
const db = new Database(dbPath)

const GATEWAY = 'https://x402-gateway-production.up.railway.app'

const upsert = db.prepare(`
  INSERT INTO services (id, name, description, url, protocol, price_usd,
    payment_asset, payment_network, category, provider, source, http_method,
    health_status, registered_at, updated_at)
  VALUES (@id, @name, @description, @url, 'x402', @price_usd,
    'USDC', 'Base', @category, 'x402engine', 'discovery', @http_method,
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
  // LLM & AI
  { name: 'x402engine: GPT-5.4', description: 'OpenAI GPT-5.4 inference via pay-per-call. No API key needed.', url: `${GATEWAY}/api/llm/gpt-5.4`, price_usd: 0.10, http_method: 'POST', category: 'ai' },
  { name: 'x402engine: Claude Opus 4.6', description: 'Anthropic Claude Opus 4.6 inference via pay-per-call.', url: `${GATEWAY}/api/llm/claude-opus`, price_usd: 0.09, http_method: 'POST', category: 'ai' },
  { name: 'x402engine: Claude Sonnet 4.6', description: 'Anthropic Claude Sonnet 4.6 inference via pay-per-call.', url: `${GATEWAY}/api/llm/claude-sonnet-4.6`, price_usd: 0.06, http_method: 'POST', category: 'ai' },
  { name: 'x402engine: DeepSeek V3.2', description: 'DeepSeek V3.2 inference at $0.005/call. Budget-friendly LLM.', url: `${GATEWAY}/api/llm/deepseek-v3.2`, price_usd: 0.005, http_method: 'POST', category: 'ai' },
  { name: 'x402engine: Llama 3.3 70B', description: 'Meta Llama 3.3 70B inference at $0.002/call. Open-source LLM.', url: `${GATEWAY}/api/llm/llama`, price_usd: 0.002, http_method: 'POST', category: 'ai' },
  { name: 'x402engine: Grok 4', description: 'xAI Grok 4 inference via pay-per-call.', url: `${GATEWAY}/api/llm/grok`, price_usd: 0.06, http_method: 'POST', category: 'ai' },
  // Compute & Generation
  { name: 'x402engine: Image Gen (Fast)', description: 'FLUX Schnell image generation (~2s). Pay per image.', url: `${GATEWAY}/api/image/fast`, price_usd: 0.015, http_method: 'POST', category: 'media' },
  { name: 'x402engine: Image Gen (Quality)', description: 'FLUX.2 Pro production-quality image generation.', url: `${GATEWAY}/api/image/quality`, price_usd: 0.05, http_method: 'POST', category: 'media' },
  { name: 'x402engine: Code Execution', description: 'Sandboxed code execution — Python, JS, Bash, R.', url: `${GATEWAY}/api/code/run`, price_usd: 0.005, http_method: 'POST', category: 'compute' },
  { name: 'x402engine: Transcription', description: 'Deepgram Nova-3 speech transcription with diarization.', url: `${GATEWAY}/api/transcribe`, price_usd: 0.10, http_method: 'POST', category: 'ai' },
  { name: 'x402engine: TTS (OpenAI)', description: 'OpenAI text-to-speech, 6 voices, HD quality.', url: `${GATEWAY}/api/tts/openai`, price_usd: 0.01, http_method: 'POST', category: 'media' },
  { name: 'x402engine: Embeddings', description: 'Text embeddings (1536-dim) for search and RAG.', url: `${GATEWAY}/api/embeddings`, price_usd: 0.001, http_method: 'POST', category: 'ai' },
  // Crypto & Blockchain
  { name: 'x402engine: Crypto Prices', description: 'Real-time cryptocurrency prices via CoinGecko.', url: `${GATEWAY}/api/crypto/price`, price_usd: 0.001, http_method: 'GET', category: 'data' },
  { name: 'x402engine: Crypto Markets', description: 'Market rankings, volume, and market cap data.', url: `${GATEWAY}/api/crypto/markets`, price_usd: 0.002, http_method: 'GET', category: 'data' },
  { name: 'x402engine: Wallet Balances', description: 'Multi-chain wallet balances via Allium.', url: `${GATEWAY}/api/wallet/balances`, price_usd: 0.005, http_method: 'POST', category: 'data' },
  { name: 'x402engine: ENS Resolve', description: 'Resolve ENS names to Ethereum addresses.', url: `${GATEWAY}/api/ens/resolve`, price_usd: 0.001, http_method: 'GET', category: 'data' },
  { name: 'x402engine: TX Simulate', description: 'Simulate EVM transactions via Tenderly.', url: `${GATEWAY}/api/tx/simulate`, price_usd: 0.01, http_method: 'POST', category: 'data' },
  // Web Services
  { name: 'x402engine: Web Scrape', description: 'Scrape any URL to clean markdown for LLM input.', url: `${GATEWAY}/api/web/scrape`, price_usd: 0.005, http_method: 'GET', category: 'data' },
  { name: 'x402engine: Web Search', description: 'Neural web search with snippets.', url: `${GATEWAY}/api/search/web`, price_usd: 0.01, http_method: 'POST', category: 'data' },
  { name: 'x402engine: Screenshot', description: 'Capture any URL as a base64 image.', url: `${GATEWAY}/api/web/screenshot`, price_usd: 0.01, http_method: 'GET', category: 'data' },
  // Travel & Storage
  { name: 'x402engine: Flight Search', description: 'Search flights via Google Flights data.', url: `${GATEWAY}/api/travel/flights`, price_usd: 0.02, http_method: 'GET', category: 'travel' },
  { name: 'x402engine: IPFS Pin', description: 'Pin JSON, files, or URLs to IPFS.', url: `${GATEWAY}/api/ipfs/pin`, price_usd: 0.01, http_method: 'POST', category: 'storage' },
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

const total = db.prepare("SELECT COUNT(*) as c FROM services WHERE provider = 'x402engine'").get()
console.log(`x402engine registration: ${inserted} inserted, ${updated} updated`)
console.log(`Total x402engine services in DB: ${total.c}`)

db.close()
