import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRouterDb } from '../dist/db.js';
import { createGuards, GuardError } from '../dist/guards.js';

function freshDb() {
  return openRouterDb(mkdtempSync(join(tmpdir(), 'guards-test-')));
}

test('T3a: a job above the per-job cap throws JOB_CAP before any money moves', () => {
  const db = freshDb();
  const guards = createGuards(db, { maxSatsPerJob: 2000, maxTotalSats: 20000 });
  assert.throws(
    () => guards.checkJob(2001),
    (err) => err instanceof GuardError && err.code === 'JOB_CAP'
  );
  assert.equal(guards.totalSpent(), 0);
});

test('T3b: a job that would exceed the cumulative cap throws TOTAL_CAP', () => {
  const db = freshDb();
  const guards = createGuards(db, { maxSatsPerJob: 2000, maxTotalSats: 3000 });
  guards.checkJob(1500);
  guards.recordSpend(1500, 'https://example.com/a');
  guards.checkJob(1400);
  guards.recordSpend(1400, 'https://example.com/b');
  assert.throws(
    () => guards.checkJob(200),
    (err) => err instanceof GuardError && err.code === 'TOTAL_CAP'
  );
});

test('T3c: cumulative spend persists across a reopen of the same data dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guards-test-'));
  const db1 = openRouterDb(dir);
  const g1 = createGuards(db1, { maxSatsPerJob: 2000, maxTotalSats: 20000 });
  g1.recordSpend(580, 'https://example.com/paid');
  db1.close();
  const db2 = openRouterDb(dir);
  const g2 = createGuards(db2, { maxSatsPerJob: 2000, maxTotalSats: 20000 });
  assert.equal(g2.totalSpent(), 580);
});

test('T3d: an in-cap job passes and recordSpend accumulates', () => {
  const db = freshDb();
  const guards = createGuards(db, { maxSatsPerJob: 2000, maxTotalSats: 20000 });
  guards.checkJob(580);
  guards.recordSpend(580, 'https://example.com/x');
  assert.equal(guards.totalSpent(), 580);
});
