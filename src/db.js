import Database from 'better-sqlite3'
import { mkdirSync, unlinkSync, existsSync, statSync, statfsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { createHash } from 'crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const DB_PATH = process.env.DB_PATH || join(__dirname, '..', 'data', '402index.db')

mkdirSync(dirname(DB_PATH), { recursive: true })

function openDatabase() {
  try {
    return new Database(DB_PATH)
  } catch (err) {
    const msg = err.message || ''
    if (err.code === 'SQLITE_IOERR' || err.code === 'SQLITE_CORRUPT' ||
        msg.includes('SQLITE_IOERR') || msg.includes('SQLITE_CORRUPT') ||
        msg.includes('database disk image is malformed')) {
      console.warn(`[db] Corrupt/unreadable database: ${msg}`)
      console.warn('[db] Deleting and recreating (data rebuilt from polls + YAML)...')
      for (const suffix of ['', '-shm', '-wal']) {
        const f = DB_PATH + suffix
        if (existsSync(f)) unlinkSync(f)
      }
      return new Database(DB_PATH)
    }
    throw err
  }
}

const db = openDatabase()

db.pragma('journal_mode = DELETE')
db.pragma('foreign_keys = ON')
db.pragma('busy_timeout = 5000')

// Enable incremental auto_vacuum to reclaim space after deletes.
// auto_vacuum mode can only be changed on a fresh DB or after a full VACUUM.
const currentAutoVacuum = db.pragma('auto_vacuum', { simple: true })
if (currentAutoVacuum !== 2) { // 2 = INCREMENTAL
  console.log('[db] Converting to auto_vacuum=INCREMENTAL (one-time VACUUM)...')
  db.pragma('auto_vacuum = INCREMENTAL')
  db.exec('VACUUM')
  console.log('[db] VACUUM complete, auto_vacuum=INCREMENTAL enabled')
}

// ─── sqlite-vec extension (optional) ─────────────────────────────────────────
let SQLITE_VEC_AVAILABLE = false
if (process.env.DISABLE_SQLITE_VEC === '1') {
  console.log('[db] sqlite-vec disabled via DISABLE_SQLITE_VEC=1')
} else {
  try {
    if (process.env.FORCE_SQLITE_VEC_FAIL === '1') {
      throw new Error('forced failure via FORCE_SQLITE_VEC_FAIL=1')
    }
    const require = createRequire(import.meta.url)
    const sqliteVec = require('sqlite-vec')
    sqliteVec.load(db)
    SQLITE_VEC_AVAILABLE = true
    console.log('[db] sqlite-vec loaded')
  } catch (err) {
    console.warn(`[db] sqlite-vec unavailable, falling back to pure-JS cosine: ${err.message}`)
  }
}
console.log(`[db] SQLITE_VEC_AVAILABLE=${SQLITE_VEC_AVAILABLE}`)
export { SQLITE_VEC_AVAILABLE }

// ─── health_checks status enum: the single source of truth ───────────────────
//
// Every copy of this enum derives from this array: the CREATE TABLE below, the migration that
// rebuilds an older table, and test/helpers/test-db.js. Three hand-maintained copies is how
// `not_acceptable` — emitted by classifyHealthStatus for HTTP 406 — ended up rejected by the
// CHECK constraint on every write, silently, for ~10 endpoints per cycle.

export const HEALTH_CHECK_STATUSES = [
  'healthy', 'degraded', 'down', 'timeout', 'error', 'rate_limited', 'method_not_allowed', 'not_acceptable',
]

/** health_checks columns, in canonical order. Used for explicit-column copies during rebuilds. */
export const HEALTH_CHECK_COLUMNS = [
  'id', 'service_id', 'checked_at', 'status', 'response_time_ms', 'http_status', 'error_message',
]

const HEALTH_CHECK_RETENTION_DAYS = 3

/**
 * Generate the health_checks DDL from HEALTH_CHECK_STATUSES.
 * @param {string} [tableName='health_checks'] - Target table name (the rebuild uses health_checks_new)
 * @param {object} [options]
 * @param {boolean} [options.ifNotExists=false] - Emit CREATE TABLE IF NOT EXISTS
 * @returns {string} CREATE TABLE statement
 */
export function healthChecksTableDDL(tableName = 'health_checks', { ifNotExists = false } = {}) {
  const allowed = HEALTH_CHECK_STATUSES.map(s => `'${s}'`).join(', ')
  return `CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${tableName} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id TEXT NOT NULL REFERENCES services(id),
    checked_at TEXT NOT NULL DEFAULT (datetime('now')),
    status TEXT NOT NULL CHECK(status IN (${allowed})),
    response_time_ms INTEGER,
    http_status INTEGER,
    error_message TEXT
  )`
}

// ─── counters: durable, never-pruned key/value aggregates ───────────────────
//
// Lives in the DB so it is transactional with the writes it counts, visible from both the server
// process and scripts/healthcheck.js, and survives deploys. No retention is ever applied here.

export const COUNTERS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS counters (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`

export const COUNTER_KEYS = {
  MCP_QUERIES_LIFETIME: 'mcp_queries_lifetime',
  MCP_COUNTER_SEEDED_AT: 'mcp_counter_seeded_at',
  HEALTH_WRITE_FAILURES: 'health_write_failures_lifetime',
  HEALTH_SCHEMA_INVALID: 'health_schema_invalid',
  // Set only when the schema state could not be determined (a lock, most often). Kept apart from
  // HEALTH_SCHEMA_INVALID so a transient failure cannot cry wolf on a healthy schema.
  HEALTH_SCHEMA_PROBE_ERROR: 'health_schema_probe_error',
  LAST_HEALTH_CYCLE: 'last_health_cycle',
}

export function ensureCountersTable(database = db) {
  database.exec(COUNTERS_TABLE_DDL)
}

/** @returns {string|null} raw counter value, or null when unset. */
export function getCounter(key, database = db) {
  try {
    const row = database.prepare('SELECT value FROM counters WHERE key = ?').get(key)
    return row?.value ?? null
  } catch {
    return null
  }
}

/** @returns {number} counter value as a number, 0 when unset or non-numeric. */
export function getCounterInt(key, database = db) {
  const raw = getCounter(key, database)
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : 0
}

export function setCounter(key, value, database = db) {
  try {
    database.prepare(`
      INSERT INTO counters (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value == null ? null : String(value))
  } catch (err) {
    console.error(`[db] counter ${key} write failed: ${err.message}`)
  }
}

/** Remove a single key. This is key management, not retention — counters are never aged out. */
export function deleteCounter(key, database = db) {
  try {
    database.prepare('DELETE FROM counters WHERE key = ?').run(key)
  } catch (err) {
    console.error(`[db] counter ${key} delete failed: ${err.message}`)
  }
}

/** @returns {number|null} the new value, or null if the increment failed. */
export function incrementCounter(key, delta = 1, database = db) {
  try {
    const row = database.prepare(`
      INSERT INTO counters (key, value, updated_at) VALUES (@key, CAST(@delta AS TEXT), datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        value = CAST(CAST(COALESCE(counters.value, '0') AS INTEGER) + @delta AS TEXT),
        updated_at = datetime('now')
      RETURNING value
    `).get({ key, delta })
    return row ? Number(row.value) : null
  } catch (err) {
    console.error(`[db] counter ${key} increment failed: ${err.message}`)
    return null
  }
}

