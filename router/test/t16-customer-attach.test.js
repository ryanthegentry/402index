import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startInvokeRouter, callInvoke } from './helpers/invoke-harness.js';

// Reproduces the first live walkthrough failure (2026-07-30): Checkout in
// setup mode collected a PaymentMethod but never bound it to a Stripe
// Customer, so the card hold on the first invoke failed — Stripe only allows
// a saved PaymentMethod to be reused when it is attached to a Customer and
// the PaymentIntent names that Customer. The fake Stripe in the original
// tests did not enforce attach semantics, which is how the suite stayed
// green around a broken live flow. The chain under test: setup creates a
// Customer and Checkout attaches the card to it → the customer id is stored
// beside the card → every hold passes customer + payment_method together.

const ARGS = { capability: 'llm-completion claude-fable', input: 'Reply with exactly: pong', max_price_usd: 1.0 };

function fakeSetupStripe() {
  const calls = { customers: [], create: [], retrieve: [] };
  return {
    calls,
    customers: {
      async create(params) {
        calls.customers.push(params ?? {});
        return { id: `cus_test_${calls.customers.length}` };
      }
    },
    checkout: {
      sessions: {
        async create(params) {
          calls.create.push(params);
          return { id: 'cs_test_attach_1', url: 'https://checkout.stripe.com/c/pay/cs_test_attach_1' };
        },
        async retrieve(id) {
          calls.retrieve.push(id);
          return {
            id,
            status: 'complete',
            customer: calls.create[0]?.customer ?? null,
            metadata: { budget_usd: '20', budget_days: '30' },
            setup_intent: 'seti_test_1'
          };
        }
      }
    },
    setupIntents: {
      async retrieve() {
        return { payment_method: 'pm_card_attach' };
      }
    }
  };
}

test('T16a: setup creates a Customer, binds the session to it, and stores it with the card', async (t) => {
  const stripe = fakeSetupStripe();
  const r = await startInvokeRouter({ setupStripeImpl: stripe });
  t.after(r.close);

  const sess = await fetch(`${r.baseUrl}/setup/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'budget_usd=20&budget_days=30',
    redirect: 'manual'
  });
  assert.equal(sess.status, 303);
  assert.equal(stripe.calls.customers.length, 1, 'a Customer is created before the session');
  assert.equal(stripe.calls.create[0].customer, 'cus_test_1', 'the session is bound to it, so Checkout attaches the card');

  const done = await fetch(`${r.baseUrl}/setup/complete?session_id=cs_test_attach_1`);
  assert.equal(done.status, 200);
  const principal = r.routerDb.prepare('SELECT principal FROM cards ORDER BY rowid DESC LIMIT 1').get().principal;
  const card = r.routerDb.prepare('SELECT payment_method, customer FROM cards WHERE principal = ?').get(principal);
  assert.equal(card.payment_method, 'pm_card_attach');
  assert.equal(card.customer, 'cus_test_1', 'the customer id is stored beside the card');
});

test('T16b: a hold on a stored card names its Customer', async (t) => {
  const r = await startInvokeRouter();
  t.after(r.close);
  r.routerDb
    .prepare('INSERT INTO cards (principal, payment_method, customer) VALUES (?, ?, ?)')
    .run('wire-test-agent-2', 'pm_card_cus', 'cus_wire_2');
  r.routerDb
    .prepare(`INSERT INTO mandates (principal, budget_usd, spent_usd, expires_at) VALUES ('wire-test-agent-2', 100, 0, datetime('now', '+7 days'))`)
    .run();

  const { callInvokeAs } = await import('./helpers/invoke-harness.js');
  const res = await callInvokeAs(r.baseUrl, 'wire-test-agent-2', ARGS);
  assert.ok(!res.result?.isError, JSON.stringify(res).slice(0, 300));
  const auth = r.billing.calls.authorize[0];
  assert.equal(auth.opts.paymentMethod, 'pm_card_cus');
  assert.equal(auth.opts.customer, 'cus_wire_2', 'the PaymentIntent must name the Customer or Stripe refuses the saved card');
});

test('T16c: in-loop registration binds a Customer the same way', async () => {
  const { openRouterDb } = await import('../dist/db.js');
  const { createRegistration } = await import('../dist/registration.js');
  const calls = { customers: [], created: [] };
  const stripeImpl = {
    customers: {
      async create() {
        calls.customers.push({});
        return { id: 'cus_reg_1' };
      }
    },
    checkout: {
      sessions: {
        create: async (params) => {
          calls.created.push(params);
          return { id: 'cs_reg_1', url: 'https://checkout.stripe.example/c/x', status: 'open' };
        },
        retrieve: async (id) => ({ id, status: 'complete', customer: 'cus_reg_1', setup_intent: 'seti_reg_1' })
      }
    },
    setupIntents: {
      retrieve: async () => ({ payment_method: 'pm_reg_visa' })
    }
  };
  const db = openRouterDb(mkdtempSync(join(tmpdir(), 'reg-attach-')));
  const reg = createRegistration(db, { stripeImpl });
  await reg.checkoutUrlFor('agent-c');
  assert.equal(calls.customers.length, 1, 'registration creates a Customer');
  assert.equal(calls.created[0].customer, 'cus_reg_1', 'and binds the session to it');
  assert.equal(await reg.completeIfRegistered('agent-c'), true);
  const card = db.prepare('SELECT payment_method, customer FROM cards WHERE principal = ?').get('agent-c');
  assert.equal(card.customer, 'cus_reg_1', 'stored beside the card');
  db.close();
});
