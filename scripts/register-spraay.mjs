#!/usr/bin/env node
// Register Spraay x402 gateway endpoints
// Run on Railway: railway ssh -- node scripts/register-spraay.mjs
//
// Discovery findings (2026-03-16):
// - Provider: Spraay (spraay.app) — full-stack x402 infrastructure platform
// - Gateway: https://gateway.spraay.app
// - 70 primitives across 12 categories
// - USDC on Base — no API keys or subscriptions
// - Docs: docs.spraay.app
// - MCP server: @plagtech/spraay-x402-mcp
// - Listed on x402.org/ecosystem
//
// Registering representative live endpoints across categories.
// Some endpoints are "Coming Soon" per docs — only registering live ones.

import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'

const dbPath = process.env.DB_PATH || '/data/402index.db'
const db = new Database(dbPath)

const GATEWAY = 'https://gateway.spraay.app'

const upsert = db.prepare(`
  INSERT INTO services (id, name, description, url, protocol, price_usd,
    payment_asset, payment_network, category, provider, source, http_method,
    health_status, registered_at, updated_at)
  VALUES (@id, @name, @description, @url, 'x402', @price_usd,
    'USDC', 'Base', @category, 'Spraay', 'discovery', @http_method,
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
  // Data & Intelligence
  { name: 'Spraay: Price Feeds', description: 'Real-time cryptocurrency price feeds and gas estimates.', url: `${GATEWAY}/api/v1/prices`, price_usd: 0.008, http_method: 'GET', category: 'data' },
  { name: 'Spraay: Wallet Analytics', description: 'Wallet analytics and risk profiling. Analyze on-chain activity and assess wallet risk scores.', url: `${GATEWAY}/api/v1/analytics`, price_usd: 0.01, http_method: 'GET', category: 'data' },
  { name: 'Spraay: AI Chat', description: 'ML model inference gateway — access 93 AI models via pay-per-request.', url: `${GATEWAY}/api/v1/ai/chat`, price_usd: 0.04, http_method: 'POST', category: 'ai' },
  // Financial Primitives
  { name: 'Spraay: Token Swap Quote', description: 'Get swap quotes for token pairs across DEX aggregators.', url: `${GATEWAY}/api/v1/swap/quote`, price_usd: 0.008, http_method: 'GET', category: 'defi' },
  { name: 'Spraay: Bridge Transfer', description: 'Cross-chain bridge transfers between supported chains.', url: `${GATEWAY}/api/v1/bridge/transfer`, price_usd: 0.05, http_method: 'POST', category: 'defi' },
  { name: 'Spraay: Escrow Create', description: 'Create on-chain escrow contracts for secure peer-to-peer transactions.', url: `${GATEWAY}/api/v1/escrow/create`, price_usd: 0.10, http_method: 'POST', category: 'defi' },
  { name: 'Spraay: Invoice Create', description: 'Generate payment invoices for crypto transactions.', url: `${GATEWAY}/api/v1/invoice/create`, price_usd: 0.05, http_method: 'POST', category: 'payments' },
  { name: 'Spraay: Payroll Run', description: 'Execute batch payroll payments in crypto.', url: `${GATEWAY}/api/v1/payroll/run`, price_usd: 0.10, http_method: 'POST', category: 'payments' },
  // Infrastructure
  { name: 'Spraay: Multi-Chain RPC', description: 'Multi-chain RPC proxy. Route JSON-RPC calls to supported blockchains.', url: `${GATEWAY}/api/v1/rpc`, price_usd: 0.001, http_method: 'POST', category: 'infrastructure' },
  // GPU/Compute
  { name: 'Spraay: GPU Inference', description: 'Run inference on GPU-accelerated models via Replicate.', url: `${GATEWAY}/api/v1/gpu/run`, price_usd: 0.06, http_method: 'POST', category: 'compute' },
  // Search/RAG
  { name: 'Spraay: Web Search', description: 'Web search via Tavily. Returns relevant results with snippets for RAG pipelines.', url: `${GATEWAY}/api/v1/search/web`, price_usd: 0.02, http_method: 'POST', category: 'data' },
  { name: 'Spraay: Search Q&A', description: 'Question answering with web search. Synthesized answers from search results.', url: `${GATEWAY}/api/v1/search/qna`, price_usd: 0.03, http_method: 'POST', category: 'ai' },
  // Identity
  { name: 'Spraay: KYC Verify', description: 'On-demand identity verification for compliance-gated operations.', url: `${GATEWAY}/api/v1/kyc/verify`, price_usd: 0.08, http_method: 'POST', category: 'identity' },
  // Communication
  { name: 'Spraay: Notifications', description: 'Send email notifications programmatically via x402.', url: `${GATEWAY}/api/v1/notify/send`, price_usd: 0.01, http_method: 'POST', category: 'communication' },
  // Robotics
  { name: 'Spraay: Robot Task Dispatch', description: 'Dispatch tasks to registered robots/agents (Robot Task Protocol).', url: `${GATEWAY}/api/v1/robots/task`, price_usd: 0.05, http_method: 'POST', category: 'compute' },
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

const total = db.prepare("SELECT COUNT(*) as c FROM services WHERE provider = 'Spraay'").get()
console.log(`Spraay registration: ${inserted} inserted, ${updated} updated`)
console.log(`Total Spraay services in DB: ${total.c}`)

db.close()
