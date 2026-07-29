import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// The router's own SQLite state: nonce single-use, spend ledger, degraded candidates.
// Separate file from the 402index catalog DB, which the router only reads.
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
  return db;
}
