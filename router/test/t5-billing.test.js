import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createBilling, BillingError } from '../dist/billing/stripe.js';

// Live calls against the Stripe TEST API. Amounts stay at the $0.50 minimum.
// Skipped when no key is exported (e.g. CI without repo secrets), mirroring
// the root suite's PARTNER_GATEWAY_SECRET convention.
const SKIP = { skip: !process.env.STRIPE_SECRET_KEY && 'requires STRIPE_SECRET_KEY env var' };
const TIMEOUT = 30_000;

const NON_TERMINAL = new Set([
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'requires_capture'
]);

// Every PaymentIntent these tests create must end in a terminal state
// (succeeded or canceled) so no authorization is left dangling on the account.
async function ensureTerminal(billing, paymentIntentId) {
  if (!paymentIntentId) return;
  try {
    const { status } = await billing.retrieve(paymentIntentId);
    if (NON_TERMINAL.has(status)) await billing.void(paymentIntentId);
  } catch {
    // Teardown must never mask the assertion failure that mattered.
  }
}

describe('T5: card billing (Stripe PaymentIntents, manual capture)', SKIP, () => {
  it('authorize() clamps a sub-minimum quote to the $0.50 Stripe floor', { timeout: TIMEOUT }, async (t) => {
    const billing = createBilling();

    const auth = await billing.authorize(0.3);
    t.after(() => ensureTerminal(billing, auth.paymentIntentId));

    assert.equal(auth.status, 'requires_capture');
    assert.equal(auth.amountCents, 50);
    assert.equal(auth.quotedUsd, 0.3);
    assert.equal(auth.chargedUsd, 0.5);
    assert.ok(
      typeof auth.paymentIntentId === 'string' && auth.paymentIntentId.startsWith('pi_'),
      'authorization carries a PaymentIntent id'
    );
  });

  it('authorize() then capture() settles the authorization', { timeout: TIMEOUT }, async (t) => {
    const billing = createBilling();

    const auth = await billing.authorize(0.5);
    t.after(() => ensureTerminal(billing, auth.paymentIntentId));
    assert.equal(auth.status, 'requires_capture');
    assert.equal(auth.amountCents, 50);

    const captured = await billing.capture(auth.paymentIntentId);
    assert.equal(captured.status, 'succeeded');
  });

  it('authorize() then void() cancels the authorization', { timeout: TIMEOUT }, async (t) => {
    const billing = createBilling();

    const auth = await billing.authorize(0.5);
    t.after(() => ensureTerminal(billing, auth.paymentIntentId));
    assert.equal(auth.status, 'requires_capture');

    const voided = await billing.void(auth.paymentIntentId);
    assert.equal(voided.status, 'canceled');

    const fetched = await billing.retrieve(auth.paymentIntentId);
    assert.equal(fetched.status, 'canceled');
    assert.equal(fetched.amountCents, 50);
  });

  it('a declined card surfaces as BillingError with code DECLINED', { timeout: TIMEOUT }, async (t) => {
    const billing = createBilling();
    let declinedIntentId;

    await assert.rejects(
      () => billing.authorize(0.5, { paymentMethod: 'pm_card_visa_chargeDeclined' }),
      (err) => {
        assert.ok(err instanceof BillingError, 'decline must surface as BillingError');
        assert.equal(err.code, 'DECLINED');
        declinedIntentId = err.paymentIntentId;
        return true;
      }
    );

    t.after(() => ensureTerminal(billing, declinedIntentId));
  });
});
