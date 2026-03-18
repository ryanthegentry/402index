import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { homePage } from '../src/views/home.js'
import { protocolBadge } from '../src/views/helpers.js'
import { registerWebhook, createWebhooksTable } from '../src/services/webhooks.js'
import Database from 'better-sqlite3'

describe('MPP protocol bar integration', () => {
  const baseStats = {
    totalIndexed: 100, verified: 50, distinctServices: 20, distinctProviders: 10,
    healthy: 40, degraded: 5, down: 5,
    l402Providers: 5, baseProviders: 3, solanaProviders: 1, tempoProviders: 2,
    allL402Providers: 8, allBaseProviders: 4, allSolanaProviders: 1, allTempoProviders: 3,
    mppProviders: 2, allMppProviders: 3,
  }

  it('renders tempo segment in protocol bar', () => {
    const html = homePage({
      services: [], total: 0, limit: 25, offset: 0,
      filters: {}, stats: baseStats, categories: [], btcUsdRate: 60000,
    })
    assert.ok(html.includes('protocol-fill-tempo'), 'should include tempo fill bar')
    assert.ok(html.includes('protocol-tempo'), 'should include tempo label span')
    assert.ok(html.includes('Tempo'), 'should include Tempo text in label')
  })

  it('hides tempo label when zero tempo providers', () => {
    const stats = { ...baseStats, tempoProviders: 0, allTempoProviders: 0 }
    const html = homePage({
      services: [], total: 0, limit: 25, offset: 0,
      filters: {}, stats, categories: [], btcUsdRate: 60000,
    })
    // The fill div is always in the track (0% width), but the label span should be hidden
    assert.ok(!html.includes('class="protocol-tempo"'), 'should not include tempo label span when zero providers')
  })

  it('includes MPP in protocol filter dropdown', () => {
    const html = homePage({
      services: [], total: 0, limit: 25, offset: 0,
      filters: {}, stats: baseStats, categories: [], btcUsdRate: 60000,
    })
    assert.ok(html.includes('value="MPP"'), 'protocol filter should have MPP option')
  })

  it('includes mpp in source filter dropdown', () => {
    const html = homePage({
      services: [], total: 0, limit: 25, offset: 0,
      filters: {}, stats: baseStats, categories: [], btcUsdRate: 60000,
    })
    assert.ok(html.includes('value="mpp"'), 'source filter should have mpp option')
  })

  it('selects MPP in protocol dropdown when filtered', () => {
    const html = homePage({
      services: [], total: 0, limit: 25, offset: 0,
      filters: { protocol: 'MPP' }, stats: baseStats, categories: [], btcUsdRate: 60000,
    })
    assert.ok(html.includes('value="MPP" selected'), 'MPP option should be selected')
  })
})

describe('MPP protocol badge', () => {
  it('returns badge-mpp class for MPP protocol', () => {
    const badge = protocolBadge('MPP')
    assert.ok(badge.includes('badge-mpp'), 'should have badge-mpp class')
    assert.ok(badge.includes('>MPP<'), 'should display MPP text')
  })

  it('still returns correct badges for L402 and x402', () => {
    assert.ok(protocolBadge('L402').includes('badge-l402'))
    assert.ok(protocolBadge('x402').includes('badge-x402'))
  })
})

describe('MPP webhook protocol validation', () => {
  it('accepts MPP as valid protocol_filter', () => {
    const db = new Database(':memory:')
    createWebhooksTable(db)
    const result = registerWebhook(db, {
      url: 'https://example.com/hook',
      secret: 'test-secret-123',
      events: 'service.new',
      protocol_filter: 'MPP',
    })
    assert.ok(result.id, 'webhook should be created with MPP filter')
  })

  it('rejects invalid protocol_filter', () => {
    const db = new Database(':memory:')
    createWebhooksTable(db)
    assert.throws(() => {
      registerWebhook(db, {
        url: 'https://example.com/hook',
        secret: 'test-secret-123',
        protocol_filter: 'INVALID',
      })
    }, /Invalid protocol filter/)
  })
})
