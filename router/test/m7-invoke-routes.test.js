import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startInvokeRouter, callInvoke } from './helpers/invoke-harness.js';

const ARGS = { capability: 'llm-completion claude-fable', input: 'Reply with exactly: pong', max_price_usd: 1.0 };
const APPROVE = { consent: { action: 'accept', content: { approve: true } } };
const APPROVE_WITH_BUDGET = { consent: { action: 'accept', content: { approve: true, standing_budget_usd: 2, standing_budget_days: 7 } } };

// Multirail behavior: direct-first route order, mandates, two-phase ledger.
// The legacy t7 suite pins ROUTER_ROUTE_ORDER=l402space and keeps the PoC
// contract; this file exercises the new default.

test('M7a: direct-first order quotes the upstream directly and the receipt says so', async (t) => {
  const r = await startInvokeRouter({ routeOrder: 'direct-l402,l402space' });
  t.after(r.close);
  const first = await callInvoke(r.baseUrl, ARGS);
  assert.equal(first.result.resultType, 'input_required');
  const res = await callInvoke(r.baseUrl, ARGS, { inputResponses: APPROVE, requestState: first.result.requestState });
  const receipt = res.result._meta['io.402index/receipt'];
  assert.equal(receipt.route, 'direct-l402');
  assert.equal(receipt.paid_sats, 500, 'the upstream price — 80 sats under the gateway re-quote');
  assert.ok(receipt.stage_timings, 'stage timings ride the receipt');
  assert.ok(receipt.stage_timings.settle_ms >= 0);
});

test('M7b: a failing direct quote falls through to the gateway and records that route', async (t) => {
  const r = await startInvokeRouter({ routeOrder: 'direct-l402,l402space', behavior: { directQuoteStatus: 403 } });
  t.after(r.close);
  const first = await callInvoke(r.baseUrl, ARGS);
  const res = await callInvoke(r.baseUrl, ARGS, { inputResponses: APPROVE, requestState: first.result.requestState });
  const receipt = res.result._meta['io.402index/receipt'];
  assert.equal(receipt.route, 'l402space');
  assert.equal(receipt.paid_sats, 580);
});

test('M7c: a standing budget makes the next invoke complete in a single round', async (t) => {
  const r = await startInvokeRouter({ routeOrder: 'direct-l402,l402space' });
  t.after(r.close);
  const first = await callInvoke(r.baseUrl, ARGS);
  const approved = await callInvoke(r.baseUrl, ARGS, { inputResponses: APPROVE_WITH_BUDGET, requestState: first.result.requestState });
  assert.ok(!approved.result.isError, JSON.stringify(approved.result).slice(0, 300));

  const second = await callInvoke(r.baseUrl, ARGS);
  assert.equal(second.result.resultType, 'complete', 'no consent interruption under the mandate');
  assert.ok(!second.result.isError, JSON.stringify(second.result).slice(0, 300));
  const receipt = second.result._meta['io.402index/receipt'];
  assert.equal(receipt.mandated, true, 'receipt marks the mandate-covered call');
  const m = r.routerDb.prepare('SELECT budget_usd, spent_usd FROM mandates WHERE principal = ?').get('wire-test-agent');
  assert.equal(m.budget_usd, 2);
  assert.ok(m.spent_usd >= 1.0, `two $0.50 charges recorded, got ${m.spent_usd}`);
});

test('M7d: an exhausted or missing mandate steps back up to consent', async (t) => {
  const r = await startInvokeRouter({ routeOrder: 'direct-l402,l402space' });
  t.after(r.close);
  const first = await callInvoke(r.baseUrl, ARGS);
  // grant a budget too small to cover the next $0.50 charge
  await callInvoke(r.baseUrl, ARGS, {
    inputResponses: { consent: { action: 'accept', content: { approve: true, standing_budget_usd: 0.8, standing_budget_days: 7 } } },
    requestState: first.result.requestState
  });
  const second = await callInvoke(r.baseUrl, ARGS); // 0.5 spent, 0.3 left < 0.5
  assert.equal(second.result.resultType, 'input_required', 'remaining budget cannot cover the charge — consent again');
});

test('M7e: an expired mandate does not authorize anything', async (t) => {
  const r = await startInvokeRouter({ routeOrder: 'direct-l402,l402space' });
  t.after(r.close);
  const first = await callInvoke(r.baseUrl, ARGS);
  await callInvoke(r.baseUrl, ARGS, { inputResponses: APPROVE_WITH_BUDGET, requestState: first.result.requestState });
  r.routerDb.prepare("UPDATE mandates SET expires_at = datetime('now', '-1 day') WHERE principal = ?").run('wire-test-agent');
  const second = await callInvoke(r.baseUrl, ARGS);
  assert.equal(second.result.resultType, 'input_required');
});

test('M7f: a real-funds settlement writes the two-phase ledger row — delivered', async (t) => {
  const fakeReal = {
    name: 'fake-lightning',
    rails: ['l402'],
    networks: ['lightning'],
    minSats: 333,
    movesRealFunds: true,
    canSettle: (req) => req.rail === 'l402' && req.amountSats !== null,
    pay: async (req) => ({ proof: 'cd'.repeat(32), proofKind: 'preimage', preimage: 'cd'.repeat(32), paidSats: req.amountSats, paidAmount: req.amount, feeSats: 1, durationMs: 5 }),
    payInvoice: async () => { throw new Error('unused'); }
  };
  const r = await startInvokeRouter({ routeOrder: 'direct-l402,l402space', adapter: fakeReal });
  t.after(r.close);
  const first = await callInvoke(r.baseUrl, ARGS);
  const res = await callInvoke(r.baseUrl, ARGS, { inputResponses: APPROVE, requestState: first.result.requestState });
  assert.ok(!res.result.isError, JSON.stringify(res.result).slice(0, 300));
  const row = r.routerDb.prepare('SELECT * FROM spend_ledger ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.route, 'direct-l402');
  assert.equal(row.delivered, 1);
  assert.equal(row.loss_sats, 0);
  assert.equal(row.sats, 501);
  assert.ok(JSON.parse(row.stage_timings).redeem_ms >= 0);
});

test('M7g: an upstream failure after real settlement books the loss and voids the hold', async (t) => {
  const fakeReal = {
    name: 'fake-lightning', rails: ['l402'], networks: ['lightning'], minSats: 333, movesRealFunds: true,
    canSettle: (req) => req.rail === 'l402' && req.amountSats !== null,
    pay: async (req) => ({ proof: 'cd'.repeat(32), proofKind: 'preimage', preimage: 'cd'.repeat(32), paidSats: req.amountSats, paidAmount: req.amount, feeSats: 1, durationMs: 5 }),
    payInvoice: async () => { throw new Error('unused'); }
  };
  const r = await startInvokeRouter({ routeOrder: 'direct-l402,l402space', adapter: fakeReal, behavior: { redeemStatus: 500 } });
  t.after(r.close);
  const first = await callInvoke(r.baseUrl, ARGS);
  const res = await callInvoke(r.baseUrl, ARGS, { inputResponses: APPROVE, requestState: first.result.requestState });
  assert.ok(res.result.isError);
  assert.match(res.result.content[0].text, /charged \$0/i);
  const row = r.routerDb.prepare('SELECT * FROM spend_ledger ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.delivered, 0);
  assert.equal(row.loss_sats, row.sats, 'the whole spend is absorbed loss');
  assert.match(row.failure_reason, /500/);
  assert.equal(r.billing.calls.void.length, 1);
});
