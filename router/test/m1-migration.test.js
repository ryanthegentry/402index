import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { openRouterDb } from '../dist/db.js';

// The ledger migration must upgrade a database created by the OLD schema
// in place, preserving existing rows, and must be idempotent.

function oldSchemaDb(dir) {
  const db = new Database(join(dir, 'router.db'));
  db.exec(`
    CREATE TABLE spend_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sats INTEGER NOT NULL,
      upstream TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare('INSERT INTO spend_ledger (sats, upstream) VALUES (?, ?)').run(403, 'https://llm402.ai/x');
  db.prepare('INSERT INTO spend_ledger (sats, upstream) VALUES (?, ?)').run(581, 'https://lightningfaucet.com/y');
  db.close();
}

const NEW_COLUMNS = [
  'service_id', 'rail', 'network', 'route', 'adapter',
  'quoted_sats', 'settled_sats', 'fee_sats', 'charged_usd', 'btc_usd',
  'payment_intent', 'job_nonce', 'delivered', 'loss_sats', 'failure_reason',
  'latency_ms', 'stage_timings', 'settled_at', 'resolved_at'
];

test('M1a: openRouterDb migrates an old-schema spend_ledger in place, rows intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mig-test-'));
  oldSchemaDb(dir);
  const db = openRouterDb(dir);
  const cols = db.prepare("PRAGMA table_info(spend_ledger)").all().map((c) => c.name);
  for (const col of NEW_COLUMNS) {
    assert.ok(cols.includes(col), `missing column ${col} in ${JSON.stringify(cols)}`);
  }
  const rows = db.prepare('SELECT sats, upstream, loss_sats FROM spend_ledger ORDER BY id').all();
  assert.equal(rows.length, 2, 'old rows preserved');
  assert.equal(rows[0].sats, 403);
  assert.equal(rows[0].loss_sats, 0, 'loss_sats defaults to 0 on migrated rows');
  db.close();
});

test('M1b: the migration is idempotent — reopening changes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mig-test-'));
  oldSchemaDb(dir);
  openRouterDb(dir).close();
  const db = openRouterDb(dir); // second run over already-migrated schema
  const cols = db.prepare("PRAGMA table_info(spend_ledger)").all().map((c) => c.name);
  const dupes = cols.filter((c, i) => cols.indexOf(c) !== i);
  assert.deepEqual(dupes, [], 'no duplicated columns');
  for (const col of NEW_COLUMNS) assert.ok(cols.includes(col), `missing ${col} after second open`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM spend_ledger').get().n, 2);
  db.close();
});

test('M1c: a fresh database gets the full schema directly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mig-test-'));
  const db = openRouterDb(dir);
  const cols = db.prepare("PRAGMA table_info(spend_ledger)").all().map((c) => c.name);
  for (const col of ['sats', 'upstream', ...NEW_COLUMNS]) {
    assert.ok(cols.includes(col), `missing ${col}`);
  }
  db.close();
});