db.exec(COUNTERS_TABLE_DDL)

db.exec(`
  CREATE TABLE IF NOT EXISTS services (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    url TEXT NOT NULL,
    protocol TEXT NOT NULL CHECK(protocol IN ('L402', 'x402', 'both')),
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
    health_status TEXT DEFAULT 'unknown' CHECK(health_status IN ('healthy', 'degraded', 'down', 'unknown')),
    uptime_30d REAL,
    latency_p50_ms INTEGER,
    last_checked TEXT,
    last_seen_healthy TEXT,
    consecutive_failures INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_services_protocol ON services(protocol);
  CREATE INDEX IF NOT EXISTS idx_services_category ON services(category);
  CREATE INDEX IF NOT EXISTS idx_services_source ON services(source);
  CREATE INDEX IF NOT EXISTS idx_services_health ON services(health_status);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_services_url_protocol ON services(url, protocol);

  ${healthChecksTableDDL('health_checks', { ifNotExists: true })};

  CREATE INDEX IF NOT EXISTS idx_health_checks_service ON health_checks(service_id, checked_at);

  CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS webhooks (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    secret TEXT NOT NULL,
    events TEXT NOT NULL DEFAULT 'service.new',
    protocol_filter TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_triggered_at TEXT,
    failure_count INTEGER DEFAULT 0
  );
`)

