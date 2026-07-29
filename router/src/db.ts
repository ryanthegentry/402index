import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// The router's own SQLite state: nonce single-use, spend ledger, degraded candidates.
// Separate file from the 402index catalog DB, which the router only reads.

// The loss-ledger columns, added idempotently over any existing spend_ledger.
// `sats` stays the wallet-outflow column the spend cap sums; everything else
// is bookkeeping.
const LEDGER_COLUMNS: [string, string][] = [
  ['service_id', 'TEXT'],
  ['rail', 'TEXT'],
  ['network', 'TEXT'],
  ['route', 'TEXT'],
  ['adapter', 'TEXT'],
  ['quoted_sats', 'INTEGER'],
  ['settled_sats', 'INTEGER'],
  ['fee_sats', 'INTEGER'],
  ['charged_usd', 'REAL'],
  ['btc_usd', 'REAL'],
  ['payment_intent', 'TEXT'],
  ['job_nonce', 'TEXT'],
  ['delivered', 'INTEGER'],
  ['loss_sats', 'INTEGER NOT NULL DEFAULT 0'],
  ['failure_reason', 'TEXT'],
  ['latency_ms', 'INTEGER'],
  ['stage_timings', 'TEXT'],
  ['settled_at', 'TEXT'],
  ['resolved_at', 'TEXT']
];

function migrateSpendLedger(db: Database.Database): void {
  const existing = new Set(
    (db.prepare('PRAGMA table_info(spend_ledger)').all() as { name: string }[]).map((c) => c.name)
  );
  for (const [name, type] of LEDGER_COLUMNS) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE spend_ledger ADD COLUMN ${name} ${type}`);
    }
  }
}

export function openRouterDb(dataDir: string): Database.Database {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'router.db'));
  db.pragma('journal_mode = DELETE');
  db.exec(`
    CREATE TABLE IF NOT EXISTS state_nonces (
      nonce TEXT PRIMARY KEY,
      used_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS spend_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sats INTEGER NOT NULL,
      upstream TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS degraded_candidates (
      service_id TEXT PRIMARY KEY,
      reason TEXT,
      degraded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS cards (
      principal TEXT PRIMARY KEY,
      payment_method TEXT NOT NULL,
      registered_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS pending_jobs (
      nonce TEXT PRIMARY KEY,
      invoice TEXT NOT NULL,
      token TEXT NOT NULL,
      wrapped_url TEXT NOT NULL,
      http_method TEXT NOT NULL,
      body TEXT,
      candidates_considered INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  migrateSpendLedger(db);
  return db;
}
