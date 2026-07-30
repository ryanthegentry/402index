import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startInvokeRouter } from './helpers/invoke-harness.js';

// Group C — the one human-interactive surface (PRD D2/D9): a web page,
// visited once. Card via Stripe Checkout in setup mode, a standing budget,
// and a bearer token with copy-paste `claude mcp add` instructions. Anonymous
// issuance; the token is shown exactly once. Served by the router itself —
// the tokens/cards/mandates tables live in the router's SQLite file, and
// SQLite has one writer.

function fakeSetupStripe(overridesByShape = {}) {
  const calls = { create: [], retrieve: [], setupIntents: [] };
  const state = {
    status: 'complete',
    metadata: { budget_usd: '20', budget_days: '30' },
    setupIntent: 'seti_test_1',
    paymentMethod: 'pm_card_setup',
    ...overridesByShape
  };
  return {
    calls,
    state,
    customers: {
      async create() {
        return { id: 'cus_test_setup_1' };
      }
    },
    checkout: {
      sessions: {
        async create(params) {
          calls.create.push(params);
          return { id: 'cs_test_setup_1', url: 'https://checkout.stripe.com/c/pay/cs_test_setup_1' };
        },
        async retrieve(id) {
          calls.retrieve.push(id);
          return { id, status: state.status, customer: 'cus_test_setup_1', metadata: state.metadata, setup_intent: state.setupIntent };
        }
      }
    },
    setupIntents: {
      async retrieve(id) {
        calls.setupIntents.push(id);
        return { payment_method: state.paymentMethod };
      }
    }
  };
}

test('T15a: GET /setup serves the one-visit page with a budget form', async (t) => {
  const stripe = fakeSetupStripe();
  const r = await startInvokeRouter({ setupStripeImpl: stripe });
  t.after(r.close);
  const res = await fetch(`${r.baseUrl}/setup`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  const html = await res.text();
  assert.match(html, /budget_usd/, 'budget field present');
  assert.match(html, /\/setup\/session/, 'form posts to the session endpoint');
});

test('T15b: POST /setup/session redirects to Stripe Checkout with the budget in metadata', async (t) => {
  const stripe = fakeSetupStripe();
  const r = await startInvokeRouter({ setupStripeImpl: stripe });
  t.after(r.close);
  const res = await fetch(`${r.baseUrl}/setup/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'budget_usd=20&budget_days=30',
    redirect: 'manual'
  });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), 'https://checkout.stripe.com/c/pay/cs_test_setup_1');
  const created = stripe.calls.create[0];
  assert.equal(created.mode, 'setup');
  assert.equal(created.metadata.budget_usd, '20');
  assert.equal(created.metadata.budget_days, '30');
  assert.match(created.success_url, /\/setup\/complete\?session_id=\{CHECKOUT_SESSION_ID\}/);
});

test('T15b2: hostile form input clamps to sane budget bounds', async (t) => {
  const stripe = fakeSetupStripe();
  const r = await startInvokeRouter({ setupStripeImpl: stripe });
  t.after(r.close);
  for (const body of ['budget_usd=-5&budget_days=99999', 'budget_usd=NaN&budget_days=zero', 'budget_usd=1e12']) {
    await fetch(`${r.baseUrl}/setup/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      redirect: 'manual'
    });
  }
  for (const created of stripe.calls.create) {
    const usd = Number(created.metadata.budget_usd);
    const days = Number(created.metadata.budget_days);
    assert.ok(usd >= 1 && usd <= 500, `budget clamped, got ${usd}`);
    assert.ok(days >= 1 && days <= 90, `days clamped, got ${days}`);
  }
});

test('T15c: a completed session issues card + mandate + token, shown once with the mcp add line', async (t) => {
  const stripe = fakeSetupStripe();
  const r = await startInvokeRouter({ setupStripeImpl: stripe });
  t.after(r.close);
  const res = await fetch(`${r.baseUrl}/setup/complete?session_id=cs_test_setup_1`);
  assert.equal(res.status, 200);
  const html = await res.text();
  const token = /402r_[0-9a-f]{48}/.exec(html)?.[0];
  assert.ok(token, 'the bearer token is shown on the page');
  assert.match(html, /claude mcp add/, 'copy-paste client instructions');
  assert.match(html, /\/mcp/, 'instructions point at the mcp endpoint');

  const principal = r.routerDb.prepare('SELECT principal FROM cards ORDER BY rowid DESC LIMIT 1').get().principal;
  assert.match(principal, /^agent-[0-9a-f]{8}$/, 'a fresh anonymous principal');
  const mandate = r.routerDb.prepare('SELECT budget_usd FROM mandates WHERE principal = ?').get(principal);
  assert.equal(mandate.budget_usd, 20, 'the granted standing budget');
  const tok = r.routerDb.prepare('SELECT principal, revoked_at FROM tokens ORDER BY rowid DESC LIMIT 1').get();
  assert.equal(tok.principal, principal);
  assert.equal(tok.revoked_at, null);

  // and the issued token actually authenticates against /mcp
  const { resolveToken } = await import('../dist/auth.js');
  assert.equal(resolveToken(r.routerDb, `Bearer ${token}`).principal, principal);
});

test('T15d: replaying a used session issues nothing new', async (t) => {
  const stripe = fakeSetupStripe();
  const r = await startInvokeRouter({ setupStripeImpl: stripe });
  t.after(r.close);
  await fetch(`${r.baseUrl}/setup/complete?session_id=cs_test_setup_1`);
  const before = r.routerDb.prepare('SELECT COUNT(*) AS n FROM tokens').get().n;
  const replay = await fetch(`${r.baseUrl}/setup/complete?session_id=cs_test_setup_1`);
  const html = await replay.text();
  assert.equal(r.routerDb.prepare('SELECT COUNT(*) AS n FROM tokens').get().n, before, 'no second token');
  assert.ok(!/402r_[0-9a-f]{48}/.test(html), 'the token is never shown twice');
});

test('T15e: an unfinished session issues nothing', async (t) => {
  const stripe = fakeSetupStripe({ status: 'open' });
  const r = await startInvokeRouter({ setupStripeImpl: stripe });
  t.after(r.close);
  const res = await fetch(`${r.baseUrl}/setup/complete?session_id=cs_test_setup_1`);
  const html = await res.text();
  assert.ok(!/402r_/.test(html), 'no token material');
  assert.equal(r.routerDb.prepare('SELECT COUNT(*) AS n FROM tokens').get().n, 0);
});

test('T15f: /health answers without auth for the platform healthcheck', async (t) => {
  const r = await startInvokeRouter();
  t.after(r.close);
  const res = await fetch(`${r.baseUrl}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
});

test('T15g: without Stripe the setup surface degrades to 503, not a crash', async (t) => {
  process.env.STRIPE_SECRET_KEY = '';
  const r = await startInvokeRouter();
  t.after(async () => {
    delete process.env.STRIPE_SECRET_KEY;
    await r.close();
  });
  const res = await fetch(`${r.baseUrl}/setup`);
  assert.equal(res.status, 503);
});