// Migration: remove CHECK constraint on source to support compound values (e.g. 'satring,l402apps')
const schemaRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='services'").get()
if (schemaRow && schemaRow.sql.includes("source IN (")) {
  console.log('[db] Migrating: removing source CHECK constraint...')
  db.pragma('foreign_keys = OFF')
  db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE services_v2 (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      url TEXT NOT NULL,
      protocol TEXT NOT NULL CHECK(protocol IN ('L402', 'x402', 'both')),
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
      health_status TEXT DEFAULT 'unknown' CHECK(health_status IN ('healthy', 'degraded', 'down', 'unknown')),
      uptime_30d REAL,
      latency_p50_ms INTEGER,
      last_checked TEXT,
      last_seen_healthy TEXT,
      consecutive_failures INTEGER DEFAULT 0
    );
    INSERT INTO services_v2 SELECT * FROM services;
    DROP TABLE services;
    ALTER TABLE services_v2 RENAME TO services;
    CREATE INDEX idx_services_protocol ON services(protocol);
    CREATE INDEX idx_services_category ON services(category);
    CREATE INDEX idx_services_source ON services(source);
    CREATE INDEX idx_services_health ON services(health_status);
    CREATE UNIQUE INDEX idx_services_url_protocol ON services(url, protocol);
    COMMIT;
  `)
  db.pragma('foreign_keys = ON')
  db.pragma('foreign_key_check')
  console.log('[db] Migration complete')
}

// Migration: add classification columns for template/demo detection
for (const col of ['is_template', 'is_demo', 'verified']) {
  try {
    db.exec(`ALTER TABLE services ADD COLUMN ${col} INTEGER DEFAULT 0`)
    console.log(`[db] Added column: ${col}`)
  } catch {
    // Column already exists — expected after first run
  }
}

// Migration: add contact_email for self-registered services
try {
  db.exec('ALTER TABLE services ADD COLUMN contact_email TEXT')
  console.log('[db] Added column: contact_email')
} catch {
  // Column already exists
}

// Migration: add status column for pending approval flow
try {
  db.exec("ALTER TABLE services ADD COLUMN status TEXT DEFAULT 'active'")
  console.log('[db] Added column: status')
} catch {
  // Column already exists
}

// Migration: rename category crypto/bitcoin → bitcoin
try {
  const result = db.prepare("UPDATE services SET category = 'bitcoin' WHERE category = 'crypto/bitcoin'").run()
  if (result.changes > 0) {
    console.log(`[db] Migrated ${result.changes} services from crypto/bitcoin to bitcoin`)
  }
} catch (err) {
  console.warn(`[db] Category migration note: ${err.message}`)
}

// Migration: backfill payment_asset and payment_network based on source/protocol
try {
  const backfills = [
    // Bazaar/x402 → USDC on Base
    ["UPDATE services SET payment_asset = 'USDC' WHERE source = 'bazaar' AND payment_asset IS NULL"],
    ["UPDATE services SET payment_network = 'Base' WHERE source = 'bazaar' AND payment_network IS NULL"],
    // Satring/L402 → BTC on Lightning
    ["UPDATE services SET payment_asset = 'BTC' WHERE source = 'satring' AND payment_asset IS NULL"],
    ["UPDATE services SET payment_network = 'Lightning' WHERE source = 'satring' AND payment_network IS NULL"],
    // L402Apps → BTC on Lightning
    ["UPDATE services SET payment_asset = 'BTC' WHERE source LIKE '%l402apps%' AND payment_asset IS NULL"],
    ["UPDATE services SET payment_network = 'Lightning' WHERE source LIKE '%l402apps%' AND payment_network IS NULL"],
    // Normalize old 'BTC/Lightning' → 'BTC' and 'lightning' → 'Lightning'
    ["UPDATE services SET payment_asset = 'BTC' WHERE payment_asset = 'BTC/Lightning'"],
    ["UPDATE services SET payment_network = 'Lightning' WHERE payment_network = 'lightning'"],
    // Bazaar → normalize CAIP-2 network IDs to friendly names for display
    ["UPDATE services SET payment_network = 'Base' WHERE payment_network = 'eip155:8453'"],
    ["UPDATE services SET payment_network = 'Ethereum' WHERE payment_network = 'eip155:1'"],
    ["UPDATE services SET payment_network = 'Arbitrum' WHERE payment_network = 'eip155:42161'"],
    ["UPDATE services SET payment_network = 'Optimism' WHERE payment_network = 'eip155:10'"],
    ["UPDATE services SET payment_network = 'Polygon' WHERE payment_network = 'eip155:137'"],
    ["UPDATE services SET payment_network = 'Base Sepolia' WHERE payment_network = 'eip155:84532'"],
  ]
  let totalChanges = 0
  for (const [sql] of backfills) {
    const result = db.prepare(sql).run()
    totalChanges += result.changes
  }
  if (totalChanges > 0) {
    console.log(`[db] Backfilled payment_asset/payment_network for ${totalChanges} services`)
  }
} catch (err) {
  console.warn(`[db] Payment backfill note: ${err.message}`)
}

// Migration: add http_method for POST-gated L402 endpoints
try {
  db.exec("ALTER TABLE services ADD COLUMN http_method TEXT DEFAULT 'GET'")
  console.log('[db] Added column: http_method')
} catch {
  // Column already exists
}

// Migration: add probe_body for endpoints that need specific POST body to trigger L402
try {
  db.exec('ALTER TABLE services ADD COLUMN probe_body TEXT')
  console.log('[db] Added column: probe_body')
} catch {
  // Column already exists
}

// Migration: add reliability_score (computed, 0-100)
try {
  db.exec('ALTER TABLE services ADD COLUMN reliability_score REAL')
  console.log('[db] Added column: reliability_score')
} catch {
  // Column already exists
}

// Migration: x402 payment validation columns
for (const col of ['x402_payment_valid', 'x402_facilitator_reachable', 'x402_asset_known']) {
  try {
    db.exec(`ALTER TABLE services ADD COLUMN ${col} INTEGER`)
    console.log(`[db] Added column: ${col}`)
  } catch {
    // Column already exists
  }
}

// Migration: bLIP-0026 + L402 v2 metadata + content domain columns (nullable)
for (const col of ['l402_version', 'agent_spec_url', 'capabilities',
                   'token_format', 'invoice_type', 'pricing_model', 'content_domain']) {
  try {
    db.exec(`ALTER TABLE services ADD COLUMN ${col} TEXT`)
    console.log(`[db] Added column: ${col}`)
  } catch {
    // column already exists — safe to ignore
  }
}

// Migration: remove l402apps homepage listings (not actual L402 endpoints)
const homepageUrls = [
  'https://getalby.com/',
  'https://www.amboss.tech/',
  'https://ganamos.earth/',
  'https://ordinalsbot.com/',
  'https://satring.com/',
  'https://community.sphinx.chat/bounties',
  'https://voltage.cloud/',
  'https://moneydevkit.com/',
  'https://sphinx.chat/',
  'https://www.l402apps.com/lottery',
]
try {
  const deleteHomepageChecks = db.prepare('DELETE FROM health_checks WHERE service_id IN (SELECT id FROM services WHERE url = ?)')
  const deleteHomepage = db.prepare('DELETE FROM services WHERE url = ?')
  let removed = 0
  for (const url of homepageUrls) {
    deleteHomepageChecks.run(url)
    const result = deleteHomepage.run(url)
    removed += result.changes
  }
  if (removed > 0) {
    console.log(`[db] Removed ${removed} homepage listings from l402apps`)
  }
} catch (err) {
  console.warn(`[db] Homepage cleanup note: ${err.message}`)
}

// ─── health_checks status CHECK constraint ──────────────────────────────────

const SCHEMA_PROBE_SERVICE_ID = '__health_schema_probe__'
const SCHEMA_PROBE_URL = 'https://schema-probe.402index.invalid/probe'

/**
 * Insert a real (transaction-scoped) services row so the health_checks FK is genuinely satisfied.
 * Columns are discovered from the live schema: a hard-coded list would break against the several
 * shapes `services` has had, and a fake parent id would fail the FK instead of the CHECK (#304).
 */
function insertSchemaProbeParent(database) {
  const values = {}
  for (const col of database.pragma("table_info('services')")) {
    const required = col.notnull === 1 && col.dflt_value === null
    const isKey = col.name === 'id' || col.name === 'url' || col.name === 'protocol'
    if (!required && !isKey) continue

    if (col.name === 'id') values.id = SCHEMA_PROBE_SERVICE_ID
    else if (col.name === 'url') values.url = SCHEMA_PROBE_URL
    else if (col.name === 'protocol') values.protocol = 'L402'
    else if (/INT|REAL|NUM|DOUB|FLOA/i.test(col.type || '')) values[col.name] = 0
    else values[col.name] = 'schema-probe'
  }
  const names = Object.keys(values)
  database.prepare(
    `INSERT INTO services (${names.join(', ')}) VALUES (${names.map(n => `@${n}`).join(', ')})`
  ).run(values)
}

/**
 * The probe could not reach a verdict — distinct from "the schema rejected a status".
 *
 * Most often a lock: the probe opens a write transaction at import time, so scripts/healthcheck.js
 * booting against a mid-write server process can lose the race. That is not evidence of a broken
 * enum, and flagging it as one would latch a false alarm until the next deploy.
 */
export class SchemaProbeUnavailableError extends Error {
  constructor(message, cause) {
    super(message)
    this.name = 'SchemaProbeUnavailableError'
    this.cause = cause
    this.code = cause?.code ?? null
  }
}

// Lock/contention codes: the probe is worth retrying rather than giving up on.
const RETRYABLE_PROBE_CODES = new Set([
  'SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_BUSY_TIMEOUT',
  'SQLITE_LOCKED', 'SQLITE_LOCKED_SHAREDCACHE', 'SQLITE_PROTOCOL',
])

const PROBE_ATTEMPTS = 3
const PROBE_RETRY_MS = 50

/** better-sqlite3 is synchronous, so the backoff has to be too. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function probeHealthCheckStatusesOnce(database) {
  const rejected = []
  let began = false
  try {
    database.exec('BEGIN')
    began = true
    insertSchemaProbeParent(database)
    const insert = database.prepare('INSERT INTO health_checks (service_id, status) VALUES (?, ?)')
    for (const status of HEALTH_CHECK_STATUSES) {
      try {
        insert.run(SCHEMA_PROBE_SERVICE_ID, status)
      } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_CHECK') rejected.push(status)
        else throw err
      }
    }
  } finally {
    if (began) database.exec('ROLLBACK')
  }
  return rejected
}

/**
 * Which canonical statuses the current health_checks CHECK constraint refuses.
 *
 * Positive insertability probe rather than DDL substring matching: the stored CREATE TABLE text
 * can mention a status without allowing it (a column default, a comment), and only an INSERT
 * proves a write will land. Runs inside BEGIN ... ROLLBACK with a real parent row, so it leaves
 * nothing behind and cannot fail on the services foreign key.
 *
 * Only a CHECK violation is a verdict. Anything else means the probe could not run, is retried
 * while it looks like contention, and finally surfaces as SchemaProbeUnavailableError — never as
 * a rejected status.
 *
 * @returns {string[]} statuses the constraint rejects (empty when the table is current)
 * @throws {SchemaProbeUnavailableError} when the probe could not reach a verdict
 */
export function probeHealthCheckStatuses(database = db, { attempts = PROBE_ATTEMPTS, retryMs = PROBE_RETRY_MS } = {}) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return probeHealthCheckStatusesOnce(database)
    } catch (err) {
      lastError = err
      if (attempt < attempts && RETRYABLE_PROBE_CODES.has(err.code)) {
        sleepSync(retryMs * attempt)
        continue
      }
      break
    }
  }
  throw new SchemaProbeUnavailableError(
    `health_checks status probe could not run: ${lastError?.message ?? 'unknown error'}`,
    lastError
  )
}

/** Bytes currently occupied by health_checks and its index (whole-DB size as a safe upper bound). */
export function estimateHealthChecksBytes(database = db) {
  try {
    const row = database.prepare(
      "SELECT SUM(pgsize) AS bytes FROM dbstat WHERE name IN ('health_checks', 'idx_health_checks_service')"
    ).get()
    if (row?.bytes) return row.bytes
  } catch {
    // dbstat not compiled in — fall back to the whole-file size, which over-estimates (safe).
  }
  const pageCount = database.pragma('page_count', { simple: true }) || 0
  const pageSize = database.pragma('page_size', { simple: true }) || 0
  return pageCount * pageSize
}

/** A table rebuild needs room for a second copy. Refuse to start without it. */
function assertSpaceForRebuild(database, statfsSyncFn, logger) {
  const needed = Math.max(estimateHealthChecksBytes(database) * 2, 1)
  let free
  try {
    const stats = statfsSyncFn(dirname(DB_PATH))
    free = stats.bfree * stats.bsize
  } catch (err) {
    logger.log(`[db] Could not check free space before health_checks rebuild: ${err.message} — continuing`)
    return
  }
  if (free < needed) {
    throw new Error(`insufficient free space for health_checks rebuild: need ${needed} bytes, ${free} free`)
  }
}

/**
 * Rebuild health_checks when its status CHECK constraint refuses a canonical status.
 *
 * Prunes past retention first, refuses to start without room for a second copy, copies with an
 * explicit column list (a positional `SELECT *` silently shuffles values between columns when the
 * old table's column order differs), and verifies foreign keys before committing. Any failure
 * rolls back: the original table stays intact and queryable, and a leftover _new table from a
 * killed run is cleared on the next attempt.
 *
 * @returns {boolean} true if the table was rebuilt, false if it was already current.
 * @throws when the rebuild cannot complete — callers must surface it, never swallow it.
 */
export function migrateHealthChecksStatusConstraint(database = db, { statfsSyncFn = statfsSync, logger = console } = {}) {
  const table = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'health_checks'"
  ).get()
  if (!table) return false

  const missing = probeHealthCheckStatuses(database)
  if (missing.length === 0) return false

  logger.log(`[db] Migrating health_checks status CHECK constraint (rejected: ${missing.join(', ')})...`)

  const pruned = database.prepare(
    "DELETE FROM health_checks WHERE checked_at < datetime('now', ?)"
  ).run(`-${HEALTH_CHECK_RETENTION_DAYS} days`)
  if (pruned.changes > 0) {
    logger.log(`[db] Pruned ${pruned.changes} health checks past retention before rebuild`)
  }

  assertSpaceForRebuild(database, statfsSyncFn, logger)

  const columns = HEALTH_CHECK_COLUMNS.join(', ')
  // FK enforcement must be off for the DROP/RENAME dance, and cannot be toggled inside a
  // transaction — same pattern as the services rebuilds above.
  database.pragma('foreign_keys = OFF')
  try {
    const rebuild = database.transaction(() => {
      database.exec('DROP TABLE IF EXISTS health_checks_new')
      database.exec(healthChecksTableDDL('health_checks_new'))
      database.exec(`INSERT INTO health_checks_new (${columns}) SELECT ${columns} FROM health_checks`)
      database.exec('DROP TABLE health_checks')
      database.exec('ALTER TABLE health_checks_new RENAME TO health_checks')
      database.exec('CREATE INDEX IF NOT EXISTS idx_health_checks_service ON health_checks(service_id, checked_at)')

      const violations = database.pragma('foreign_key_check')
      if (violations.length > 0) {
        throw new Error(`foreign_key_check reported ${violations.length} violation(s) after rebuild`)
      }
    })
    rebuild()
  } finally {
    database.pragma('foreign_keys = ON')
  }

  logger.log('[db] health_checks CHECK constraint updated')
  return true
}

/**
 * Boot-time guard: migrate health_checks if needed, then prove every canonical status is writable.
 *
 * Failure is loud. It sets counters.health_schema_invalid=1 (surfaced by the digest) and logs at
 * error level; the probe re-runs every boot, so a broken schema keeps complaining until it is
 * fixed. The previous console.warn swallow is gone — a silenced schema failure is exactly how
 * ~10 endpoints per cycle lost their status writes unnoticed.
 *
 * health_schema_invalid means one thing only: the probe returned a non-empty rejected list. A
 * probe that could not run gets health_schema_probe_error instead. An alarm that fires on a
 * transient lock is one that gets ignored, which would defeat the point of raising it at all.
 *
 * @returns {{migrated: boolean, valid: boolean, indeterminate: boolean, missing: string[], error?: string}}
 */
export function runHealthChecksSchemaGuard(database = db, { logger = console, statfsSyncFn = statfsSync } = {}) {
  try {
    ensureCountersTable(database)
  } catch (err) {
    logger.error(`[db] counters table unavailable: ${err.message}`)
  }

  let migrated = false
  let migrationError = null
  try {
    migrated = migrateHealthChecksStatusConstraint(database, { statfsSyncFn, logger })
  } catch (err) {
    migrationError = err
    if (err instanceof SchemaProbeUnavailableError) {
      logger.error(`[db] health_checks schema state could not be determined: ${err.message}`)
    } else {
      logger.error(`[db] health_checks status migration FAILED — health writes may be rejected: ${err.message}`)
    }
  }

  let missing
  try {
    missing = probeHealthCheckStatuses(database)
  } catch (err) {
    const detail = migrationError && migrationError !== err
      ? `${err.message} (after migration failure: ${migrationError.message})`
      : err.message
    logger.error(`[db] health_checks schema probe could not run: ${detail}`)
    setCounter(COUNTER_KEYS.HEALTH_SCHEMA_PROBE_ERROR, detail, database)
    return { migrated, valid: false, indeterminate: true, missing: [], error: detail }
  }

  if (missing.length > 0) {
    logger.error(`[db] health_checks CHECK still rejects: ${missing.join(', ')} — those health writes will fail`)
    setCounter(COUNTER_KEYS.HEALTH_SCHEMA_INVALID, '1', database)
    deleteCounter(COUNTER_KEYS.HEALTH_SCHEMA_PROBE_ERROR, database)
    return { migrated, valid: false, indeterminate: false, missing, error: migrationError?.message }
  }

  // Determinately writable: clear both flags, including one left by an earlier locked boot.
  deleteCounter(COUNTER_KEYS.HEALTH_SCHEMA_INVALID, database)
  deleteCounter(COUNTER_KEYS.HEALTH_SCHEMA_PROBE_ERROR, database)
  return { migrated, valid: true, indeterminate: false, missing: [] }
}

runHealthChecksSchemaGuard(db)

// Migration: add domain_verified flag (protects provider edits from poller overwrite)
try {
  db.exec('ALTER TABLE services ADD COLUMN domain_verified INTEGER DEFAULT 0')
  console.log('[db] Added column: domain_verified')
} catch {
  // Column already exists
}

// Migration: add approval_reason for tracking how services were approved
try {
  db.exec('ALTER TABLE services ADD COLUMN approval_reason TEXT')
  console.log('[db] Added column: approval_reason')
} catch {
  // Column already exists
}

// Migration: add provider_deleted flag (soft delete by domain-verified owner)
try {
  db.exec('ALTER TABLE services ADD COLUMN provider_deleted INTEGER DEFAULT 0')
  console.log('[db] Added column: provider_deleted')
} catch {
  // Column already exists
}

// Migration: add deleted_at timestamp for soft-deleted services
try {
  db.exec('ALTER TABLE services ADD COLUMN deleted_at TEXT')
  console.log('[db] Added column: deleted_at')
} catch {
  // Column already exists
}

// Migration: add hostname column for exact-match queries (replaces LIKE on url)
try {
  db.exec('ALTER TABLE services ADD COLUMN hostname TEXT')
  console.log('[db] Added column: hostname')
} catch {
  // Column already exists
}

// Backfill: extract hostname from url for all rows where hostname is NULL
try {
  const hostnameRows = db.prepare('SELECT id, url FROM services WHERE hostname IS NULL').all()
  if (hostnameRows.length > 0) {
    const hostnameUpdate = db.prepare('UPDATE services SET hostname = ? WHERE id = ?')
    const backfillHostnames = db.transaction(() => {
      let count = 0
      for (const row of hostnameRows) {
        try {
          const hostname = new URL(row.url).hostname.toLowerCase()
          hostnameUpdate.run(hostname, row.id)
          count++
        } catch {
          // Malformed URL — skip, hostname stays NULL
        }
      }
      return count
    })
    const filled = backfillHostnames()
    if (filled > 0) {
      console.log(`[db] Backfilled hostname for ${filled} services`)
    }
  }
} catch (err) {
  console.warn(`[db] Hostname backfill note: ${err.message}`)
}

// Index: create index on hostname for fast exact-match lookups
try {
  db.exec('CREATE INDEX IF NOT EXISTS idx_services_hostname ON services(hostname)')
} catch (err) {
  console.warn(`[db] Hostname index note: ${err.message}`)
}

// DEPRECATED: l402_compliant is no longer written by the health checker (since f3d9a1a relaxation).
// Kept for backward-compat reads. Format data lives in l402_format column.
// Payment hash issues tracked via health_status='degraded' + l402_degrade_reason.
// Migration: L402 spec compliance columns
try {
  db.exec('ALTER TABLE services ADD COLUMN l402_compliant INTEGER')
  console.log('[db] Added column: l402_compliant')
} catch {
  // Column already exists
}
try {
  db.exec('ALTER TABLE services ADD COLUMN l402_degrade_reason TEXT')
  console.log('[db] Added column: l402_degrade_reason')
} catch {
  // Column already exists
}

// Migration: l402_format column (format metadata, replaces compliance pass/fail)
try {
  db.exec('ALTER TABLE services ADD COLUMN l402_format TEXT')
  console.log('[db] Added column: l402_format')
} catch {
  // Column already exists
}

// Backfill l402_format from l402_compliant + l402_degrade_reason
try {
  const backfillResult = db.prepare(`
    UPDATE services SET l402_format = CASE
      WHEN l402_compliant = 1 THEN 'v2_tlv'
      WHEN l402_degrade_reason LIKE '%JSON%' OR l402_degrade_reason LIKE '%json%' THEN 'json'
      WHEN l402_degrade_reason LIKE '%v0 text%' OR l402_degrade_reason LIKE '%libmacaroons%' THEN 'v0_text'
      WHEN l402_degrade_reason LIKE '%unrecognized%' THEN 'unknown'
      WHEN l402_compliant = 0 THEN 'unknown'
      ELSE NULL
    END
    WHERE protocol = 'L402' AND l402_format IS NULL AND l402_compliant IS NOT NULL
  `).run()
  if (backfillResult.changes > 0) {
    console.log(`[db] Backfilled l402_format for ${backfillResult.changes} services`)
  }
} catch (e) {
  console.warn('[db] l402_format backfill skipped:', e.message)
}

// Migration: consecutive latency spike counter (buffer before degrading on slow 402s)
try {
  db.exec('ALTER TABLE services ADD COLUMN consecutive_latency_spikes INTEGER DEFAULT 0')
  console.log('[db] Added column: consecutive_latency_spikes')
} catch (e) {
  if (!e.message.includes('duplicate column')) throw e
}

// Migration: lnget interop flag
try {
  db.exec('ALTER TABLE services ADD COLUMN lnget_compatible INTEGER')
  console.log('[db] Added lnget_compatible column')
  // Backfill from l402_format
  db.exec(`
    UPDATE services SET lnget_compatible = CASE
      WHEN protocol != 'L402' THEN NULL
      WHEN l402_format = 'v2_tlv' THEN 1
      WHEN l402_format IS NOT NULL THEN 0
      ELSE NULL
    END
  `)
  console.log('[db] Backfilled lnget_compatible from l402_format')
} catch (e) {
  if (!e.message.includes('duplicate column')) throw e
}

// Migration: expand protocol CHECK constraint to include 'MPP'
try {
  const needsMppMigration = (() => {
    try {
      db.exec("INSERT INTO services (id, name, url, protocol, source) VALUES ('__mpp_test__', 'test', 'https://test.mpp', 'MPP', 'test')")
      db.exec("DELETE FROM services WHERE id = '__mpp_test__'")
      return false
    } catch {
      return true
    }
  })()

  if (needsMppMigration) {
    console.log('[db] Migrating: expanding protocol CHECK to include MPP...')
    const currentSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='services'").get()
    const newSchema = currentSchema.sql.replace(
      /CHECK\(protocol IN \('L402', 'x402', 'both'\)\)/,
      "CHECK(protocol IN ('L402', 'x402', 'both', 'MPP'))"
    )
    // Handle both quoted and unquoted table names in schema SQL
    const tempSchema = newSchema.replace(/CREATE TABLE (?:"services"|services)/i, 'CREATE TABLE services_mpp')
    db.pragma('foreign_keys = OFF')
    db.exec(`
      BEGIN IMMEDIATE;
      ${tempSchema};
      INSERT INTO services_mpp SELECT * FROM services;
      DROP TABLE services;
      ALTER TABLE services_mpp RENAME TO services;
      CREATE INDEX IF NOT EXISTS idx_services_protocol ON services(protocol);
      CREATE INDEX IF NOT EXISTS idx_services_category ON services(category);
      CREATE INDEX IF NOT EXISTS idx_services_source ON services(source);
      CREATE INDEX IF NOT EXISTS idx_services_health ON services(health_status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_services_url_protocol ON services(url, protocol);
      COMMIT;
    `)
    db.pragma('foreign_keys = ON')
    db.pragma('foreign_key_check')
    console.log('[db] Protocol CHECK constraint updated to include MPP')
  }
} catch (err) {
  console.warn(`[db] Protocol migration note: ${err.message}`)
}

// Migration: add probe_status column for unprobeable gateway services (#236)
try {
  db.exec("ALTER TABLE services ADD COLUMN probe_status TEXT DEFAULT 'probeable' CHECK(probe_status IN ('probeable', 'unprobeable'))")
  console.log('[db] Added column: probe_status')
} catch {
  // Column already exists
}

// Reclaim space after bulk deletions
try {
  db.pragma('incremental_vacuum')
} catch (err) {
  console.warn(`[db] Incremental vacuum note: ${err.message}`)
}

// ─── FTS5 Full-Text Search Index (DISABLED — corrupt vtab recovery) ────────
// Dropped during the 2026-04-15 outage and never rebuilt: no code path queries FTS5,
// keyword matching runs through LIKE in src/queries/services.js. This stays as a guard
// against a database that still carries the old objects.
//
// It used to log unconditionally, so `[db] Dropped FTS5 index and triggers` appeared on
// every boot long after there was anything left to drop — which read like a recurring
// fault during the 2026-07-25 search investigation. Log only when it actually removes
// something.
try {
  const ftsObjects = db.prepare(
    "SELECT COUNT(*) AS c FROM sqlite_master WHERE name IN ('services_fts', 'services_fts_insert', 'services_fts_update', 'services_fts_delete')"
  ).get().c
  if (ftsObjects > 0) {
    db.exec('DROP TRIGGER IF EXISTS services_fts_insert')
    db.exec('DROP TRIGGER IF EXISTS services_fts_update')
    db.exec('DROP TRIGGER IF EXISTS services_fts_delete')
    db.exec('DROP TABLE IF EXISTS services_fts')
    console.log(`[db] Dropped ${ftsObjects} leftover FTS5 object(s) (recovery mode)`)
  }
} catch (err) {
  console.warn(`[db] FTS5 cleanup note: ${err.message}`)
}

// ─── Service Embeddings (semantic search foundation, #136) ───────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS service_embeddings (
    service_id TEXT PRIMARY KEY
      REFERENCES services(id) ON DELETE NO ACTION,
    embedding BLOB NOT NULL,
    model TEXT NOT NULL,
    -- embedded_at is epoch SECONDS (INTEGER), NOT ISO datetime TEXT.
    -- Intentional break from the services-table TEXT convention: enables
    -- fast range comparisons and compact storage for hot-path ranking queries.
    embedded_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_service_embeddings_embedded_at
    ON service_embeddings(embedded_at);
`)

// ─── Vector KNN index ────────────────────────────────────────────────────────
// service_embeddings holds the authoritative float32 BLOBs. vec_service_embeddings
// is the sqlite-vec index the search path actually queries.
//
// Until 2026-07-25 this table was created only inside test/queries-hybrid.test.js.
// Production never had it, so every semantic search threw `no such table`, the bare
// catch in queries/services.js relabelled that as `vec-deadline`, and 100% of q=
// searches silently fell back to LIKE-only. The tests passed because the fixture
// built the table the application never did.
//
// Two things are deliberately NOT done here, per the 2026-04-15 FTS5 outage:
//   * no triggers on services or service_embeddings, and
//   * no backfill at startup.
// That outage came from a startup backfill interleaving with concurrent poller
// writes through sync triggers, which corrupted the FTS5 shadow tables. vec0 has
// shadow tables too, so the same shape is off-limits. Creating the virtual table
// is DDL only — it moves no rows — and the index is kept current by explicit calls
// from the single embedding write path. Existing rows are loaded once, out of band,
// by scripts/backfill-vec-index.mjs.

export const VEC_DIMENSIONS = 1536

export function ensureVecIndex(database = db) {
  if (!SQLITE_VEC_AVAILABLE) return false
  try {
    database.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS vec_service_embeddings USING vec0(service_id text primary key, embedding float[${VEC_DIMENSIONS}])`
    )
    return true
  } catch (err) {
    console.warn(`[db] vec index unavailable: ${err.message}`)
    return false
  }
}

// vec0 rejects INSERT OR REPLACE with a UNIQUE constraint error, so the upsert is
// delete-then-insert inside a transaction.
export function syncVecEmbedding(serviceId, blob, database = db) {
  if (!SQLITE_VEC_AVAILABLE) return false
  try {
    const del = database.prepare('DELETE FROM vec_service_embeddings WHERE service_id = ?')
    const ins = database.prepare('INSERT INTO vec_service_embeddings(service_id, embedding) VALUES (?, ?)')
    database.transaction(() => { del.run(serviceId); ins.run(serviceId, blob) })()
    return true
  } catch (err) {
    console.warn(`[db] syncVecEmbedding failed for ${serviceId}: ${err.message}`)
    return false
  }
}

export function deleteVecEmbedding(serviceId, database = db) {
  if (!SQLITE_VEC_AVAILABLE) return false
  try {
    database.prepare('DELETE FROM vec_service_embeddings WHERE service_id = ?').run(serviceId)
    return true
  } catch (err) {
    console.warn(`[db] deleteVecEmbedding failed for ${serviceId}: ${err.message}`)
    return false
  }
}

/**
 * Whether this specific handle has the vec index. SQLITE_VEC_AVAILABLE only says the
 * extension loaded — an injected database (tests, scripts) can lack the table, and an
 * unguarded DELETE against it would roll back the transaction it sits in.
 */
export function hasVecIndex(database = db) {
  if (!SQLITE_VEC_AVAILABLE) return false
  try {
    return database.prepare(
      "SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'vec_service_embeddings'"
    ).get().c > 0
  } catch {
    return false
  }
}

/** Row counts for the embedding store and its index. Used by /health and the backfill. */
export function getVecIndexStats(database = db) {
  const stats = { available: SQLITE_VEC_AVAILABLE, embeddings: 0, indexed: 0 }
  try {
    stats.embeddings = database.prepare('SELECT COUNT(*) AS c FROM service_embeddings').get().c
    if (hasVecIndex(database)) {
      stats.indexed = database.prepare('SELECT COUNT(*) AS c FROM vec_service_embeddings').get().c
    }
  } catch (err) {
    console.warn(`[db] getVecIndexStats failed: ${err.message}`)
  }
  return stats
}

ensureVecIndex()

// ─── Daily Snapshots ────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS daily_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_date TEXT NOT NULL UNIQUE,
    total_endpoints INTEGER,
    verified_endpoints INTEGER,
    total_providers INTEGER,
    verified_providers INTEGER,
    healthy_endpoints INTEGER,
    degraded_endpoints INTEGER,
    down_endpoints INTEGER,
    l402_endpoints INTEGER,
    l402_verified INTEGER,
    l402_healthy INTEGER,
    l402_providers INTEGER,
    x402_endpoints INTEGER,
    x402_verified INTEGER,
    x402_healthy INTEGER,
    x402_providers INTEGER,
    mpp_endpoints INTEGER,
    mpp_verified INTEGER,
    mpp_healthy INTEGER,
    mpp_providers INTEGER,
    avg_reliability_score REAL,
    median_latency_ms INTEGER,
    p90_latency_ms INTEGER,
    categories_json TEXT,
    top_providers_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_daily_snapshots_date ON daily_snapshots(snapshot_date);
`)

// ─── Domain Claims ──────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS domain_claims (
    id TEXT PRIMARY KEY,
    domain TEXT NOT NULL UNIQUE,
    verification_token TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending', 'verified', 'expired')),
    claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
    verified_at TEXT,
    expires_at TEXT NOT NULL,
    last_check_at TEXT,
    contact_email TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_claims_domain ON domain_claims(domain);
  CREATE INDEX IF NOT EXISTS idx_domain_claims_status ON domain_claims(status);
`)

// Migration: expand domain_claims status CHECK to include 'revoked'
try {
  const needsMigration = (() => {
    try {
      db.exec("INSERT INTO domain_claims (id, domain, verification_token, status, expires_at) VALUES ('__dc_test__', '__dc_test__', 'x', 'revoked', datetime('now'))")
      db.exec("DELETE FROM domain_claims WHERE id = '__dc_test__'")
      return false
    } catch {
      return true
    }
  })()

  if (needsMigration) {
    console.log('[db] Migrating domain_claims: expanding status CHECK to include revoked...')
    db.exec(`
      CREATE TABLE domain_claims_new (
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL UNIQUE,
        verification_token TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'verified', 'expired', 'revoked')),
        claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
        verified_at TEXT,
        expires_at TEXT NOT NULL,
        last_check_at TEXT,
        contact_email TEXT
      );
      INSERT INTO domain_claims_new SELECT * FROM domain_claims;
      DROP TABLE domain_claims;
      ALTER TABLE domain_claims_new RENAME TO domain_claims;
      CREATE UNIQUE INDEX idx_domain_claims_domain ON domain_claims(domain);
      CREATE INDEX idx_domain_claims_status ON domain_claims(status);
    `)
    console.log('[db] domain_claims CHECK constraint updated')
  }
} catch (err) {
  console.warn(`[db] domain_claims migration note: ${err.message}`)
}

// Migration: add token_hashed column to domain_claims (new rows default to 1)
try {
  db.exec('ALTER TABLE domain_claims ADD COLUMN token_hashed INTEGER NOT NULL DEFAULT 1')
  // Existing rows get DEFAULT 1, but pre-migration rows actually have raw tokens.
  // Set all existing rows to 0 so the hash migration picks them up.
  db.exec('UPDATE domain_claims SET token_hashed = 0')
  console.log('[db] Added column: domain_claims.token_hashed')
} catch {
  // Column already exists — expected on subsequent boots
}

/**
 * Migrate unhashed verification tokens to SHA-256 hashes.
 * Idempotent: only processes rows where token_hashed = 0.
 * Each row is updated atomically (hash + flag in one statement).
 */
export function migrateTokenHashes() {
  const rows = db.prepare('SELECT id, verification_token FROM domain_claims WHERE token_hashed = 0').all()
  if (rows.length === 0) return

  const update = db.prepare('UPDATE domain_claims SET verification_token = ?, token_hashed = 1 WHERE id = ?')
  const migrate = db.transaction(() => {
    for (const row of rows) {
      const hashed = createHash('sha256').update(row.verification_token).digest('hex')
      update.run(hashed, row.id)
    }
  })
  migrate()
  console.log(`[db] Migrated ${rows.length} domain_claims token(s) to SHA-256 hashes`)
}

// Run migration on boot
migrateTokenHashes()

// ─── Protocol Changes (detected during health checks) ───────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS protocol_changes (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    hostname TEXT NOT NULL,
    service_id TEXT NOT NULL,
    registered_protocol TEXT NOT NULL,
    detected_protocol TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('addition', 'removal')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'dismissed')),
    detection_count INTEGER NOT NULL DEFAULT 1,
    first_detected_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_detected_at TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_at TEXT,
    created_service_id TEXT,
    contact_email TEXT,
    UNIQUE(url, detected_protocol, type)
  );
  CREATE INDEX IF NOT EXISTS idx_protocol_changes_status ON protocol_changes(status);
`)

