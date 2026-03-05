/**
 * Tests for .well-known/l402-services auto-discovery
 *
 * Run: node --test test/wellknown-discovery.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { buildMinimalProbeBody, discoverProbeConfig } from '../src/services/wellknown-discovery.js'

// ─── buildMinimalProbeBody ──────────────────────────────────────────────────

describe('buildMinimalProbeBody', () => {
  it('returns {} for null schema', () => {
    assert.equal(buildMinimalProbeBody(null), '{}')
  })

  it('returns {} for undefined schema', () => {
    assert.equal(buildMinimalProbeBody(undefined), '{}')
  })

  it('returns {} for non-object schema', () => {
    assert.equal(buildMinimalProbeBody('not an object'), '{}')
  })

  it('returns {} for empty schema', () => {
    assert.equal(buildMinimalProbeBody({}), '{}')
  })

  it('skips non-required fields', () => {
    const schema = {
      optional_field: { type: 'string', required: false },
      another: { type: 'number' },
    }
    assert.equal(buildMinimalProbeBody(schema), '{}')
  })

  it('generates string field → "test"', () => {
    const schema = { name: { type: 'string', required: true } }
    const result = JSON.parse(buildMinimalProbeBody(schema))
    assert.equal(result.name, 'test')
  })

  it('generates number field → 1', () => {
    const schema = { amount: { type: 'number', required: true } }
    const result = JSON.parse(buildMinimalProbeBody(schema))
    assert.equal(result.amount, 1)
  })

  it('generates integer field → 1', () => {
    const schema = { count: { type: 'integer', required: true } }
    const result = JSON.parse(buildMinimalProbeBody(schema))
    assert.equal(result.count, 1)
  })

  it('generates boolean field → true', () => {
    const schema = { active: { type: 'boolean', required: true } }
    const result = JSON.parse(buildMinimalProbeBody(schema))
    assert.equal(result.active, true)
  })

  it('generates generic array field → ["test"]', () => {
    const schema = { items: { type: 'array', required: true } }
    const result = JSON.parse(buildMinimalProbeBody(schema))
    assert.deepEqual(result.items, ['test'])
  })

  it('generates chat-style array for "input" field', () => {
    const schema = { input: { type: 'array', required: true } }
    const result = JSON.parse(buildMinimalProbeBody(schema))
    assert.deepEqual(result.input, [{ role: 'user', content: 'test' }])
  })

  it('generates chat-style array for "messages" field', () => {
    const schema = { messages: { type: 'array', required: true } }
    const result = JSON.parse(buildMinimalProbeBody(schema))
    assert.deepEqual(result.messages, [{ role: 'user', content: 'test' }])
  })

  it('generates object field → {}', () => {
    const schema = { config: { type: 'object', required: true } }
    const result = JSON.parse(buildMinimalProbeBody(schema))
    assert.deepEqual(result.config, {})
  })

  it('generates "test" for unknown type', () => {
    const schema = { mystery: { type: 'custom', required: true } }
    const result = JSON.parse(buildMinimalProbeBody(schema))
    assert.equal(result.mystery, 'test')
  })

  it('only includes required fields in mixed schema', () => {
    const schema = {
      required_field: { type: 'string', required: true },
      optional_field: { type: 'string', required: false },
      no_required_flag: { type: 'number' },
    }
    const result = JSON.parse(buildMinimalProbeBody(schema))
    assert.equal(Object.keys(result).length, 1)
    assert.equal(result.required_field, 'test')
    assert.equal(result.optional_field, undefined)
    assert.equal(result.no_required_flag, undefined)
  })

  it('handles Sats4AI text-generation schema', () => {
    const schema = {
      model: { type: 'string', required: true },
      input: { type: 'array', required: true },
      max_tokens: { type: 'integer', required: false },
    }
    const result = JSON.parse(buildMinimalProbeBody(schema))
    assert.equal(result.model, 'test')
    assert.deepEqual(result.input, [{ role: 'user', content: 'test' }])
    assert.equal(result.max_tokens, undefined)
    assert.equal(Object.keys(result).length, 2)
  })
})

// ─── discoverProbeConfig ────────────────────────────────────────────────────

describe('discoverProbeConfig', () => {
  let originalFetch

  beforeEach(() => {
    originalFetch = global.fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  function mockFetchResponse(status, body) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }
  }

  it('returns { method, probeBody } for matching endpoint', async () => {
    global.fetch = async (url) => {
      return mockFetchResponse(200, {
        services: [
          {
            endpoint: '/v1/chat',
            method: 'POST',
            request_schema: {
              model: { type: 'string', required: true },
              messages: { type: 'array', required: true },
            },
          },
        ],
      })
    }
    const result = await discoverProbeConfig('https://example.com/v1/chat')
    assert.ok(result)
    assert.equal(result.method, 'POST')
    const body = JSON.parse(result.probeBody)
    assert.equal(body.model, 'test')
    assert.deepEqual(body.messages, [{ role: 'user', content: 'test' }])
  })

  it('returns null when endpoint not in discovery document', async () => {
    global.fetch = async () => mockFetchResponse(200, {
      services: [
        { endpoint: '/v1/other', method: 'GET' },
      ],
    })
    const result = await discoverProbeConfig('https://example.com/v1/chat')
    assert.equal(result, null)
  })

  it('returns null when .well-known returns 404', async () => {
    global.fetch = async () => mockFetchResponse(404, null)
    const result = await discoverProbeConfig('https://example.com/v1/chat')
    assert.equal(result, null)
  })

  it('returns null when .well-known returns malformed JSON', async () => {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token') },
    })
    const result = await discoverProbeConfig('https://example.com/v1/chat')
    assert.equal(result, null)
  })

  it('returns null on fetch timeout', async () => {
    global.fetch = async () => {
      const err = new Error('timeout')
      err.name = 'TimeoutError'
      throw err
    }
    const result = await discoverProbeConfig('https://example.com/v1/chat')
    assert.equal(result, null)
  })

  it('returns null for SSRF-blocked URL (private IP)', async () => {
    const result = await discoverProbeConfig('https://127.0.0.1/v1/chat')
    assert.equal(result, null)
  })

  it('returns null for invalid URL', async () => {
    const result = await discoverProbeConfig('not-a-url')
    assert.equal(result, null)
  })

  it('defaults method to GET when not specified in document', async () => {
    global.fetch = async () => mockFetchResponse(200, {
      services: [
        { endpoint: '/v1/data', request_schema: { q: { type: 'string', required: true } } },
      ],
    })
    const result = await discoverProbeConfig('https://example.com/v1/data')
    assert.ok(result)
    assert.equal(result.method, 'GET')
  })

  it('returns {} probeBody when entry has no request_schema', async () => {
    global.fetch = async () => mockFetchResponse(200, {
      services: [
        { endpoint: '/v1/simple', method: 'POST' },
      ],
    })
    const result = await discoverProbeConfig('https://example.com/v1/simple')
    assert.ok(result)
    assert.equal(result.method, 'POST')
    assert.equal(result.probeBody, '{}')
  })

  it('matches endpoint with trailing slash normalization', async () => {
    global.fetch = async () => mockFetchResponse(200, {
      services: [
        { endpoint: '/v1/chat/', method: 'POST', request_schema: { q: { type: 'string', required: true } } },
      ],
    })
    const result = await discoverProbeConfig('https://example.com/v1/chat')
    assert.ok(result)
    assert.equal(result.method, 'POST')
  })

  it('matches endpoint without leading slash in document', async () => {
    global.fetch = async () => mockFetchResponse(200, {
      services: [
        { endpoint: 'v1/chat', method: 'POST' },
      ],
    })
    const result = await discoverProbeConfig('https://example.com/v1/chat')
    assert.ok(result)
    assert.equal(result.method, 'POST')
  })

  it('returns null when doc.services is not an array', async () => {
    global.fetch = async () => mockFetchResponse(200, { services: 'not-array' })
    const result = await discoverProbeConfig('https://example.com/v1/chat')
    assert.equal(result, null)
  })

  it('returns null when doc has no services key', async () => {
    global.fetch = async () => mockFetchResponse(200, { endpoints: [] })
    const result = await discoverProbeConfig('https://example.com/v1/chat')
    assert.equal(result, null)
  })
})
