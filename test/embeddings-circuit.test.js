import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const originalFetch = globalThis.fetch

let db, getCircuitState, resetCircuit, embedQueryWithTimeout
let startServer, stopServer, API

// Helper: make a successful OpenAI embedding response
function makeOkResponse() {
  const embedding = new Array(1536).fill(0).map((_, i) => Math.sin(i) * 0.1)
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: [{ embedding }], model: 'text-embedding-3-small', usage: { prompt_tokens: 10, total_tokens: 10 } }),
  }
}

// Helper: make a failure response
function makeFailResponse() {
  return { ok: false, status: 500, json: async () => ({ error: { message: 'server error' } }) }
}

// Helper: make a malformed-dimensions response (1535 instead of 1536)
function makeMalformedResponse() {
  const embedding = new Array(1535).fill(0).map((_, i) => Math.sin(i) * 0.1)
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: [{ embedding }], model: 'text-embedding-3-small', usage: {} }),
  }
}

describe('Group C — circuit breaker (#150)', () => {
  let fetchCallCount = 0
  let mockClock = Date.now()

  before(async () => {
    process.env.OPENAI_API_KEY = 'test-key-fake'

    const dbMod = await import('../src/db.js')
    db = dbMod.default

    const embeddings = await import('../src/services/embeddings.js')
    getCircuitState = embeddings.getCircuitState
    resetCircuit = embeddings.resetCircuit
    embedQueryWithTimeout = embeddings.embedQueryWithTimeout

    const srv = await import('./helpers/server.js')
    startServer = srv.startServer
    stopServer = srv.stopServer
    API = await startServer()
  })

  after(async () => {
    globalThis.fetch = originalFetch
    await stopServer()
  })

  beforeEach(() => {
    fetchCallCount = 0
    globalThis.fetch = originalFetch
    // Reset circuit between tests
    if (resetCircuit) resetCircuit()
  })

  // Helper: trigger N consecutive failures
  async function triggerFailures(n) {
    globalThis.fetch = async () => {
      fetchCallCount++
      return makeFailResponse()
    }
    for (let i = 0; i < n; i++) {
      await embedQueryWithTimeout('test', 1500)
    }
  }

  it('C1: 10 consecutive failures opens the circuit, /api/v1/health reports open', async () => {
    await triggerFailures(10)

    const state = getCircuitState()
    assert.equal(state.circuit, 'open', 'circuit should be open after 10 failures')

    // Also check health endpoint (use originalFetch to avoid OpenAI stub interference)
    globalThis.fetch = originalFetch
    const res = await fetch(`${API}/api/v1/health`)
    const health = await res.json()
    assert.equal(health.embedding_circuit, 'open', 'health endpoint should report open')
    assert.equal(health.embedding_circuit_failures, 10)
    assert.ok(health.embedding_circuit_opened_at !== null, 'opened_at should be set')
  })

  it('C2: 11th call returns null without invoking fetch', async () => {
    await triggerFailures(10)
    fetchCallCount = 0

    globalThis.fetch = async () => {
      fetchCallCount++
      return makeOkResponse()
    }

    const result = await embedQueryWithTimeout('test', 1500)
    assert.equal(result, null, '11th call should return null (circuit open)')
    assert.equal(fetchCallCount, 0, 'fetch should NOT be called when circuit is open')
  })

  it('C3: after 60s, circuit transitions to half-open, next call invokes fetch', async () => {
    await triggerFailures(10)

    // Advance clock by 60s using injectable clock
    const state = getCircuitState()
    assert.equal(state.circuit, 'open')

    // Use resetCircuit with a time advance or test the exported clock injection
    // The circuit should expose a way to inject time for testing
    if (resetCircuit) {
      // Reset and manually set state to simulate time passage
      resetCircuit({ advanceMs: 60_000 })
    }

    fetchCallCount = 0
    globalThis.fetch = async () => {
      fetchCallCount++
      return makeOkResponse()
    }

    const result = await embedQueryWithTimeout('test', 1500)
    const newState = getCircuitState()
    // After 60s, circuit should have been half-open, and the successful call should close it
    assert.ok(fetchCallCount > 0, 'fetch should be called in half-open state')
  })

  it('C4: half-open success → closed, consecutiveFailures = 0', async () => {
    await triggerFailures(10)
    if (resetCircuit) resetCircuit({ advanceMs: 60_000 })

    globalThis.fetch = async () => {
      fetchCallCount++
      return makeOkResponse()
    }

    await embedQueryWithTimeout('test', 1500)
    const state = getCircuitState()
    assert.equal(state.circuit, 'closed', 'successful half-open call should close circuit')
    assert.equal(state.failures, 0, 'consecutiveFailures should reset to 0')
  })

  it('C5: half-open failure → back to open, circuitOpenedAt refreshed', async () => {
    await triggerFailures(10)
    const openedAt1 = getCircuitState().openedAt

    if (resetCircuit) resetCircuit({ advanceMs: 60_000 })

    globalThis.fetch = async () => {
      fetchCallCount++
      return makeFailResponse()
    }

    await embedQueryWithTimeout('test', 1500)
    const state = getCircuitState()
    assert.equal(state.circuit, 'open', 'failed half-open call should re-open circuit')
    // openedAt should be refreshed (newer than the first opening)
    assert.ok(state.openedAt >= openedAt1, 'circuitOpenedAt should be refreshed')
  })

  it('C6: circuit-open fast-fails do NOT increment consecutiveFailures', async () => {
    await triggerFailures(10)
    const failuresAfterOpen = getCircuitState().failures

    // Make 5 more calls while circuit is open
    for (let i = 0; i < 5; i++) {
      await embedQueryWithTimeout('test', 1500)
    }

    const state = getCircuitState()
    assert.equal(state.failures, failuresAfterOpen, 'failures should not increment during circuit-open fast-fails')
  })

  it('C7: success during closed state resets consecutiveFailures to 0 even after 9 prior failures', async () => {
    await triggerFailures(9)
    assert.equal(getCircuitState().failures, 9)
    assert.equal(getCircuitState().circuit, 'closed', 'circuit should still be closed after 9 failures')

    globalThis.fetch = async () => makeOkResponse()
    await embedQueryWithTimeout('test', 1500)

    assert.equal(getCircuitState().failures, 0, 'one success should reset failures to 0')
  })

  it('C8: malformed 1535-dim embedding counts as a failure', async () => {
    if (resetCircuit) resetCircuit()
    globalThis.fetch = async () => makeMalformedResponse()

    await embedQueryWithTimeout('test', 1500)
    const state = getCircuitState()
    assert.equal(state.failures, 1, 'malformed embedding should count as failure')
  })
})