// ─── Registration Attempts (failed probe logs) ─────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS registration_attempts (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    protocol TEXT NOT NULL,
    name TEXT,
    provider TEXT,
    contact_email TEXT,
    http_method TEXT,
    probe_body TEXT,
    attempted_at TEXT NOT NULL DEFAULT (datetime('now')),
    failure_reason TEXT NOT NULL,
    probe_http_status INTEGER,
    probe_error TEXT,
    suggested_protocol TEXT,
    ip_address TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_reg_attempts_date ON registration_attempts(attempted_at);
`)

// ─── Query Log ──────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS query_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    query_text TEXT,
    filters TEXT,
    result_count INTEGER,
    response_time_ms INTEGER,
    user_agent TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_query_log_timestamp ON query_log(timestamp);
`)

// Migration: add degraded_reason column for hybrid search degradation tracking
try {
  db.exec('ALTER TABLE query_log ADD COLUMN degraded_reason TEXT')
  console.log('[db] Added column: query_log.degraded_reason')
} catch {
  // Column already exists
}

const logQueryStmt = db.prepare(
  'INSERT INTO query_log (query_text, filters, result_count, response_time_ms, user_agent, degraded_reason) VALUES (@queryText, @filters, @resultCount, @responseTimeMs, @userAgent, @degradedReason)'
)

