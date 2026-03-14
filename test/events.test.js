import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { emit } from '../src/services/events.js'
import { createWebhooksTable } from '../src/services/webhooks.js'

function createTestDb() {
  const db = new Database(':memory:')
  createWebhooksTable(db)
  return db
}

describe('emit', () => {
  let db
  let originalPrivKey
  let originalRelays
  let originalResendKey

  beforeEach(() => {
    db = createTestDb()
    originalPrivKey = process.env.NOSTR_PRIVATE_KEY
    originalRelays = process.env.NOSTR_RELAY_URLS
    originalResendKey = process.env.RESEND_API_KEY
    // Disable all external calls
    delete process.env.NOSTR_PRIVATE_KEY
    delete process.env.NOSTR_RELAY_URLS
    delete process.env.RESEND_API_KEY
  })

  afterEach(() => {
    if (originalPrivKey !== undefined) process.env.NOSTR_PRIVATE_KEY = originalPrivKey
    else delete process.env.NOSTR_PRIVATE_KEY
    if (originalRelays !== undefined) process.env.NOSTR_RELAY_URLS = originalRelays
    else delete process.env.NOSTR_RELAY_URLS
    if (originalResendKey !== undefined) process.env.RESEND_API_KEY = originalResendKey
    else delete process.env.RESEND_API_KEY
  })

  it('does not throw on any event type', async () => {
    const service = { id: 'abc', name: 'Test', url: 'https://example.com', protocol: 'L402' }
    await emit('service.new', service, db)
    await emit('service.health_changed', service, db)
    await emit('service.down', service, db)
  })

  it('does not throw when db has no webhooks', async () => {
    const service = { id: 'abc', name: 'Test', url: 'https://example.com', protocol: 'L402' }
    await emit('service.new', service, db)
  })

  it('does not throw when handlers reject', async () => {
    // Even with invalid db, should not throw
    const fakeDb = { prepare: () => { throw new Error('db error') } }
    const service = { id: 'abc', name: 'Test' }
    await emit('service.new', service, fakeDb)
  })

  it('does not throw with null service', async () => {
    await emit('service.new', null, db)
  })

  it('does not throw with unknown event type', async () => {
    const service = { id: 'abc', name: 'Test' }
    await emit('unknown.event', service, db)
  })
})
