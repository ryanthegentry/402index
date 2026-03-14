import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { buildNostrEvent, publishNostr } from '../src/services/nostr.js'

const SAMPLE_SERVICE = {
  id: 'abc-123',
  name: 'Test API',
  url: 'https://api.example.com/weather',
  protocol: 'L402',
  price_sats: 100,
  price_usd: 0.08,
  category: 'data/weather',
  health_status: 'healthy',
}

describe('publishNostr', () => {
  let originalPrivKey
  let originalRelays

  beforeEach(() => {
    originalPrivKey = process.env.NOSTR_PRIVATE_KEY
    originalRelays = process.env.NOSTR_RELAY_URLS
  })

  afterEach(() => {
    if (originalPrivKey !== undefined) process.env.NOSTR_PRIVATE_KEY = originalPrivKey
    else delete process.env.NOSTR_PRIVATE_KEY
    if (originalRelays !== undefined) process.env.NOSTR_RELAY_URLS = originalRelays
    else delete process.env.NOSTR_RELAY_URLS
  })

  it('silently returns when NOSTR_PRIVATE_KEY is unset', async () => {
    delete process.env.NOSTR_PRIVATE_KEY
    process.env.NOSTR_RELAY_URLS = 'wss://relay.example.com'
    // Should not throw
    await publishNostr('service.new', SAMPLE_SERVICE)
  })

  it('silently returns when NOSTR_RELAY_URLS is unset', async () => {
    process.env.NOSTR_PRIVATE_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    delete process.env.NOSTR_RELAY_URLS
    // Should not throw
    await publishNostr('service.new', SAMPLE_SERVICE)
  })

  it('does not throw on relay connection failure', async () => {
    process.env.NOSTR_PRIVATE_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    process.env.NOSTR_RELAY_URLS = 'wss://invalid.relay.example.com:99999'
    // Should not throw even with bad relay
    await publishNostr('service.new', SAMPLE_SERVICE)
  })
})

describe('buildNostrEvent', () => {
  it('constructs event with kind 30402 (NIP-99)', () => {
    const event = buildNostrEvent('service.new', SAMPLE_SERVICE)
    assert.equal(event.kind, 30402)
  })

  it('includes required tags', () => {
    const event = buildNostrEvent('service.new', SAMPLE_SERVICE)
    const tagNames = event.tags.map(t => t[0])
    assert.ok(tagNames.includes('d'), 'Should include d tag')
    assert.ok(tagNames.includes('t'), 'Should include t tag')
    assert.ok(tagNames.includes('r'), 'Should include r tag')
    assert.ok(tagNames.includes('l'), 'Should include l tag')
    assert.ok(tagNames.includes('L'), 'Should include L tag')
  })

  it('uses service URL as d tag (dedup key)', () => {
    const event = buildNostrEvent('service.new', SAMPLE_SERVICE)
    const dTag = event.tags.find(t => t[0] === 'd')
    assert.equal(dTag[1], 'https://api.example.com/weather')
  })

  it('uses category as t tag', () => {
    const event = buildNostrEvent('service.new', SAMPLE_SERVICE)
    const tTag = event.tags.find(t => t[0] === 't')
    assert.equal(tTag[1], 'data/weather')
  })

  it('uses protocol as l tag with namespace', () => {
    const event = buildNostrEvent('service.new', SAMPLE_SERVICE)
    const lTag = event.tags.find(t => t[0] === 'l')
    assert.equal(lTag[1], 'L402')
    assert.equal(lTag[2], 'protocol')
  })

  it('includes price tag with sats', () => {
    const event = buildNostrEvent('service.new', SAMPLE_SERVICE)
    const priceTag = event.tags.find(t => t[0] === 'price')
    assert.equal(priceTag[1], '100')
    assert.equal(priceTag[2], 'sats')
  })

  it('content is valid JSON with service fields and event_type', () => {
    const event = buildNostrEvent('service.new', SAMPLE_SERVICE)
    const content = JSON.parse(event.content)
    assert.equal(content.name, 'Test API')
    assert.equal(content.url, 'https://api.example.com/weather')
    assert.equal(content.protocol, 'L402')
    assert.equal(content.event_type, 'service.new')
  })

  it('has created_at as unix timestamp', () => {
    const event = buildNostrEvent('service.new', SAMPLE_SERVICE)
    assert.equal(typeof event.created_at, 'number')
    assert.ok(event.created_at > 1700000000, 'Should be a recent unix timestamp')
  })

  it('handles null category gracefully', () => {
    const service = { ...SAMPLE_SERVICE, category: null }
    const event = buildNostrEvent('service.new', service)
    const tTags = event.tags.filter(t => t[0] === 't')
    assert.equal(tTags.length, 0, 'Should omit t tag when category is null')
  })

  it('handles null price_sats gracefully', () => {
    const service = { ...SAMPLE_SERVICE, price_sats: null }
    const event = buildNostrEvent('service.new', service)
    const priceTags = event.tags.filter(t => t[0] === 'price')
    assert.equal(priceTags.length, 0, 'Should omit price tag when price_sats is null')
  })
})
