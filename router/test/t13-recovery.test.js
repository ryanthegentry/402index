import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { startInvokeRouter, routingFetch } from './helpers/invoke-harness.js';

// Group E — scheduled credential recovery (PRD D5). retry-credentials logic
// already exists and is free to run; nothing called it. The schedule runs it
// in-process, never overlaps a slow pass, and reports recovered sats.

function seedLoss(db, { redeemUrl = 'https://l402.space/l402/x', route = 'l402space' } = {}) {
  const ledgerId = Number(
    db.prepare(`
      INSERT INTO spend_ledger (sats, upstream, service_id, route, quoted_sats, settled_sats, fee_sats, delivered, loss_sats, settled_at, resolved_at)
      VALUES (580, 'https://llm402.ai/x', 'svc-1', ?, 580, 580, 0, 0, 580, datetime('now'), datetime('now'))
    `).run(route).lastInsertRowid
  );
  db.prepare(`
    INSERT INTO paid_credentials
      (ledger_id, service_id, upstream, route, redeem_url, http_method, body, credential, proof, settled_sats, redeemed, attempts)
    VALUES (?, 'svc-1', 'https://llm402.ai/x', ?, ?, 'GET', NULL, 'cred-truncated', '${'ab'.repeat(32)}', 580, 0, 1)
  `).run(ledgerId, route, redeemUrl);
  return ledgerId;
}

test('T13a: the schedule redeems a recovered credential and repairs its ledger row', async (t) => {
  const { openRouterDb } = await import('../dist/db.js');
  const { createLedger } = await import('../dist/ledger.js');
  const { createCredentials } = await import('../dist/credentials.js');
  const { startRecoverySchedule } = await import('../dist/recovery.js');
  const db = openRouterDb(mkdtempSync(join(tmpdir(), 'recovery-')));
  t.after(() => db.close());
  const ledgerId = seedLoss(db);

  const lines = [];
  const schedule = startRecoverySchedule({
    db,
    ledger: createLedger(db),
    creds: createCredentials(db),
    routes: [{ name: 'l402space', supports: () => true, quote: async () => { throw new Error('unused'); }, redeem: async () => new Response('recovered body', { status: 200 }) }],
    fetchImpl: fetch,
    intervalMs: 20,
    log: (line) => lines.push(line)
  });
  t.after(() => schedule.stop());

  await sleep(120);
  const cred = db.prepare('SELECT redeemed FROM paid_credentials').get();
  assert.equal(cred.redeemed, 1, 'the paid credential was redeemed for free');
  const row = db.prepare('SELECT delivered, loss_sats FROM spend_ledger WHERE id = ?').get(ledgerId);
  assert.equal(row.delivered, 1, 'ledger repaired: the job did deliver');
  assert.equal(row.loss_sats, 0, 'the absorbed loss is recovered');
  assert.ok(lines.some((l) => /recovered 580 sats/.test(l)), `reports recovered sats: ${JSON.stringify(lines)}`);
});

test('T13b: a slow pass is never overlapped by the next tick', async (t) => {
  const { openRouterDb } = await import('../dist/db.js');
  const { createLedger } = await import('../dist/ledger.js');
  const { createCredentials } = await import('../dist/credentials.js');
  const { startRecoverySchedule } = await import('../dist/recovery.js');
  const db = openRouterDb(mkdtempSync(join(tmpdir(), 'recovery-overlap-')));
  t.after(() => db.close());
  seedLoss(db);

  let redeems = 0;
  const schedule = startRecoverySchedule({
    db,
    ledger: createLedger(db),
    creds: createCredentials(db),
    routes: [{
      name: 'l402space',
      supports: () => true,
      quote: async () => { throw new Error('unused'); },
      redeem: async () => {
        redeems += 1;
        await sleep(300); // spans many 20ms ticks
        return new Response('slow', { status: 502 });
      }
    }],
    fetchImpl: fetch,
    intervalMs: 20,
    log: () => {}
  });
  t.after(() => schedule.stop());

  await sleep(150);
  assert.equal(redeems, 1, 'one in-flight pass, no stacking');
});

test('T13c: the router app starts the schedule from config and stops it on shutdown', async (t) => {
  process.env.ROUTER_RETRY_INTERVAL_MINUTES = '0.001'; // 60ms — test-only fraction
  const r = await startInvokeRouter({ fetchImpl: routingFetch() });
  t.after(async () => {
    delete process.env.ROUTER_RETRY_INTERVAL_MINUTES;
    await r.close();
  });
  // the routingFetch mock answers an authenticated l402.space redeem with 200
  seedLoss(r.routerDb, { redeemUrl: 'https://l402.space/l402/https%3A%2F%2Fllm402.ai%2Fx' });
  await sleep(250);
  const cred = r.routerDb.prepare('SELECT redeemed FROM paid_credentials').get();
  assert.equal(cred.redeemed, 1, 'the app-wired schedule recovered the credential');
});
