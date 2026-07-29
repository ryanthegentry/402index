import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { startInvokeRouter, callInvoke } from './helpers/invoke-harness.js';

// Group D — degradation is keyed on (service_id, route), because failures
// are per endpoint AND per route (PRD D5): a gateway 502 on a service must
// not remove that service's working direct route from selection.

const __dirname = dirname(fileURLToPath(import.meta.url));
const fxCandidates = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'live-candidates.json'), 'utf8'));
const ALL_IDS = Object.values(fxCandidates)
  .filter((page) => page && typeof page === 'object' && Array.isArray(page.services))
  .flatMap((page) => page.services.map((s) => s.id));

const ARGS = { capability: 'llm-completion claude-fable', input: 'Reply with exactly: pong', max_price_usd: 1.0 };

function seedMandate(routerDb, principal) {
  routerDb
    .prepare(`INSERT INTO mandates (principal, budget_usd, spent_usd, expires_at) VALUES (?, 100, 0, datetime('now', '+7 days'))`)
    .run(principal);
}

test('T12a: the v1 service-keyed table migrates to (service_id, route) with wildcard rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'degrade-migrate-'));
  const raw = new Database(join(dir, 'router.db'));
  raw.exec(`
    CREATE TABLE degraded_candidates (
      service_id TEXT PRIMARY KEY,
      reason TEXT,
      degraded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO degraded_candidates (service_id, reason) VALUES ('svc-legacy', 'gateway 502');
  `);
  raw.close();

  const { openRouterDb } = await import('../dist/db.js');
  const db = openRouterDb(dir);
  const row = db.prepare("SELECT route, reason FROM degraded_candidates WHERE service_id = 'svc-legacy'").get();
  assert.equal(row.route, '*', 'v1 rows block every route, preserving their old meaning');
  assert.equal(row.reason, 'gateway 502');
  // composite key: the same service can now hold a second, route-scoped row
  db.prepare("INSERT INTO degraded_candidates (service_id, route, reason) VALUES ('svc-2', 'l402space', 'x')").run();
  db.prepare("INSERT INTO degraded_candidates (service_id, route, reason) VALUES ('svc-2', 'direct-l402', 'y')").run();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM degraded_candidates WHERE service_id = 'svc-2'").get().n, 2);
  db.close();
});

test('T12b: a gateway-degraded service still delivers over its direct route', async (t) => {
  const r = await startInvokeRouter({ routeOrder: 'l402space,direct-l402' });
  t.after(r.close);
  seedMandate(r.routerDb, 'wire-test-agent');
  const ins = r.routerDb.prepare('INSERT INTO degraded_candidates (service_id, route, reason) VALUES (?, ?, ?)');
  for (const id of ALL_IDS) ins.run(id, 'l402space', 'gateway 502 last night');

  const res = await callInvoke(r.baseUrl, ARGS);
  assert.ok(!res.result.isError, JSON.stringify(res.result).slice(0, 400));
  assert.equal(res.result.structuredContent.route, 'direct-l402', 'selection skipped the degraded gateway route');
  assert.ok(
    !r.fetchImpl.calls.some((c) => c.url.startsWith('https://l402.space/')),
    'the degraded route was never even quoted'
  );
});

test('T12c: a redeem failure degrades only the route that failed', async (t) => {
  const r = await startInvokeRouter({ behavior: { redeemStatus: 500 } });
  t.after(r.close);
  seedMandate(r.routerDb, 'wire-test-agent');
  const res = await callInvoke(r.baseUrl, ARGS);
  assert.ok(res.result.isError, JSON.stringify(res.result).slice(0, 300));
  assert.match(res.result.content[0].text, /UPSTREAM_FAILED/);
  const rows = r.routerDb.prepare('SELECT service_id, route FROM degraded_candidates').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].route, 'l402space', 'the failing route is degraded, not the whole service');
});

test('T12d: a candidate degraded on every configured route leaves selection entirely', async (t) => {
  const r = await startInvokeRouter(); // routeOrder: l402space only
  t.after(r.close);
  seedMandate(r.routerDb, 'wire-test-agent');
  const ins = r.routerDb.prepare('INSERT INTO degraded_candidates (service_id, route, reason) VALUES (?, ?, ?)');
  for (const id of ALL_IDS) ins.run(id, 'l402space', 'down');
  const res = await callInvoke(r.baseUrl, ARGS);
  assert.ok(res.result.isError, JSON.stringify(res.result).slice(0, 300));
  assert.match(res.result.content[0].text, /NO_CANDIDATES/, 'every route of every candidate is degraded');
});