/** query_log retention. The 90d window fields are named for it; the lifetime counter outlives it. */
export const MCP_QUERY_LOG_RETENTION_DAYS = 90

const MCP_USER_AGENT_MARKER = '402index-mcp'

/**
 * The SQL half of the MCP predicate, shared by every window query.
 *
 * User-Agent is fully client-controlled, and the two halves used to disagree: JS `includes` is
 * case-sensitive while SQL `LIKE` is case-insensitive for ASCII, so `402Index-MCP` landed in
 * mcp_queries_90d but never in mcp_queries_lifetime — two fields in one payload counting the same
 * events by different rules. Both halves now lowercase. Interpolates a module constant only.
 */
export const MCP_USER_AGENT_SQL = `instr(lower(user_agent), '${MCP_USER_AGENT_MARKER}') > 0`

export function isMcpUserAgent(userAgent) {
  return typeof userAgent === 'string' && userAgent.toLowerCase().includes(MCP_USER_AGENT_MARKER)
}

// Throws on failure (unlike incrementCounter) so the enclosing transaction rolls back: the
// query row and the lifetime counter move together or not at all.
const bumpMcpLifetimeStmt = db.prepare(`
  INSERT INTO counters (key, value, updated_at) VALUES (@key, '1', datetime('now'))
  ON CONFLICT(key) DO UPDATE SET
    value = CAST(CAST(COALESCE(counters.value, '0') AS INTEGER) + 1 AS TEXT),
    updated_at = datetime('now')
`)

