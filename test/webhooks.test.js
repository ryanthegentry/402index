import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import Database from 'better-sqlite3'
import { registerWebhook, deleteWebhook, getWebhook, buildWebhookPayload, verifySecret, createWebhooksTable } from '../src/services/webhooks.js'

function createTestDb() {
  const db = new Database(':memory:')
  createWebhooksTable(db)
  return db
}

describe('createWebhooksTable', () => {
  it('creates webhooks table in database', () => {
    const db = createTestDb()
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='webhooks'").get()
    assert.ok(row, 'webhooks table should exist')
  })
})

describe('registerWebhook', () => {
  let db

  beforeEach(() => {
    db = createTestDb()
  })

  it('creates webhook with valid params and returns id', () => {
    const result = registerWebhook(db, {
      url: 'https://example.com/hook',
      secret: 'my-secret-123',
      events: 'service.new,service.down',
    })
    assert.ok(result.id, 'Should return an id')
    assert.equal(result.url, 'https://example.com/hook')
    assert.equal(result.events, 'service.new,service.down')
    assert.ok(result.created_at, 'Should have created_at')
  })

  it('defaults events to service.new when not specified', () => {
    const result = registerWebhook(db, {
      url: 'https://example.com/hook',
      secret: 'my-secret-123',
    })
    assert.equal(result.events, 'service.new')
  })

  it('stores protocol_filter when provided', () => {
    const result = registerWebhook(db, {
      url: 'https://example.com/hook',
      secret: 'my-secret-123',
      events: 'service.new',
      protocol_filter: 'L402',
    })
    const row = db.prepare('SELECT protocol_filter FROM webhooks WHERE id = ?').get(result.id)
    assert.equal(row.protocol_filter, 'L402')
  })

  it('rejects non-HTTPS URLs', () => {
    assert.throws(() => {
      registerWebhook(db, {
        url: 'http://example.com/hook',
        secret: 'my-secret-123',
      })
    }, /HTTPS/)
  })

  it('rejects missing URL', () => {
    assert.throws(() => {
      registerWebhook(db, {
        secret: 'my-secret-123',
      })
    }, /url.*required/i)
  })

  it('rejects missing secret', () => {
    assert.throws(() => {
      registerWebhook(db, {
        url: 'https://example.com/hook',
      })
    }, /secret.*required/i)
  })

  it('rejects invalid event names', () => {
    assert.throws(() => {
      registerWebhook(db, {
        url: 'https://example.com/hook',
        secret: 'my-secret-123',
        events: 'service.new,invalid.event',
      })
    }, /invalid.*event/i)
  })

  it('rejects invalid protocol_filter', () => {
    assert.throws(() => {
      registerWebhook(db, {
        url: 'https://example.com/hook',
        secret: 'my-secret-123',
        protocol_filter: 'INVALID',
      })
    }, /protocol/i)
  })
})

describe('deleteWebhook', () => {
  let db

  beforeEach(() => {
    db = createTestDb()
  })

  it('deletes webhook when secret matches', () => {
    const { id } = registerWebhook(db, {
      url: 'https://example.com/hook',
      secret: 'my-secret-123',
    })
    const result = deleteWebhook(db, id, 'my-secret-123')
    assert.equal(result, true)
    const row = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id)
    assert.equal(row, undefined, 'Webhook should be deleted')
  })

  it('rejects wrong secret', () => {
    const { id } = registerWebhook(db, {
      url: 'https://example.com/hook',
      secret: 'my-secret-123',
    })
    assert.throws(() => {
      deleteWebhook(db, id, 'wrong-secret')
    }, /unauthorized|secret/i)
  })

  it('throws for non-existent webhook', () => {
    assert.throws(() => {
      deleteWebhook(db, 'nonexistent', 'any-secret')
    }, /not found/i)
  })
})

describe('getWebhook', () => {
  let db

  beforeEach(() => {
    db = createTestDb()
  })

  it('returns webhook status when secret matches', () => {
    const { id } = registerWebhook(db, {
      url: 'https://example.com/hook',
      secret: 'my-secret-123',
      events: 'service.new,service.down',
    })
    const result = getWebhook(db, id, 'my-secret-123')
    assert.equal(result.id, id)
    assert.equal(result.url, 'https://example.com/hook')
    assert.equal(result.events, 'service.new,service.down')
    assert.equal(result.is_active, 1)
    assert.equal(result.failure_count, 0)
    assert.equal(result.secret, undefined, 'Should not return secret')
  })

  it('rejects wrong secret', () => {
    const { id } = registerWebhook(db, {
      url: 'https://example.com/hook',
      secret: 'my-secret-123',
    })
    assert.throws(() => {
      getWebhook(db, id, 'wrong-secret')
    }, /unauthorized|secret/i)
  })

  it('throws for non-existent webhook', () => {
    assert.throws(() => {
      getWebhook(db, 'nonexistent', 'any-secret')
    }, /not found/i)
  })
})

describe('verifySecret', () => {
  it('returns true for matching secrets', () => {
    assert.equal(verifySecret('my-secret', 'my-secret'), true)
  })

  it('returns false for non-matching secrets', () => {
    assert.equal(verifySecret('my-secret', 'wrong'), false)
  })

  it('returns false for empty strings', () => {
    assert.equal(verifySecret('', ''), true)
  })
})

describe('buildWebhookPayload', () => {
  it('builds correct payload structure', () => {
    const service = { id: 'abc', name: 'Test', url: 'https://example.com', protocol: 'L402' }
    const payload = buildWebhookPayload('service.new', service)
    assert.equal(payload.event, 'service.new')
    assert.deepEqual(payload.service, service)
    assert.ok(payload.timestamp, 'Should have timestamp')
  })

  it('generates valid HMAC signature', () => {
    const service = { id: 'abc', name: 'Test' }
    const payload = buildWebhookPayload('service.new', service)
    const body = JSON.stringify(payload)
    const secret = 'webhook-secret-123'
    const expected = crypto.createHmac('sha256', secret).update(body).digest('hex')
    const signature = crypto.createHmac('sha256', secret).update(body).digest('hex')
    assert.equal(signature, expected, 'HMAC should be verifiable')
  })

  it('timestamp is valid ISO 8601', () => {
    const payload = buildWebhookPayload('service.down', { id: 'abc' })
    const parsed = new Date(payload.timestamp)
    assert.ok(!isNaN(parsed.getTime()), 'Timestamp should be valid date')
  })
})
