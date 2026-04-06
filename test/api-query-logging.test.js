/**
 * Integration tests for query logging on GET /api/v1/services
 *
 * These tests require a running server: npm run dev or npm start
 * Run: node --test test/api-query-logging.test.js
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer, stopServer } from './helpers/server.js'

let BASE = process.env.API_BASE
let API

before(async () => { BASE = BASE || await startServer(); API = `${BASE}/api/v1` })
after(async () => { await stopServer() })

// Helper: query the services endpoint and return parsed response
async function queryServices(params = '') {
  const res = await fetch(`${API}/services${params ? '?' + params : ''}`)
  return {
    status: res.status,
    body: await res.json(),
  }
}

// We can't read the query_log table directly via API (no endpoint yet),
// so these tests verify that query logging doesn't break the API contract.
// The actual log entries are verified in test/query-log.test.js at the unit level.

describe('GET /api/v1/services — query logging integration', () => {
  it('response shape is unchanged with logging enabled', async () => {
    const r = await queryServices()
    assert.equal(r.status, 200)
    assert.ok(Array.isArray(r.body.services), 'services should be array')
    assert.equal(typeof r.body.total, 'number')
    assert.equal(typeof r.body.limit, 'number')
    assert.equal(typeof r.body.offset, 'number')
  })

  it('filtered query still returns correct response', async () => {
    const r = await queryServices('q=test&protocol=L402&category=ai')
    assert.equal(r.status, 200)
    assert.ok(Array.isArray(r.body.services))
    assert.equal(typeof r.body.total, 'number')
  })

  it('empty params query returns normal response', async () => {
    const r = await queryServices()
    assert.equal(r.status, 200)
    assert.ok(r.body.services.length >= 0)
  })

  it('response time is not significantly degraded by logging', async () => {
    // Warm up
    await queryServices()

    const times = []
    for (let i = 0; i < 5; i++) {
      const start = Date.now()
      await queryServices()
      times.push(Date.now() - start)
    }

    const avg = times.reduce((a, b) => a + b, 0) / times.length
    // Logging overhead should be negligible — total response under 500ms
    assert.ok(avg < 500, `Average response time ${avg}ms should be under 500ms`)
  })

  it('query with all filter params returns 200', async () => {
    const params = 'q=api&protocol=L402&category=ai&health=healthy&source=bazaar&featured=true&max_price_usd=100&sort=price&order=asc'
    const r = await queryServices(params)
    assert.equal(r.status, 200)
    assert.ok(Array.isArray(r.body.services))
  })
})