const logQueryTxn = db.transaction(params => {
  logQueryStmt.run(params)
  if (isMcpUserAgent(params.userAgent)) {
    bumpMcpLifetimeStmt.run({ key: COUNTER_KEYS.MCP_QUERIES_LIFETIME })
  }
})

export function logQuery({ queryText = null, filters = null, resultCount = null, responseTimeMs = null, userAgent = null, degradedReason = null } = {}) {
  try {
    logQueryTxn({ queryText, filters, resultCount, responseTimeMs, userAgent, degradedReason })
  } catch (err) {
    console.warn(`[db] logQuery failed: ${err.message}`)
  }
}

/**
 * MCP traffic inside the query_log retention window. These are window aggregates, not totals —
 * naming them so is the point: reporting them as lifetime counts is what made the digest's MCP
 * numbers drop whenever the oldest day rolled out.
 *
 * @returns {{queries: number, activeDays: number}}
 */
export function mcpQueryWindowStats(database = db, retentionDays = MCP_QUERY_LOG_RETENTION_DAYS) {
  try {
    const row = database.prepare(`
      SELECT COUNT(*) AS queries, COUNT(DISTINCT date(timestamp)) AS activeDays
      FROM query_log
      WHERE ${MCP_USER_AGENT_SQL}
        AND timestamp > datetime('now', '-' || @days || ' days')
    `).get({ days: retentionDays })
    return { queries: row?.queries ?? 0, activeDays: row?.activeDays ?? 0 }
  } catch (err) {
    console.warn(`[db] mcpQueryWindowStats failed: ${err.message}`)
    return { queries: 0, activeDays: 0 }
  }
}

