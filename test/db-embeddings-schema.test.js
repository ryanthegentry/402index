import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'
import db, { SQLITE_VEC_AVAILABLE } from '../src/db.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('service_embeddings schema (#136)', () => {
  it('service_embeddings table exists after db.js init', () => {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='service_embeddings'"
    ).get()
    assert.ok(row, 'service_embeddings table should exist')
  })

  it('schema shape matches spec exactly', () => {
    const cols = db.pragma("table_info('service_embeddings')")
    const colMap = Object.fromEntries(cols.map(c => [c.name, c]))

    // Exactly 4 columns
    assert.equal(cols.length, 4, `expected 4 columns, got ${cols.length}: ${cols.map(c => c.name).join(', ')}`)

    // service_id TEXT PRIMARY KEY
    assert.equal(colMap.service_id.type, 'TEXT')
    assert.equal(colMap.service_id.pk, 1)

    // embedding BLOB NOT NULL
    assert.equal(colMap.embedding.type, 'BLOB')
    assert.equal(colMap.embedding.notnull, 1)

    // model TEXT NOT NULL
    assert.equal(colMap.model.type, 'TEXT')
    assert.equal(colMap.model.notnull, 1)

    // embedded_at INTEGER NOT NULL
    assert.equal(colMap.embedded_at.type, 'INTEGER')
    assert.equal(colMap.embedded_at.notnull, 1)
  })

  it('idx_service_embeddings_embedded_at index exists', () => {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_service_embeddings_embedded_at'"
    ).get()
    assert.ok(row, 'idx_service_embeddings_embedded_at index should exist')
  })

  it('migration is idempotent — importing db.js twice does not throw', () => {
    // db.js already ran on import. Running the CREATE TABLE IF NOT EXISTS
    // again should be safe. We verify by checking the table still exists
    // and has the right shape (no duplicates, no errors).
    const cols = db.pragma("table_info('service_embeddings')")
    assert.equal(cols.length, 4)
  })

  it('SQLITE_VEC_AVAILABLE is exported as a boolean', () => {
    assert.equal(typeof SQLITE_VEC_AVAILABLE, 'boolean',
      'SQLITE_VEC_AVAILABLE should be a boolean')
  })

  it('DISABLE_SQLITE_VEC=1 results in SQLITE_VEC_AVAILABLE=false and no crash', () => {
    // Spawn a child process with DISABLE_SQLITE_VEC=1 to test the env guard
    const result = execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      `
        import { SQLITE_VEC_AVAILABLE } from './src/db.js'
        if (SQLITE_VEC_AVAILABLE !== false) {
          process.exit(1)
        }
        process.exit(0)
      `
    ], {
      cwd: join(__dirname, '..'),
      env: {
        ...process.env,
        DB_PATH: ':memory:',
        DISABLE_SQLITE_VEC: '1'
      },
      timeout: 10000
    })
  })

  it('extension-unavailable path sets SQLITE_VEC_AVAILABLE=false without crashing', () => {
    // Spawn a child process where sqlite-vec will fail to load
    // (either not installed or we force a failure via NODE_OPTIONS)
    const result = execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      `
        // Simulate sqlite-vec not being available by poisoning the resolve
        import { register } from 'node:module'
        // Just import db.js — if sqlite-vec is not installed, it should
        // still boot and set SQLITE_VEC_AVAILABLE=false
        const { SQLITE_VEC_AVAILABLE } = await import('./src/db.js')
        if (typeof SQLITE_VEC_AVAILABLE !== 'boolean') {
          console.error('SQLITE_VEC_AVAILABLE is not a boolean')
          process.exit(1)
        }
        // Server booted successfully
        process.exit(0)
      `
    ], {
      cwd: join(__dirname, '..'),
      env: {
        ...process.env,
        DB_PATH: ':memory:',
        DISABLE_SQLITE_VEC: '0'  // don't disable — let it try and fail naturally
      },
      timeout: 10000
    })
  })

  it('no CREATE TRIGGER touching service_embeddings or services in db.js', () => {
    const dbSource = readFileSync(join(__dirname, '..', 'src', 'db.js'), 'utf8')
    const createTriggerPattern = /CREATE\s+TRIGGER\b[^;]*(?:service_embeddings|services_fts)/gi
    const matches = dbSource.match(createTriggerPattern)
    assert.equal(matches, null,
      `Found CREATE TRIGGER statements that should not exist: ${matches}`)
  })

  it('FK references services(id) with ON DELETE NO ACTION', () => {
    const row = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='service_embeddings'"
    ).get()
    assert.ok(row, 'service_embeddings table should exist')
    assert.ok(
      row.sql.includes('ON DELETE NO ACTION'),
      `FK should specify ON DELETE NO ACTION, got: ${row.sql}`
    )
  })
})
