/**
 * Tests for detail page dual-rail display and MCP tool description updates
 * Issue #88: UI detail page should show related services ("Also available via")
 *            and MCP tool descriptions should mention related_protocols/related_services
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import db from '../src/db.js'
import { startServer, stopServer } from './helpers/server.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

let BASE

before(async () => {
  BASE = await startServer()

  const insert = db.prepare(`INSERT INTO services (id, name, url, protocol, source, health_status, status, provider_deleted, price_sats, price_usd, payment_asset, payment_network, reliability_score, uptime_30d, latency_p50_ms, registered_at, updated_at)
    VALUES (@id, @name, @url, @protocol, @source, @health, @status, @provider_deleted, @price_sats, @price_usd, @payment_asset, @payment_network, @reliability_score, @uptime_30d, @latency_p50_ms, datetime('now'), datetime('now'))`)

  const seeds = [
    // Dual-protocol pair: same URL, different protocols
    { id: 'dr-1', name: 'Dual Rail L402', url: 'https://dualrail.example.com/api', protocol: 'L402', source: 'satring', health: 'healthy', status: 'active', provider_deleted: 0, price_sats: 100, price_usd: 0.05, payment_asset: 'BTC', payment_network: 'lightning', reliability_score: 90, uptime_30d: 99.5, latency_p50_ms: 80 },
    { id: 'dr-2', name: 'Dual Rail x402', url: 'https://dualrail.example.com/api', protocol: 'x402', source: 'bazaar', health: 'healthy', status: 'active', provider_deleted: 0, price_sats: 200, price_usd: 0.10, payment_asset: 'USDC', payment_network: 'base', reliability_score: 85, uptime_30d: 98.0, latency_p50_ms: 120 },
    // Single-protocol service (no sibling)
    { id: 'dr-3', name: 'Solo Detail Service', url: 'https://solodetail.example.com/api', protocol: 'L402', source: 'satring', health: 'healthy', status: 'active', provider_deleted: 0, price_sats: 50, price_usd: 0.02, payment_asset: 'BTC', payment_network: 'lightning', reliability_score: 80, uptime_30d: 97.0, latency_p50_ms: 150 },
    // Soft-deleted sibling pair
    { id: 'dr-4', name: 'Active Rail', url: 'https://deletedrail.example.com/api', protocol: 'L402', source: 'satring', health: 'healthy', status: 'active', provider_deleted: 0, price_sats: 75, price_usd: 0.03, payment_asset: 'BTC', payment_network: 'lightning', reliability_score: 70, uptime_30d: 95.0, latency_p50_ms: 200 },
    { id: 'dr-5', name: 'Deleted Rail x402', url: 'https://deletedrail.example.com/api', protocol: 'x402', source: 'bazaar', health: 'healthy', status: 'active', provider_deleted: 1, price_sats: 150, price_usd: 0.07, payment_asset: 'USDC', payment_network: 'base', reliability_score: 60, uptime_30d: 90.0, latency_p50_ms: 250 },
  ]
  for (const s of seeds) insert.run(s)
})

after(async () => {
  try { db.prepare("DELETE FROM services WHERE id LIKE 'dr-%'").run() } catch {}
  await stopServer()
})

async function raw(path) {
  const res = await fetch(`${BASE}${path}`)
  return { status: res.status, text: await res.text() }
}

// ─── Pages route: detail page with related services ───────────────────────

describe('GET /service/:id — dual-rail display', () => {
  it('shows "Also available via" section when related services exist', async () => {
    const r = await raw('/service/dr-1')
    assert.equal(r.status, 200)
    assert.ok(r.text.includes('Also available via'), 'should contain "Also available via" heading')
    assert.ok(r.text.includes('x402'), 'should show sibling protocol badge')
    assert.ok(r.text.includes('/service/dr-2'), 'should link to sibling service')
  })

  it('omits "Also available via" section when no related services exist', async () => {
    const r = await raw('/service/dr-3')
    assert.equal(r.status, 200)
    assert.ok(!r.text.includes('Also available via'), 'should NOT contain "Also available via" when no siblings')
  })

  it('excludes soft-deleted siblings from "Also available via"', async () => {
    const r = await raw('/service/dr-4')
    assert.equal(r.status, 200)
    assert.ok(!r.text.includes('Also available via'), 'should NOT show "Also available via" when sibling is soft-deleted')
  })
})

// ─── MCP tool descriptions ───────────────────────────────────────────────

describe('MCP tool descriptions', () => {
  it('search_services description mentions related_protocols', () => {
    const mcpSource = readFileSync(resolve(__dirname, '../mcp-server/src/index.ts'), 'utf8')
    // Find the search_services tool description
    const searchMatch = mcpSource.match(/server\.tool\(\s*'search_services',\s*'([^']+)'/s)
    assert.ok(searchMatch, 'should find search_services tool definition')
    assert.ok(searchMatch[1].includes('related_protocols'), 'search_services description should mention related_protocols')
  })

  it('get_service_detail description mentions related_services', () => {
    const mcpSource = readFileSync(resolve(__dirname, '../mcp-server/src/index.ts'), 'utf8')
    const detailMatch = mcpSource.match(/server\.tool\(\s*'get_service_detail',\s*'([^']+)'/s)
    assert.ok(detailMatch, 'should find get_service_detail tool definition')
    assert.ok(detailMatch[1].includes('related_services'), 'get_service_detail description should mention related_services')
  })
})