/**
 * Seed the lifetime MCP counter once, from the current window count — the honest floor. Pre-window
 * history was deleted by prune and is unrecoverable (daily_snapshots carries no MCP columns), so no
 * reconstruction is attempted; the seed timestamp is exposed in the digest to mark the discontinuity.
 *
 * @returns {boolean} true if this call seeded, false if it was already seeded.
 */
export function seedMcpLifetimeCounter(database = db, retentionDays = MCP_QUERY_LOG_RETENTION_DAYS) {
  ensureCountersTable(database)
  if (getCounter(COUNTER_KEYS.MCP_COUNTER_SEEDED_AT, database)) return false

  const { queries } = mcpQueryWindowStats(database, retentionDays)
  setCounter(COUNTER_KEYS.MCP_QUERIES_LIFETIME, String(queries), database)
  setCounter(COUNTER_KEYS.MCP_COUNTER_SEEDED_AT, new Date().toISOString(), database)
  console.log(`[db] Seeded ${COUNTER_KEYS.MCP_QUERIES_LIFETIME} from the ${retentionDays}-day window: ${queries}`)
  return true
}

seedMcpLifetimeCounter(db)

export function pruneQueryLog(retentionDays = MCP_QUERY_LOG_RETENTION_DAYS) {
  try {
    const result = db.prepare(
      "DELETE FROM query_log WHERE timestamp < datetime('now', '-' || ? || ' days')"
    ).run(retentionDays)
    if (result.changes > 0) {
      console.log(`[db] Pruned ${result.changes} query log entries older than ${retentionDays} days`)
      db.pragma('incremental_vacuum')
    }
  } catch (err) {
    console.warn(`[db] Query log prune failed: ${err.message}`)
  }
}

