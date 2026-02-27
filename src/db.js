import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.DB_PATH || join(__dirname, '..', 'data', '402index.db')

mkdirSync(dirname(DB_PATH), { recursive: true })

const db = new Database(DB_PATH)

// Performance pragmas
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

// Create tables
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
    source TEXT NOT NULL CHECK(source IN ('bazaar', 'satring', 'exclusive', 'self-registered')),
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
`)

export default db
