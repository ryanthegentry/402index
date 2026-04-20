/**
 * Worker script for the two-process concurrent writer stress test.
 * Spawned by test/embeddings-concurrent.test.js via child_process.fork().
 *
 * Expects:
 *   process.env.TEST_DB_PATH — path to the shared on-disk SQLite file
 *   process.env.WORKER_ID — '0' or '1'
 *   process.env.OPENAI_API_KEY — set to 'stub' (fetch is patched below)
 *
 * Protocol:
 *   Sends { type: 'done', inserted: N, maxBusyWaitMs: M, rssGrowthMb: R } on success.
 *   Sends { type: 'error', message: '...' } on failure.
 */

import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

const DB_PATH = process.env.TEST_DB_PATH
const WORKER_ID = process.env.WORKER_ID || '0'
const COUNT = 500

// Track unhandled rejections
let unhandledRejections = 0
process.on('unhandledRejection', (err) => {
  unhandledRejections++
  console.error(`[worker-${WORKER_ID}] unhandledRejection:`, err)
})

// Stub globalThis.fetch — resolves instantly with a fake 1536-float response
const fakeEmbedding = new Array(1536).fill(0).map((_, i) => Math.sin(i) * 0.01)
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    data: [{ embedding: fakeEmbedding }],
    model: 'text-embedding-3-small',
    usage: { prompt_tokens: 5, total_tokens: 5 },
  }),
})

const baselineRss = process.memoryUsage().rss

try {
  const db = new Database(DB_PATH)
  db.pragma('journal_mode = DELETE')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')

  // Track max busy wait via timing around each write
  let maxBusyWaitMs = 0

  const upsert = db.prepare(`
    INSERT INTO services (id, name, description, url, protocol, category, source, hostname, registered_at, updated_at)
    VALUES (@id, @name, @description, @url, @protocol, @category, @source, @hostname, datetime('now'), datetime('now'))
    ON CONFLICT(url, protocol) DO UPDATE SET
      name = excluded.name,
      updated_at = datetime('now')
    RETURNING *
  `)

  let inserted = 0
  for (let i = 0; i < COUNT; i++) {
    const id = randomUUID()
    const params = {
      id,
      name: `Worker${WORKER_ID} Service ${i}`,
      description: `Test service ${i} from worker ${WORKER_ID}`,
      url: `https://worker${WORKER_ID}-${i}-${id.slice(0, 8)}.test.example.com/api`,
      protocol: 'x402',
      category: 'test',
      source: 'concurrent-test',
      hostname: `worker${WORKER_ID}-${i}.test.example.com`,
    }

    const start = performance.now()
    const row = upsert.get(params)
    const elapsed = performance.now() - start

    if (elapsed > maxBusyWaitMs) maxBusyWaitMs = elapsed

    if (row) inserted++

    // Fire embedding hook (non-blocking) — import dynamically
    if (row && row.registered_at === row.updated_at) {
      // Dynamically import embeddings module
      // The module should be available since OPENAI_API_KEY is set
      import('../src/services/embeddings.js').then(m => {
        setImmediate(() => m.generateEmbedding(row.id).catch(() => {}))
      }).catch(() => {})
    }
  }

  // Wait a moment for any pending embeddings to settle
  await new Promise(r => setTimeout(r, 500))

  const rssGrowthMb = (process.memoryUsage().rss - baselineRss) / (1024 * 1024)

  db.close()

  process.send({
    type: 'done',
    inserted,
    maxBusyWaitMs: Math.round(maxBusyWaitMs),
    rssGrowthMb: Math.round(rssGrowthMb * 10) / 10,
    unhandledRejections,
  })
} catch (err) {
  process.send({ type: 'error', message: err.message })
}