// ─── Pruning ────────────────────────────────────────────────────────────────

// Prune health_checks older than 3 days (aligned with HEALTH_CHECK_RETENTION_DAYS in checker.js)
function pruneHealthChecks() {
  try {
    const result = db.prepare(
      "DELETE FROM health_checks WHERE checked_at < datetime('now', '-3 days')"
    ).run()
    if (result.changes > 0) {
      console.log(`[db] Pruned ${result.changes} health checks older than 3 days`)
      db.pragma('incremental_vacuum')
    }
  } catch (err) {
    console.warn(`[db] Prune failed: ${err.message}`)
  }
}

/**
 * Hard-delete services soft-deleted more than `retentionDays` ago.
 *
 * health_checks and service_embeddings both reference services(id) with no ON DELETE CASCADE,
 * so the child rows must go first or the whole statement fails on a FOREIGN KEY constraint and
 * nothing is ever purged. Runs in one transaction so a failure leaves no orphaned children.
 *
 * @returns {number} count of services hard-deleted.
 */
export function purgeSoftDeleted(database = db, retentionDays = 30) {
  const cutoff = `-${retentionDays} days`
  try {
    const purge = database.transaction(() => {
      const doomed = database.prepare(
        "SELECT id FROM services WHERE provider_deleted = 1 AND deleted_at < datetime('now', ?)"
      ).all(cutoff).map(r => r.id)
      if (doomed.length === 0) return 0

      const placeholders = doomed.map(() => '?').join(', ')
      database.prepare(`DELETE FROM health_checks WHERE service_id IN (${placeholders})`).run(...doomed)
      database.prepare(`DELETE FROM service_embeddings WHERE service_id IN (${placeholders})`).run(...doomed)
      // vec_service_embeddings is a virtual table and cannot carry a foreign key, so
      // its rows would otherwise outlive the services they describe and keep scoring
      // in KNN results. Same id list, same transaction as the blob store.
      if (hasVecIndex(database)) {
        database.prepare(`DELETE FROM vec_service_embeddings WHERE service_id IN (${placeholders})`).run(...doomed)
      }
      database.prepare(`DELETE FROM services WHERE id IN (${placeholders})`).run(...doomed)
      return doomed.length
    })

    const removed = purge()
    if (removed > 0) {
      console.log(`[db] Hard-deleted ${removed} soft-deleted services older than ${retentionDays} days`)
      database.pragma('incremental_vacuum')
    }
    return removed
  } catch (err) {
    console.warn(`[db] Soft-delete purge failed: ${err.message}`)
    return 0
  }
}

function pruneRegistrationAttempts() {
  try {
    const result = db.prepare(
      "DELETE FROM registration_attempts WHERE attempted_at < datetime('now', '-7 days')"
    ).run()
    if (result.changes > 0) {
      console.log(`[db] Pruned ${result.changes} registration attempts older than 7 days`)
      db.pragma('incremental_vacuum')
    }
  } catch (err) {
    console.warn(`[db] Registration attempts prune failed: ${err.message}`)
  }
}

function pruneAll() {
  pruneHealthChecks()
  pruneQueryLog()
  purgeSoftDeleted()
  pruneRegistrationAttempts()
}

pruneAll()
setInterval(pruneAll, 60 * 60 * 1000).unref()

// Disk usage diagnostics
try {
  const dbSize = statSync(DB_PATH).size
  const walSize = existsSync(DB_PATH + '-wal') ? statSync(DB_PATH + '-wal').size : 0
  const shmSize = existsSync(DB_PATH + '-shm') ? statSync(DB_PATH + '-shm').size : 0
  const journalSize = existsSync(DB_PATH + '-journal') ? statSync(DB_PATH + '-journal').size : 0
  const healthCount = db.prepare('SELECT COUNT(*) as c FROM health_checks').get().c
  const serviceCount = db.prepare('SELECT COUNT(*) as c FROM services').get().c
  const pageCount = db.pragma('page_count', { simple: true })
  const pageSize = db.pragma('page_size', { simple: true })
  console.log(`[db] Disk usage: db=${(dbSize / 1024 / 1024).toFixed(1)}MB, wal=${(walSize / 1024 / 1024).toFixed(1)}MB, shm=${(shmSize / 1024 / 1024).toFixed(1)}MB, journal=${(journalSize / 1024 / 1024).toFixed(1)}MB`)
  console.log(`[db] Rows: ${serviceCount} services, ${healthCount} health_checks`)
  console.log(`[db] Pages: ${pageCount} x ${pageSize}B = ${(pageCount * pageSize / 1024 / 1024).toFixed(1)}MB`)
} catch (err) {
  console.warn(`[db] Disk diagnostics failed: ${err.message}`)
}

// Graceful shutdown
process.on('SIGTERM', () => { db.close(); process.exit(0) })
process.on('SIGINT', () => { db.close(); process.exit(0) })

export default db
