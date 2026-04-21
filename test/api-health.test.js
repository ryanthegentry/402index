import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'

let startServer, stopServer, API

describe('Group H — health endpoint embedding fields (#161)', () => {
  before(async () => {
    process.env.NODE_ENV = 'test'
    process.env.OPENAI_API_KEY = 'test-key-fake'

    const srv = await import('./helpers/server.js')
    startServer = srv.startServer
    stopServer = srv.stopServer
    API = await startServer()
  })

  after(async () => {
    await stopServer()
  })

  it('H1: GET /api/v1/health includes embedding_half_open_trial as a boolean', async () => {
    const res = await fetch(`${API}/api/v1/health`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.ok(
      'embedding_half_open_trial' in body,
      `health response should include embedding_half_open_trial field, got keys: ${Object.keys(body).join(', ')}`,
    )
    assert.equal(
      typeof body.embedding_half_open_trial, 'boolean',
      `embedding_half_open_trial should be a boolean, got: ${typeof body.embedding_half_open_trial}`,
    )
  })
})
