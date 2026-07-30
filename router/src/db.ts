import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// The router's own SQLite state: nonce single-use, spend ledger, degraded candidates.
// Separate file from the 402index catalog DB, which the router only reads.

// The loss-ledger columns, added idempotently over any existing spend_ledger.
// `sats` stays the wallet-outflow column the spend cap sums; everything else
// is bookkeeping.
const LEDGER_COLUMNS: [string, string][] = [
  ['principal', 'TEXT'],
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

// pending_jobs grew route/rail material in the multirail build; same
// idempotent treatment. `token` holds the credential (macaroon or token) and
// `invoice` holds the raw payment material — names kept for continuity.
const PENDING_JOB_COLUMNS: [string, string][] = [
  ['route', 'TEXT'],
  ['rail', 'TEXT'],
  ['network', 'TEXT'],
  ['btc_usd', 'REAL'],
  ['stage_timings', 'TEXT']
];

// Degradation moved from a service-keyed to a (service_id, route)-keyed table
// (D5): failures are per endpoint AND per route, and one shared row blinded
// the router to a working direct route. SQLite cannot alter a primary key, so
// v1 tables are rebuilt; v1 rows become route='*' — they blocked every route
// before, and they keep doing exactly that.
function migrateDegradedCandidates(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(degraded_candidates)').all() as { name: string }[];
  if (cols.length === 0 || cols.some((c) => c.name === 'route')) return;
  db.exec(`
    ALTER TABLE degraded_candidates RENAME TO degraded_candidates_v1;
    CREATE TABLE degraded_candidates (
      service_id TEXT NOT NULL,
      route TEXT NOT NULL DEFAULT '*',
      reason TEXT,
      degraded_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (service_id, route)
    );
    INSERT INTO degraded_candidates (service_id, route, reason, degraded_at)
      SELECT service_id, '*', reason, degraded_at FROM degraded_candidates_v1;
    DROP TABLE degraded_candidates_v1;
  `);
}

// A saved PaymentMethod is only chargeable later when attached to a Stripe
// Customer, and the PaymentIntent must name that Customer — learned live on
// the first hosted walkthrough. The customer id lives beside the card.
function migrateCards(db: Database.Database): void {
  const existing = new Set(
    (db.prepare('PRAGMA table_info(cards)').all() as { name: string }[]).map((c) => c.name)
  );
  if (!existing.has('customer')) {
    db.exec('ALTER TABLE cards ADD COLUMN customer TEXT');
  }
}

function migratePendingJobs(db: Database.Database): void {
  const existing = new Set(
    (db.prepare('PRAGMA table_info(pending_jobs)').all() as { name: string }[]).map((c) => c.name)
  );
  for (const [name, type] of PENDING_JOB_COLUMNS) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE pending_jobs ADD COLUMN ${name} ${type}`);
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
      service_id TEXT NOT NULL,
      route TEXT NOT NULL DEFAULT '*',
      reason TEXT,
      degraded_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (service_id, route)
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
    CREATE TABLE IF NOT EXISTS paid_credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ledger_id INTEGER,
      service_id TEXT,
      upstream TEXT NOT NULL,
      route TEXT NOT NULL,
      redeem_url TEXT NOT NULL,
      http_method TEXT NOT NULL,
      body TEXT,
      credential TEXT NOT NULL,
      proof TEXT NOT NULL,
      settled_sats INTEGER NOT NULL,
      redeemed INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      paid_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_attempt_at TEXT,
      redeemed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS tokens (
      token_hash TEXT PRIMARY KEY,
      principal TEXT NOT NULL,
      max_sats_per_job INTEGER,
      max_total_sats INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS mandates (
      principal TEXT PRIMARY KEY,
      budget_usd REAL NOT NULL,
      spent_usd REAL NOT NULL DEFAULT 0,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  migrateSpendLedger(db);
  migratePendingJobs(db);
  migrateDegradedCandidates(db);
  migrateCards(db);
  return db;
}
