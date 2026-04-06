/**
 * Tests for related_protocols (list API) and related_services (detail API)
 * Issue #83: Surface dual-protocol relationships in API responses
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import db from '../src/db.js'
import { startServer, stopServer } from './helpers/server.js'

let BASE
let API

before(async () => {
  BASE = await startServer()
  API = `${BASE}/api/v1`

  const insert = db.prepare(`INSERT INTO services (id, name, url, protocol, source, health_status, status, provider_deleted, price_sats, price_usd, payment_asset, payment_network, reliability_score, uptime_30d, latency_p50_ms, registered_at, updated_at)
    VALUES (@id, @name, @url, @protocol, @source, @health, @status, @provider_deleted, @price_sats, @price_usd, @payment_asset, @payment_network, @reliability_score, @uptime_30d, @latency_p50_ms, datetime('now'), datetime('now'))`)

  const seeds = [
    // Dual-protocol pair: same URL, different protocols
    { id: 'rp-1', name: 'Dual L402', url: 'https://dual.example.com/api', protocol: 'L402', source: 'satring', health: 'healthy', status: 'active', provider_deleted: 0, price_sats: 100, price_usd: 0.05, payment_asset: 'BTC', payment_network: 'lightning', reliability_score: 90, uptime_30d: 99.5, latency_p50_ms: 80 },
    { id: 'rp-2', name: 'Dual x402', url: 'https://dual.example.com/api', protocol: 'x402', source: 'bazaar', health: 'healthy', status: 'active', provider_deleted: 0, price_sats: 200, price_usd: 0.10, payment_asset: 'USDC', payment_network: 'base', reliability_score: 85, uptime_30d: 98.0, latency_p50_ms: 120 },
    // Single-protocol service (no sibling)
    { id: 'rp-3', name: 'Solo Service', url: 'https://solo.example.com/api', protocol: 'L402', source: 'satring', health: 'healthy', status: 'active', provider_deleted: 0, price_sats: 50, price_usd: 0.02, payment_asset: 'BTC', payment_network: 'lightning', reliability_score: 80, uptime_30d: 97.0, latency_p50_ms: 150 },
    // Soft-deleted sibling (should be excluded)
    { id: 'rp-4', name: 'Deleted Sibling', url: 'https://deleted-pair.example.com/api', protocol: 'L402', source: 'satring', health: 'healthy', status: 'active', provider_deleted: 0, price_sats: 75, price_usd: 0.03, payment_asset: 'BTC', payment_network: 'lightning', reliability_score: 70, uptime_30d: 95.0, latency_p50_ms: 200 },
    { id: 'rp-5', name: 'Deleted x402', url: 'https://deleted-pair.example.com/api', protocol: 'x402', source: 'bazaar', health: 'healthy', status: 'active', provider_deleted: 1, price_sats: 150, price_usd: 0.07, payment_asset: 'USDC', payment_network: 'base', reliability_score: 60, uptime_30d: 90.0, latency_p50_ms: 250 },
  ]
  for (const s of seeds) insert.run(s)
})

after(async () => {
  try { db.prepare("DELETE FROM services WHERE id LIKE 'rp-%'").run() } catch {}
  await stopServer()
})

async function api(path) {
  const res = await fetch(`${API}${path}`)
  return { status: res.status, body: await res.json().catch(() => null) }
}

// ─── List endpoint: related_protocols ──────────────────────────────────────

describe('GET /api/v1/services — related_protocols', () => {
  it('dual-protocol URL returns related_protocols array with sibling protocol', async () => {
    const r = await api('/services?q=dual.example.com')
    assert.equal(r.status, 200)
    const l402 = r.body.services.find(s => s.id === 'rp-1')
    const x402 = r.body.services.find(s => s.id === 'rp-2')
    assert.ok(l402, 'L402 service should be in results')
    assert.ok(x402, 'x402 service should be in results')
    assert.ok(Array.isArray(l402.related_protocols), 'related_protocols should be a parsed array')
    assert.ok(Array.isArray(x402.related_protocols), 'related_protocols should be a parsed array')
    assert.deepEqual(l402.related_protocols, ['x402'])
    assert.deepEqual(x402.related_protocols, ['L402'])
  })

  it('single-protocol URL returns empty related_protocols array', async () => {
    const r = await api('/services?q=solo.example.com')
    assert.equal(r.status, 200)
    const solo = r.body.services.find(s => s.id === 'rp-3')
    assert.ok(solo, 'Solo service should be in results')
    assert.ok(Array.isArray(solo.related_protocols), 'related_protocols should be a parsed array')
    assert.deepEqual(solo.related_protocols, [])
  })

  it('related_protocols excludes soft-deleted siblings', async () => {
    const r = await api('/services?q=deleted-pair.example.com')
    assert.equal(r.status, 200)
    const active = r.body.services.find(s => s.id === 'rp-4')
    assert.ok(active, 'Active service should be in results')
    assert.ok(Array.isArray(active.related_protocols), 'related_protocols should be a parsed array')
    assert.deepEqual(active.related_protocols, [], 'soft-deleted sibling should be excluded')
  })
})

// ─── Detail endpoint: related_services ─────────────────────────────────────

describe('GET /api/v1/services/:id — related_services', () => {
  it('dual-protocol URL returns related_services array with sibling details', async () => {
    const r = await api('/services/rp-1')
    assert.equal(r.status, 200)
    assert.ok(Array.isArray(r.body.related_services), 'related_services should be an array')
    assert.equal(r.body.related_services.length, 1)
    const sibling = r.body.related_services[0]
    assert.equal(sibling.id, 'rp-2')
    assert.equal(sibling.protocol, 'x402')
    // Verify expected fields are present
    for (const field of ['id', 'protocol', 'health_status', 'price_sats', 'price_usd', 'payment_asset', 'payment_network', 'reliability_score', 'uptime_30d', 'latency_p50_ms']) {
      assert.ok(field in sibling, `related_services should include ${field}`)
    }
    // Verify it does NOT recursively include related_services
    assert.equal(sibling.related_services, undefined, 'related_services should not be recursive')
  })

  it('single-protocol URL returns empty related_services array', async () => {
    const r = await api('/services/rp-3')
    assert.equal(r.status, 200)
    assert.ok(Array.isArray(r.body.related_services), 'related_services should be an array')
    assert.deepEqual(r.body.related_services, [])
  })

  it('related_services excludes soft-deleted siblings', async () => {
    const r = await api('/services/rp-4')
    assert.equal(r.status, 200)
    assert.ok(Array.isArray(r.body.related_services), 'related_services should be an array')
    assert.deepEqual(r.body.related_services, [], 'soft-deleted sibling should be excluded')
  })
})
