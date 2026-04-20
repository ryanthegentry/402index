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

  it('migration is idempotent — re-running CREATE TABLE + INDEX does not throw', () => {
    // Actually re-execute the migration SQL (not just re-read pragma)
    assert.doesNotThrow(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS service_embeddings (
          service_id TEXT PRIMARY KEY
            REFERENCES services(id) ON DELETE NO ACTION,
          embedding BLOB NOT NULL,
          model TEXT NOT NULL,
          embedded_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_service_embeddings_embedded_at
          ON service_embeddings(embedded_at);
      `)
    })
    // Verify schema unchanged after re-run
    const cols = db.pragma("table_info('service_embeddings')")
    assert.equal(cols.length, 4)
  })

  it('SQLITE_VEC_AVAILABLE is exported as a boolean', () => {
    assert.equal(typeof SQLITE_VEC_AVAILABLE, 'boolean',
      'SQLITE_VEC_AVAILABLE should be a boolean')
  })

  it('DISABLE_SQLITE_VEC=1 results in SQLITE_VEC_AVAILABLE=false (stdout verified)', () => {
    // Spawn a child process with DISABLE_SQLITE_VEC=1, capture stdout
    const stdout = execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      `
        import { SQLITE_VEC_AVAILABLE } from './src/db.js'
        process.exit(SQLITE_VEC_AVAILABLE === false ? 0 : 1)
      `
    ], {
      cwd: join(__dirname, '..'),
      env: {
        ...process.env,
        DB_PATH: ':memory:',
        DISABLE_SQLITE_VEC: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000
    })
    // Verify stdout contains the diagnostic line
    const out = stdout.toString()
    assert.ok(out.includes('SQLITE_VEC_AVAILABLE=false'),
      `Expected stdout to contain SQLITE_VEC_AVAILABLE=false, got: ${out}`)
  })

  it('FORCE_SQLITE_VEC_FAIL=1 sets SQLITE_VEC_AVAILABLE=false without crashing', () => {
    // FORCE_SQLITE_VEC_FAIL=1 throws inside try block even when sqlite-vec is installed
    const stdout = execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      `
        import { SQLITE_VEC_AVAILABLE } from './src/db.js'
        process.exit(SQLITE_VEC_AVAILABLE === false ? 0 : 1)
      `
    ], {
      cwd: join(__dirname, '..'),
      env: {
        ...process.env,
        DB_PATH: ':memory:',
        DISABLE_SQLITE_VEC: '0',
        FORCE_SQLITE_VEC_FAIL: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000
    })
    const out = stdout.toString()
    assert.ok(out.includes('SQLITE_VEC_AVAILABLE=false'),
      `Expected stdout to contain SQLITE_VEC_AVAILABLE=false, got: ${out}`)
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

  it('vec_version() returns a valid semver when sqlite-vec is available', { skip: !SQLITE_VEC_AVAILABLE && 'sqlite-vec not loaded' }, () => {
    const row = db.prepare('SELECT vec_version() as v').get()
    assert.match(row.v, /^v?\d+\.\d+\.\d+/, `Expected semver, got: ${row.v}`)
  })

  it('FK runtime — DELETE parent with child embedding is rejected', () => {
    const testId = '__fk_test_' + Date.now()
    // Insert a service row
    db.prepare(`
      INSERT INTO services (id, name, url, protocol, source)
      VALUES (?, 'FK Test', 'http://example.com', 'L402', 'test')
    `).run(testId)
    // Insert a child embedding row
    db.prepare(`
      INSERT INTO service_embeddings (service_id, embedding, model, embedded_at)
      VALUES (?, X'00', 'test-model', 1)
    `).run(testId)

    // Deleting the parent must throw FK constraint
    assert.throws(
      () => db.prepare('DELETE FROM services WHERE id = ?').run(testId),
      (err) => err.message.includes('FOREIGN KEY constraint failed'),
      'Expected FK constraint error when deleting parent'
    )

    // Clean up (child first, then parent)
    db.prepare('DELETE FROM service_embeddings WHERE service_id = ?').run(testId)
    db.prepare('DELETE FROM services WHERE id = ?').run(testId)
  })

  it('PRAGMA foreign_keys is enabled', () => {
    const fk = db.pragma('foreign_keys', { simple: true })
    assert.equal(fk, 1, 'foreign_keys pragma should be 1 (ON)')
  })
})
