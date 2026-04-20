import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Test l: Two-process concurrent writer stress test.
 *
 * Spawns two Node processes that each insert 500 services into the SAME
 * on-disk SQLite file using journal_mode=DELETE (matching prod).
 * Verifies no data loss, no excessive lock waits, no unhandled rejections,
 * and bounded RSS growth.
 */
describe('embeddings concurrent writer stress test (#138)', () => {
  it('l. two-process concurrent writes: 1000 rows, no lock > 500ms, no rejections, RSS < 50MB', async (t) => {
    // Use a real on-disk SQLite file (NOT :memory:, NOT WAL)
    const tmpDir = mkdtempSync(join(tmpdir(), 'emb-concurrent-'))
    const dbPath = join(tmpDir, 'test-concurrent.db')

    // Initialize the database with the required schema
    const setupDb = new Database(dbPath)
    setupDb.pragma('journal_mode = DELETE')
    setupDb.pragma('foreign_keys = ON')

    setupDb.exec(`
      CREATE TABLE services (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        url TEXT NOT NULL,
        protocol TEXT NOT NULL CHECK(protocol IN ('L402', 'x402', 'both', 'MPP')),
        price_sats INTEGER,
        price_usd REAL,
        payment_asset TEXT,
        payment_network TEXT,
        category TEXT,
        input_schema TEXT,
        output_schema TEXT,
        provider TEXT,
        source TEXT NOT NULL,
        source_id TEXT,
        featured INTEGER DEFAULT 0,
        registered_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        health_status TEXT DEFAULT 'unknown',
        uptime_30d REAL,
        latency_p50_ms INTEGER,
        last_checked TEXT,
        last_seen_healthy TEXT,
        consecutive_failures INTEGER DEFAULT 0,
        is_template INTEGER DEFAULT 0,
        is_demo INTEGER DEFAULT 0,
        verified INTEGER DEFAULT 0,
        contact_email TEXT,
        status TEXT DEFAULT 'active',
        http_method TEXT DEFAULT 'GET',
        probe_body TEXT,
        reliability_score REAL,
        hostname TEXT
      );
      CREATE UNIQUE INDEX idx_services_url_protocol ON services(url, protocol);

      CREATE TABLE service_embeddings (
        service_id TEXT PRIMARY KEY
          REFERENCES services(id) ON DELETE NO ACTION,
        embedding BLOB NOT NULL,
        model TEXT NOT NULL,
        embedded_at INTEGER NOT NULL
      );
      CREATE INDEX idx_service_embeddings_embedded_at
        ON service_embeddings(embedded_at);
    `)
    setupDb.close()

    // Spawn two worker processes
    const workerPath = join(__dirname, 'helpers', 'concurrent-writer-worker.js')
    const env = {
      ...process.env,
      TEST_DB_PATH: dbPath,
      OPENAI_API_KEY: 'stub-key',
      DB_PATH: dbPath,
    }

    function spawnWorker(workerId) {
      return new Promise((resolve, reject) => {
        const child = fork(workerPath, [], {
          env: { ...env, WORKER_ID: String(workerId) },
          stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        })

        let result = null
        child.on('message', (msg) => { result = msg })
        child.on('exit', (code) => {
          if (result && result.type === 'done') resolve(result)
          else if (result && result.type === 'error') reject(new Error(result.message))
          else reject(new Error(`Worker ${workerId} exited with code ${code} without sending result`))
        })
        child.on('error', reject)

        // Timeout: 60 seconds
        setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error(`Worker ${workerId} timed out after 60s`))
        }, 60000)
      })
    }

    // Run both workers concurrently
    const [result0, result1] = await Promise.all([
      spawnWorker(0),
      spawnWorker(1),
    ])

    // Verify results
    const verifyDb = new Database(dbPath, { readonly: true })

    // Assert 1000 rows in services (no loss from lock contention)
    const totalRows = verifyDb.prepare('SELECT COUNT(*) as c FROM services').get().c
    assert.equal(totalRows, 1000, `expected 1000 rows, got ${totalRows}`)

    // Assert each worker inserted 500
    assert.equal(result0.inserted, 500, `worker 0 inserted ${result0.inserted}, expected 500`)
    assert.equal(result1.inserted, 500, `worker 1 inserted ${result1.inserted}, expected 500`)

    // Assert no lock wait exceeded 500ms
    assert.ok(result0.maxBusyWaitMs < 500, `worker 0 max busy wait ${result0.maxBusyWaitMs}ms exceeded 500ms`)
    assert.ok(result1.maxBusyWaitMs < 500, `worker 1 max busy wait ${result1.maxBusyWaitMs}ms exceeded 500ms`)

    // Assert no unhandled promise rejections
    assert.equal(result0.unhandledRejections, 0, `worker 0 had ${result0.unhandledRejections} unhandled rejections`)
    assert.equal(result1.unhandledRejections, 0, `worker 1 had ${result1.unhandledRejections} unhandled rejections`)

    // Assert RSS growth < 50 MB
    assert.ok(result0.rssGrowthMb < 50, `worker 0 RSS grew ${result0.rssGrowthMb}MB, limit 50MB`)
    assert.ok(result1.rssGrowthMb < 50, `worker 1 RSS grew ${result1.rssGrowthMb}MB, limit 50MB`)

    verifyDb.close()

    // Cleanup
    try { rmSync(tmpDir, { recursive: true }) } catch {}
  }, { timeout: 60000 })
})
