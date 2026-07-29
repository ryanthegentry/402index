import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startInvokeRouter, callInvoke } from './helpers/invoke-harness.js';

const ARGS = { capability: 'llm-completion claude-fable', input: 'Reply with exactly: pong', max_price_usd: 1.0 };

// Scenario B, the differentiated claim: when the upstream fails after the
// card was authorized, the hold is voided and the agent is charged $0 —
// asserted against the real Stripe API, not our own billing module.

async function stripeGet(path) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Basic ${Buffer.from(process.env.STRIPE_SECRET_KEY + ':').toString('base64')}` }
  });
  return res.json();
}

test(
  'T8a: upstream 5xx → PaymentIntent canceled on Stripe, $0 received',
  { skip: !process.env.STRIPE_SECRET_KEY && 'requires STRIPE_SECRET_KEY env var' },
  async (t) => {
  const { createBilling } = await import('../dist/billing/stripe.js');
  const real = createBilling(process.env.STRIPE_SECRET_KEY);
  const authorized = [];
  const recordingBilling = {
    async authorize(quotedUsd) {
      const auth = await real.authorize(quotedUsd);
      authorized.push(auth.paymentIntentId);
      return auth;
    },
    capture: (id) => real.capture(id),
    void: (id) => real.void(id),
    retrieve: (id) => real.retrieve(id)
  };

  const r = await startInvokeRouter({ billing: recordingBilling, behavior: { redeemStatus: 500 } });
  t.after(r.close);

  const first = await callInvoke(r.baseUrl, ARGS);
  assert.equal(first.result.resultType, 'input_required', JSON.stringify(first).slice(0, 300));
  assert.equal(authorized.length, 1, 'a real test-mode PaymentIntent was authorized');

  const res = await callInvoke(r.baseUrl, ARGS, {
    inputResponses: { consent: { action: 'accept', content: { approve: true } } },
    requestState: first.result.requestState
  });
  assert.ok(res.result.isError, JSON.stringify(res.result).slice(0, 300));
  assert.match(res.result.content[0].text, /charged \$0/i);

  const pi = await stripeGet(`payment_intents/${authorized[0]}`);
  assert.equal(pi.status, 'canceled', `Stripe reports ${pi.status} for ${authorized[0]}`);
  assert.equal(pi.amount_received, 0, 'nothing was ever captured');
});

test('T8b: upstream timeout → hold voided, candidate degraded (fast, fake billing)', async (t) => {
  const r = await startInvokeRouter({ behavior: { redeemHang: true }, redeemTimeoutMs: 500 });
  t.after(r.close);
  const first = await callInvoke(r.baseUrl, ARGS);
  const res = await callInvoke(r.baseUrl, ARGS, {
    inputResponses: { consent: { action: 'accept', content: { approve: true } } },
    requestState: first.result.requestState
  });
  assert.ok(res.result.isError);
  assert.match(res.result.content[0].text, /UPSTREAM_FAILED/);
  assert.match(res.result.content[0].text, /charged \$0/i);
  assert.equal(r.billing.calls.void.length, 1, 'hold voided after timeout');
  assert.equal(r.billing.calls.capture.length, 0);
  const degraded = r.routerDb.prepare('SELECT service_id FROM degraded_candidates').all();
  assert.equal(degraded.length, 1, 'timed-out candidate marked degraded');
});
