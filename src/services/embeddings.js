import db from '../db.js'

const OPENAI_API_KEY = process.env.OPENAI_API_KEY
const EMBEDDINGS_ENABLED = Boolean(OPENAI_API_KEY)
export const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings'
const MODEL = 'text-embedding-3-small'
const DIMENSIONS = 1536
const TIMEOUT_MS = 10000
const MAX_CONCURRENT = 20
const MAX_PENDING = 500

if (!EMBEDDINGS_ENABLED) {
  console.log('[embeddings] disabled — OPENAI_API_KEY not set')
} else {
  console.log('[embeddings] enabled')
}

// ─── Semaphore ────────────────────────────────────────────────────────────────
let inflight = 0
const pending = []

function acquireSlot() {
  if (inflight < MAX_CONCURRENT) {
    inflight++
    return Promise.resolve()
  }
  if (pending.length >= MAX_PENDING) {
    return null // signal: drop this request
  }
  return new Promise(resolve => pending.push(resolve))
}

function releaseSlot() {
  if (pending.length > 0) {
    const next = pending.shift()
    next() // transfer slot to next waiter
  } else {
    inflight--
  }
}

// ─── Prepared statements ──────────────────────────────────────────────────────
const getService = db.prepare('SELECT id, name, description, category FROM services WHERE id = ?')
const upsertEmbedding = db.prepare(`
  INSERT INTO service_embeddings (service_id, embedding, model, embedded_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(service_id) DO UPDATE SET
    embedding = excluded.embedding,
    model = excluded.model,
    embedded_at = excluded.embedded_at
`)

// ─── Composition helper ──────────────────────────────────────────────────────

/**
 * Compose the embedding input text from a service row.
 * Shared between generateEmbedding() and the backfill script.
 */
export function composeEmbeddingInput(service) {
  return `${service.name}\n${service.description ?? ''}\n${service.category ?? ''}`
}

// ─── Core functions ───────────────────────────────────────────────────────────

/**
 * Call OpenAI embeddings API via raw fetch.
 * Returns Float32Array(1536) on success, null on any failure.
 */
