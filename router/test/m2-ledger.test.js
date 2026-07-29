import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openRouterDb } from '../dist/db.js';
import { createLedger } from '../dist/ledger.js';
import { createGuards } from '../dist/guards.js';

function fresh() {
  const db = openRouterDb(mkdtempSync(join(tmpdir(), 'ledger-test-')));
  return { db, ledger: createLedger(db), guards: createGuards(db, { maxSatsPerJob: 1500, maxTotalSats: 12000 }) };
}

const REC = {
  principal: null,
  serviceId: 'svc-1',
  upstream: 'https://example.com/api',
  rail: 'l402',
  network: 'lightning',
  route: 'direct-l402',
  adapter: 'golem',
  quotedSats: 500,
  settledSats: 500,
  feeSats: 1,
  chargedUsd: 0.5,
  btcUsd: 63878,
  paymentIntent: 'pi_test_1',
  jobNonce: 'nonce-1'
};

test('M2a: recordSettlement inserts with delivered NULL and sats = settled + fee', () => {
  const { db, ledger } = fresh();
  const id = ledger.recordSettlement(REC);
  assert.ok(Number.isInteger(id) && id > 0);
  const row = db.prepare('SELECT * FROM spend_ledger WHERE id = ?').get(id);
  assert.equal(row.sats, 501);
  assert.equal(row.delivered, null, 'outcome unknown at settlement time');
  assert.equal(row.route, 'direct-l402');
  assert.ok(row.settled_at, 'settled_at stamped');
  assert.equal(row.resolved_at, null);
});

test('M2b: recordDelivery(delivered: true) sets loss_sats 0 and stamps resolution', () => {
  const { db, ledger } = fresh();
  const id = ledger.recordSettlement(REC);
  ledger.recordDelivery(id, { delivered: true, latencyMs: 1234, stageTimings: { settle_ms: 8000, redeem_ms: 39000 } });
  const row = db.prepare('SELECT * FROM spend_ledger WHERE id = ?').get(id);
  assert.equal(row.delivered, 1);
  assert.equal(row.loss_sats, 0);
  assert.equal(row.latency_ms, 1234);
  assert.equal(JSON.parse(row.stage_timings).redeem_ms, 39000);
  assert.ok(row.resolved_at);
});

test('M2c: recordDelivery(delivered: false) books the full spend as loss', () => {
  const { db, ledger } = fresh();
  const id = ledger.recordSettlement(REC);
  ledger.recordDelivery(id, { delivered: false, failureReason: 'upstream returned 502' });
  const row = db.prepare('SELECT * FROM spend_ledger WHERE id = ?').get(id);
  assert.equal(row.delivered, 0);
  assert.equal(row.loss_sats, 501, 'loss equals the sats that left the wallet');
  assert.equal(row.failure_reason, 'upstream returned 502');
});

test('M2d: guards.totalSpent() counts settlements the instant they are recorded, in flight included', () => {
  const { ledger, guards } = fresh();
  assert.equal(guards.totalSpent(), 0);
  const id = ledger.recordSettlement(REC);
  assert.equal(guards.totalSpent(), 501, 'in-flight row counts against the cap');
  ledger.recordDelivery(id, { delivered: true });
  assert.equal(guards.totalSpent(), 501, 'delivery outcome does not change wallet outflow');
});

test('M2e: unresolved() surfaces in-flight rows older than the timeout, not fresh or resolved ones', () => {
  const { db, ledger } = fresh();
  const stale = ledger.recordSettlement(REC);
  db.prepare("UPDATE spend_ledger SET settled_at = datetime('now', '-20 minutes') WHERE id = ?").run(stale);
  const freshId = ledger.recordSettlement({ ...REC, jobNonce: 'nonce-2' });
  const resolved = ledger.recordSettlement({ ...REC, jobNonce: 'nonce-3' });
  ledger.recordDelivery(resolved, { delivered: true });
  const rows = ledger.unresolved(600_000); // 10 minutes
  assert.deepEqual(rows.map((r) => r.id), [stale], `expected only the stale row, got ${JSON.stringify(rows)}`);
  assert.ok(freshId !== stale);
});

test('M2f: summary() reports loss rate and per-route delivery counts', () => {
  const { ledger } = fresh();
  const a = ledger.recordSettlement(REC);
  ledger.recordDelivery(a, { delivered: true });
  const b = ledger.recordSettlement({ ...REC, route: 'l402space', settledSats: 580, feeSats: 1, jobNonce: 'n2' });
  ledger.recordDelivery(b, { delivered: false, failureReason: '502' });
  const s = ledger.summary();
  assert.equal(s.totalSats, 501 + 581);
  assert.equal(s.lossSats, 581);
  assert.ok(Math.abs(s.lossRate - 581 / 1082) < 1e-9);
  const direct = s.perRoute.find((r) => r.route === 'direct-l402');
  const gateway = s.perRoute.find((r) => r.route === 'l402space');
  assert.equal(direct.delivered, 1);
  assert.equal(gateway.lost, 1);
});
