import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openRouterDb } from '../dist/db.js';
import { createRegistration } from '../dist/registration.js';
import { startInvokeRouter } from './helpers/invoke-harness.js';

// In-loop card registration: the first contact with a cardless agent mints a
// real Stripe Checkout URL inside the MCP loop; when the human finishes the
// hosted page, the agent's next call finds the card and proceeds. Completion
// is polled via the Sessions API — no webhook needed for a local router.

function fakeStripe(state) {
  return {
    customers: {
      create: async () => ({ id: 'cus_fake_1' })
    },
    checkout: {
      sessions: {
        create: async (params) => {
          state.created.push(params);
          return { id: `cs_fake_${state.created.length}`, url: `https://checkout.stripe.example/c/${params.client_reference_id}`, status: 'open' };
        },
        retrieve: async (id) => ({
          id,
          status: state.completed ? 'complete' : 'open',
          customer: 'cus_fake_1',
          setup_intent: state.completed ? 'seti_fake_1' : null
        })
      }
    },
    setupIntents: {
      retrieve: async () => ({ id: 'seti_fake_1', payment_method: 'pm_fake_visa', status: 'succeeded' })
    }
  };
}

function fresh(state) {
  const db = openRouterDb(mkdtempSync(join(tmpdir(), 'reg-test-')));
  return { db, reg: createRegistration(db, { stripeImpl: fakeStripe(state) }) };
}

test('M9a: checkoutUrlFor mints a setup-mode session once and reuses it while open', async () => {
  const state = { created: [], completed: false };
  const { reg } = fresh(state);
  const url1 = await reg.checkoutUrlFor('agent-a');
  const url2 = await reg.checkoutUrlFor('agent-a');
  assert.equal(url1, url2, 'open session reused');
  assert.equal(state.created.length, 1, 'exactly one session created');
  assert.equal(state.created[0].mode, 'setup');
  assert.equal(state.created[0].client_reference_id, 'agent-a');
});

test('M9b: completeIfRegistered is false while open, stores the card on completion', async () => {
  const state = { created: [], completed: false };
  const { db, reg } = fresh(state);
  await reg.checkoutUrlFor('agent-a');
  assert.equal(await reg.completeIfRegistered('agent-a'), false);
  state.completed = true;
  assert.equal(await reg.completeIfRegistered('agent-a'), true);
  const card = db.prepare('SELECT payment_method FROM cards WHERE principal = ?').get('agent-a');
  assert.equal(card.payment_method, 'pm_fake_visa');
  const pending = db.prepare('SELECT COUNT(*) AS n FROM pending_registrations').get();
  assert.equal(pending.n, 0, 'pending row consumed');
});

test('M9c: end to end through invoke — url elicitation, completion, then consent', async (t) => {
  const state = { created: [], completed: false };
  const r = await startInvokeRouter({
    routeOrder: 'direct-l402,l402space',
    registrationStripeImpl: fakeStripe(state)
  });
  t.after(r.close);
  const args = { capability: 'llm-completion claude-fable', input: 'x', max_price_usd: 1.0 };

  const cold = await (await import('./helpers/invoke-harness.js')).callInvokeAs(r.baseUrl, 'cold-agent-m9', args);
  assert.equal(cold.result.resultType, 'input_required');
  assert.equal(cold.result.inputRequests.register.params.mode, 'url');
  assert.match(cold.result.inputRequests.register.params.url, /checkout\.stripe\.example\/c\/cold-agent-m9/);

  state.completed = true; // the human finished the hosted page
  const warm = await (await import('./helpers/invoke-harness.js')).callInvokeAs(r.baseUrl, 'cold-agent-m9', args);
  assert.equal(warm.result.resultType, 'input_required');
  assert.ok(warm.result.inputRequests.consent, 'card found via completion poll — consent flow now');
});

const SKIP_LIVE = { skip: !process.env.STRIPE_SECRET_KEY && 'requires STRIPE_SECRET_KEY env var' };

test('M9d: live — a real setup-mode Checkout session mints a real hosted URL', SKIP_LIVE, async () => {
  const db = openRouterDb(mkdtempSync(join(tmpdir(), 'reg-live-')));
  const reg = createRegistration(db, { stripeSecretKey: process.env.STRIPE_SECRET_KEY });
  const url = await reg.checkoutUrlFor('live-structural-test');
  assert.match(url, /^https:\/\/checkout\.stripe\.com\//, 'a real Stripe-hosted page');
  assert.equal(await reg.completeIfRegistered('live-structural-test'), false, 'nobody completed it');
  await reg.abandon('live-structural-test'); // expire the session, leave nothing dangling
});