async function callOpenAI(text) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch(OPENAI_EMBEDDINGS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model: MODEL, input: text }),
      signal: controller.signal,
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      console.warn(`[embeddings] OpenAI ${res.status}: ${body?.error?.message || 'unknown error'}`)
      return null
    }

    const body = await res.json()
    const values = body.data?.[0]?.embedding
    if (!values || values.length !== DIMENSIONS) {
      console.warn('[embeddings] unexpected response shape from OpenAI')
      return null
    }

    return new Float32Array(values)
  } catch (err) {
    console.warn(`[embeddings] fetch error: ${err.message}`)
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Generate and store embedding for a service.
 * Never throws. No-op if embeddings disabled or service not found.
 */
export async function generateEmbedding(serviceId) {
  if (!EMBEDDINGS_ENABLED) return

  const slot = acquireSlot()
  if (slot === null) {
    console.log(`[embeddings] queue full (${MAX_PENDING}), dropping serviceId=${serviceId}`)
    return
  }
  await slot

  try {
    const service = getService.get(serviceId)
    if (!service) {
      console.warn(`[embeddings] service not found: ${serviceId}`)
      return
    }

    const inputText = composeEmbeddingInput(service)
    const embedding = await callOpenAI(inputText)
    if (!embedding) return

    const blob = Buffer.from(embedding.buffer)
    const embeddedAt = Math.floor(Date.now() / 1000)

    upsertEmbedding.run(serviceId, blob, MODEL, embeddedAt)
  } catch (err) {
    console.warn(`[embeddings] generateEmbedding error for ${serviceId}: ${err.message}`)
  } finally {
    releaseSlot()
  }
}

/**
 * Embed an arbitrary query string. Returns Float32Array(1536) or null.
 * Never throws.
 */
export async function embedQuery(text) {
  if (!process.env.OPENAI_API_KEY) return null

  try {
    return await callOpenAI(text)
  } catch (err) {
    console.warn(`[embeddings] embedQuery error: ${err.message}`)
    return null
  }
}

// ─── Circuit Breaker ─────────────────────────────────────────────────────────
let consecutiveFailures = 0
let circuitOpenedAt = null
let halfOpenTrialInFlight = false
const CIRCUIT_OPEN_THRESHOLD = 10
const CIRCUIT_OPEN_DURATION_MS = 60_000

// Injectable clock for deterministic testing
let _now = () => Date.now()

function recordSuccess() {
  consecutiveFailures = 0
  circuitOpenedAt = null // close circuit if half-open
}

function recordFailure() {
  consecutiveFailures++
  if (consecutiveFailures >= CIRCUIT_OPEN_THRESHOLD) {
    circuitOpenedAt = _now()
    if (consecutiveFailures === CIRCUIT_OPEN_THRESHOLD) {
      console.warn(`[embeddings] circuit OPEN after ${consecutiveFailures} consecutive failures`)
    }
  }
}

/**
 * Get current circuit state. Exposed for /api/v1/health and tests.
 */
export function getCircuitState() {
  const now = _now()
  let circuit = 'closed'
  if (circuitOpenedAt !== null) {
    circuit = (now - circuitOpenedAt < CIRCUIT_OPEN_DURATION_MS) ? 'open' : 'half-open'
  }
  return {
    circuit,
    failures: consecutiveFailures,
    openedAt: circuitOpenedAt,
  }
}

/**
 * Reset circuit state. For testing only.
 * Accepts { advanceMs } to simulate time passage without actually waiting.
 */
export function resetCircuit(opts = {}) {
  if (process.env.NODE_ENV !== 'test') throw new Error('resetCircuit is test-only')
  if (opts.advanceMs && circuitOpenedAt !== null) {
    // Simulate time passage by backdating the openedAt
    circuitOpenedAt = _now() - opts.advanceMs
  } else {
    consecutiveFailures = 0
    circuitOpenedAt = null
  }
  halfOpenTrialInFlight = false
}

/**
 * Embed a query for the read path. Returns { embedding, degradedReason }.
 * degradedReason is null on success, or one of the reason codes on failure.
 * Never throws, never returns 5xx.
 */
export async function embedQueryForRead(text, timeoutMs = 1500) {
  if (!process.env.OPENAI_API_KEY) {
    return { embedding: null, degradedReason: 'no-api-key' }
  }

  // Circuit breaker check
  const state = getCircuitState()
  if (state.circuit === 'open') {
    return { embedding: null, degradedReason: 'circuit-open' }
  }

  // Half-open: admit exactly one trial call; others fast-fail
  if (state.circuit === 'half-open') {
    if (halfOpenTrialInFlight) {
      return { embedding: null, degradedReason: 'circuit-open' }
    }
    halfOpenTrialInFlight = true
  }

  let timer
  try {
    const result = await Promise.race([
      callOpenAI(text),
      new Promise(resolve => { timer = setTimeout(() => resolve('__timeout__'), timeoutMs) }),
    ])
    clearTimeout(timer)

    if (result === '__timeout__') {
      recordFailure()
      return { embedding: null, degradedReason: 'embed-timeout' }
    }

    if (result === null || (result instanceof Float32Array && result.length !== DIMENSIONS)) {
      recordFailure()
      return { embedding: null, degradedReason: 'embed-error' }
    }

    recordSuccess()
    return { embedding: result, degradedReason: null }
  } catch (err) {
    clearTimeout(timer)
    console.warn(`[embeddings] embedQueryForRead error: ${err.message}`)
    recordFailure()
    return { embedding: null, degradedReason: 'embed-error' }
  } finally {
    if (state.circuit === 'half-open') halfOpenTrialInFlight = false
  }
}

/**
 * Pure-JS cosine similarity. Returns 0 for zero-magnitude vectors.
 * Throws on length mismatch (indicates caller bug).
 */
export function cosineSimilarity(a, b) {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`)
  }

  let dot = 0, magA = 0, magB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    magA += a[i] * a[i]
    magB += b[i] * b[i]
  }

  const denom = Math.sqrt(magA) * Math.sqrt(magB)
  if (denom === 0) return 0

  return dot / denom
}

/**
 * Current pending queue depth. Exposed via /api/v1/health.
 */
export function getQueueDepth() {
  return pending.length
}
