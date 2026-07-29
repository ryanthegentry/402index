import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openRouterDb } from '../dist/db.js';
import { createLedger } from '../dist/ledger.js';
import { createCredentials, retryUnredeemed } from '../dist/credentials.js';
import { buildRoutes } from '../dist/routes/index.js';
import { startInvokeRouter, callInvoke, UPSTREAM_TEXT } from './helpers/invoke-harness.js';

// An L402 credential is a bearer asset we bought. It outlives the job that
// paid for it and it survives a failed delivery — the router must persist it
// at settlement and be able to redeem it again later.

function fresh() {
  const db = openRouterDb(mkdtempSync(join(tmpdir(), 'cred-test-')));
  return { db, ledger: createLedger(db), creds: createCredentials(db) };
}

const REC = {
  ledgerId: 1,
  serviceId: 'svc-1',
  upstream: 'https://llm402.ai/v1/chat/completions/claude-opus-4.7-fast',
  route: 'direct-l402',
  redeemUrl: 'https://llm402.ai/v1/chat/completions/claude-opus-4.7-fast',
  httpMethod: 'POST',
  body: '{"messages":[]}',
  credential: 'MDAxOWxvY2F0aW9uFAKEMACAROON',
  proof: 'ab'.repeat(32),
  settledSats: 1024
};

test('M10a: a paid credential is persisted and starts unredeemed', () => {
  const { creds } = fresh();
  const id = creds.record(REC);
  const rows = creds.unredeemed();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, id);
  assert.equal(rows[0].credential, REC.credential, 'the macaroon itself is retained');
  assert.equal(rows[0].proof, REC.proof, 'and the preimage that unlocks it');
  assert.equal(rows[0].settled_sats, 1024);
});

test('M10b: a successful delivery marks it redeemed and drops it from the retry queue', () => {
  const { creds } = fresh();
  const id = creds.record(REC);
  creds.markRedeemed(id);
  assert.deepEqual(creds.unredeemed(), []);
  assert.equal(creds.get(id).redeemed, 1, 'kept on file — L402 credentials are long-lived');
});

test('M10c: a failed delivery keeps the credential and records the attempt', () => {
  const { creds } = fresh();
  const id = creds.record(REC);
  creds.recordAttempt(id, 'upstream returned 502');
  const row = creds.get(id);
  assert.equal(row.redeemed, 0);
  assert.equal(row.attempts, 1);
  assert.match(row.last_error, /502/);
  assert.equal(creds.unredeemed().length, 1, 'still retryable');
});

test('M10d: retryUnredeemed recovers the value and repairs the ledger row', async () => {
  const { db, ledger, creds } = fresh();
  const ledgerId = ledger.recordSettlement({
    serviceId: 'svc-1', upstream: REC.upstream, rail: 'l402', network: 'lightning',
    route: 'direct-l402', adapter: 'golem', quotedSats: 1024, settledSats: 1024,
    feeSats: 2, chargedUsd: 0.66, btcUsd: 64000, paymentIntent: 'pi_x', jobNonce: null
  });
  ledger.recordDelivery(ledgerId, { delivered: false, failureReason: 'upstream returned 502' });
  const credId = creds.record({ ...REC, ledgerId });
  assert.equal(db.prepare('SELECT loss_sats FROM spend_ledger WHERE id = ?').get(ledgerId).loss_sats, 1026);

  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), auth: init.headers?.Authorization });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'recovered' } }] }), { status: 200 });
  };
  const results = await retryUnredeemed({ db, ledger, creds, routes: buildRoutes(['direct-l402']), fetchImpl, timeoutMs: 5000 });

  assert.equal(results.length, 1);
  assert.equal(results[0].delivered, true);
  assert.equal(calls[0].auth, `L402 ${REC.credential}:${REC.proof}`, 'redeemed with the credential we already paid for');
  const row = db.prepare('SELECT delivered, loss_sats FROM spend_ledger WHERE id = ?').get(ledgerId);
  assert.equal(row.delivered, 1, 'ledger repaired: the job did deliver after all');
  assert.equal(row.loss_sats, 0, 'the absorbed loss is recovered');
  assert.equal(creds.get(credId).redeemed, 1);
});

test('M10e: a still-failing retry leaves the loss booked and counts the attempt', async () => {
  const { db, ledger, creds } = fresh();
  const ledgerId = ledger.recordSettlement({
    serviceId: 'svc-1', upstream: REC.upstream, rail: 'l402', network: 'lightning',
    route: 'direct-l402', adapter: 'golem', quotedSats: 1024, settledSats: 1024,
    feeSats: 2, chargedUsd: 0.66, btcUsd: 64000, paymentIntent: 'pi_x', jobNonce: null
  });
  ledger.recordDelivery(ledgerId, { delivered: false, failureReason: '502' });
  const credId = creds.record({ ...REC, ledgerId });
  const fetchImpl = async () => new Response('still broken', { status: 502 });
  const results = await retryUnredeemed({ db, ledger, creds, routes: buildRoutes(['direct-l402']), fetchImpl, timeoutMs: 5000 });
  assert.equal(results[0].delivered, false);
  assert.equal(db.prepare('SELECT loss_sats FROM spend_ledger WHERE id = ?').get(ledgerId).loss_sats, 1026);
  assert.equal(creds.get(credId).attempts, 1);
});

test('M10f: end to end — a failed delivery leaves a retryable credential behind', async (t) => {
  const fakeReal = {
    name: 'fake-lightning', rails: ['l402'], networks: ['lightning'], minSats: 333, movesRealFunds: true,
    canSettle: (req) => req.rail === 'l402' && req.amountSats !== null,
    pay: async (req) => ({ proof: 'cd'.repeat(32), proofKind: 'preimage', preimage: 'cd'.repeat(32), paidSats: req.amountSats, paidAmount: req.amount, feeSats: 1, durationMs: 5 }),
    payInvoice: async () => { throw new Error('unused'); }
  };
  const r = await startInvokeRouter({ routeOrder: 'direct-l402,l402space', adapter: fakeReal, behavior: { redeemStatus: 500 } });
  t.after(r.close);
  const args = { capability: 'llm-completion claude-fable', input: 'x', max_price_usd: 1.0 };
  const first = await callInvoke(r.baseUrl, args);
  const res = await callInvoke(r.baseUrl, args, {
    inputResponses: { consent: { action: 'accept', content: { approve: true } } },
    requestState: first.result.requestState
  });
  assert.ok(res.result.isError, 'delivery failed as forced');
  const held = r.routerDb.prepare('SELECT credential, proof, redeemed, settled_sats FROM paid_credentials').all();
  assert.equal(held.length, 1, 'the credential we paid for is still on file');
  assert.equal(held[0].redeemed, 0);
  assert.ok(held[0].credential.length > 10, 'macaroon retained');
  assert.equal(held[0].proof, 'cd'.repeat(32), 'preimage retained');
});
