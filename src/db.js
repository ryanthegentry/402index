import Database from 'better-sqlite3'
import { mkdirSync, unlinkSync, existsSync, statSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

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

  CREATE TABLE IF NOT EXISTS health_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id TEXT NOT NULL REFERENCES services(id),
    checked_at TEXT NOT NULL DEFAULT (datetime('now')),
    status TEXT NOT NULL CHECK(status IN ('healthy', 'degraded', 'down', 'timeout', 'error')),
    response_time_ms INTEGER,
    http_status INTEGER,
    error_message TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_health_checks_service ON health_checks(service_id, checked_at);

  CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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

// Reclaim space after bulk deletions
try {
  db.pragma('incremental_vacuum')
} catch (err) {
  console.warn(`[db] Incremental vacuum note: ${err.message}`)
}

// Prune health_checks older than 1 day (startup + every hour)
function pruneHealthChecks() {
  try {
    const result = db.prepare(
      "DELETE FROM health_checks WHERE checked_at < datetime('now', '-1 day')"
    ).run()
    if (result.changes > 0) {
      console.log(`[db] Pruned ${result.changes} health checks older than 1 day`)
      db.pragma('incremental_vacuum')
    }
  } catch (err) {
    console.warn(`[db] Prune failed: ${err.message}`)
  }
}

pruneHealthChecks()
setInterval(pruneHealthChecks, 60 * 60 * 1000).unref()

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
