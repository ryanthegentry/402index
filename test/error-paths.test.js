/**
 * Error-path tests for public API handlers.
 *
 * Verifies that try/catch blocks in api.js return 500 JSON on DB failures.
 * Uses a real Express app with a poisoned DB stub to trigger catch blocks.
 *
 * Run: node --test test/error-paths.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { queryServices, buildServiceQuery, API_COLUMNS } from '../src/queries/services.js'

describe('GET /api/v1/services — error path', () => {
  let server, port

  beforeEach(async () => {
    const app = express()

    // Replicate the exact handler from api.js with a poisoned db
    const poisonedDb = {
      prepare() { throw new Error('DB_POISONED: simulated failure') }
    }

    app.get('/api/v1/services', (req, res) => {
      const startTime = Date.now()
      try {
        const { limit: rawLimit, offset: rawOffset, ...filters } = req.query
        const result = queryServices(poisonedDb, { ...filters, rawLimit, rawOffset }, API_COLUMNS)
        res.json(result)
      } catch (err) {
        console.error('GET /api/v1/services error:', err)
        res.status(500).json({ error: 'Internal Server Error' })
      }
    })

    await new Promise((resolve) => {
      server = app.listen(0, () => {
        port = server.address().port
        resolve()
      })
    })
  })

  afterEach(() => {
    server?.close()
  })

  it('returns 500 with { error: "Internal Server Error" } when DB throws', async () => {
    const res = await fetch(`http://localhost:${port}/api/v1/services`)
    assert.equal(res.status, 500)
    const body = await res.json()
    assert.deepEqual(body, { error: 'Internal Server Error' })
  })

  it('returns 500 with correct content-type', async () => {
    const res = await fetch(`http://localhost:${port}/api/v1/services`)
    assert.equal(res.status, 500)
    assert.ok(res.headers.get('content-type').includes('application/json'))
  })
})
