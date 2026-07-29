import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openRouterDb } from '../dist/db.js';
import { backfillJuly29, parseGolemBalance, computeReconciliation } from '../dist/backfill.js';

// The five known payments of 2026-07-28/29. Three exist as unlabelled rows in
// the live ledger and must be UPDATED; the two pre-ledger T0 payments must be
// INSERTED. Targets from the PRD: SUM(sats)=3352, SUM(loss_sats)=2190.

function seededDb() {
  const db = openRouterDb(mkdtempSync(join(tmpdir(), 'backfill-test-')));
  const ins = db.prepare('INSERT INTO spend_ledger (id, sats, upstream) VALUES (?, ?, ?)');
  ins.run(2, 403, 'https://llm402.ai/v1/chat/completions/claude-fable-5%3Abatch');
  ins.run(3, 1206, 'https://llm402.ai/v1/chat/completions/claude-opus-4.7-fast');
  ins.run(4, 581, 'https://lightningfaucet.com/api/l402/llm-prompt');
  return db;
}

test('M3a: backfill labels the three existing rows and inserts the two T0 payments', () => {
  const db = seededDb();
  backfillJuly29(db);
  const rows = db.prepare('SELECT sats, route, delivered, loss_sats FROM spend_ledger ORDER BY id').all();
  assert.equal(rows.length, 5);
  const sums = db.prepare('SELECT SUM(sats) AS s, SUM(loss_sats) AS l FROM spend_ledger').get();
  assert.equal(sums.s, 3352, 'wallet outflow reconciles');
  assert.equal(sums.l, 2190, 'absorbed loss = two llm402 jobs + the burned T0 credit');
  assert.ok(rows.every((r) => r.route === 'l402space'), 'every historical job went through the gateway');
  const delivered = rows.filter((r) => r.delivered === 1).length;
  const lost = rows.filter((r) => r.delivered === 0).length;
  assert.equal(delivered, 2);
  assert.equal(lost, 3);
});

test('M3b: backfill is idempotent — a second run changes nothing', () => {
  const db = seededDb();
  backfillJuly29(db);
  backfillJuly29(db);
  const sums = db.prepare('SELECT COUNT(*) AS n, SUM(sats) AS s, SUM(loss_sats) AS l FROM spend_ledger').get();
  assert.equal(sums.n, 5);
  assert.equal(sums.s, 3352);
  assert.equal(sums.l, 2190);
});

test('M3c: parseGolemBalance reads the Available line from real CLI output', () => {
  const stdout = 'Connecting to Ark server...\n\n  Network:    mainnet\n  Ark addr:   ark1qq…\n\n  Total:      46,523 sats\n  Available:  46,523 sats\n  Settled:    0 sats\n';
  assert.equal(parseGolemBalance(stdout), 46523);
  assert.equal(parseGolemBalance('garbage'), null);
});

test('M3d: computeReconciliation matches ledger outflow against the wallet delta', () => {
  const ok = computeReconciliation({ ledgerSats: 3352, baselineSats: 49875, walletSats: 46523 });
  assert.equal(ok.walletDelta, 3352);
  assert.equal(ok.match, true);
  const bad = computeReconciliation({ ledgerSats: 3352, baselineSats: 49875, walletSats: 46000 });
  assert.equal(bad.match, false);
  assert.equal(bad.discrepancy, 523);
});
