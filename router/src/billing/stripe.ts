import Stripe from 'stripe';

/** Stripe rejects USD charges below $0.50. */
export const MIN_CHARGE_CENTS = 50;

export interface Authorization {
  paymentIntentId: string;
  status: string;
  amountCents: number;
  /** What the quote said the job costs. */
  quotedUsd: number;
  /** What the card was actually authorized for (quote clamped to the Stripe floor). */
  chargedUsd: number;
}

export class BillingError extends Error {
  readonly code: 'DECLINED' | 'API';
  /** Set when Stripe attached a PaymentIntent to the failure, so callers can cancel it. */
  readonly paymentIntentId?: string;

  constructor(code: 'DECLINED' | 'API', message: string, paymentIntentId?: string) {
    super(message);
    this.name = 'BillingError';
    this.code = code;
    this.paymentIntentId = paymentIntentId;
  }
}

export interface Billing {
  authorize(quotedUsd: number, opts?: { paymentMethod?: string }): Promise<Authorization>;
  capture(paymentIntentId: string): Promise<{ status: string }>;
  void(paymentIntentId: string): Promise<{ status: string }>;
  retrieve(paymentIntentId: string): Promise<{ status: string; amountCents: number }>;
}

function toBillingError(err: unknown): BillingError {
  if (err instanceof BillingError) return err;
  if (err instanceof Stripe.errors.StripeError) {
    const declined = err instanceof Stripe.errors.StripeCardError || err.rawType === 'card_error';
    return new BillingError(declined ? 'DECLINED' : 'API', err.message, err.payment_intent?.id);
  }
  return new BillingError('API', err instanceof Error ? err.message : String(err));
}

export function createBilling(secretKey: string = process.env.STRIPE_SECRET_KEY || ''): Billing {
  if (!secretKey) throw new BillingError('API', 'STRIPE_SECRET_KEY is not set');

  const stripe = new Stripe(secretKey, {
    apiVersion: Stripe.API_VERSION as Stripe.LatestApiVersion,
    typescript: true
  });

  return {
    async authorize(quotedUsd, opts = {}) {
      const amountCents = Math.max(Math.round(quotedUsd * 100), MIN_CHARGE_CENTS);
      try {
        const intent = await stripe.paymentIntents.create({
          amount: amountCents,
          currency: 'usd',
          payment_method_types: ['card'],
          capture_method: 'manual',
          payment_method: opts.paymentMethod ?? 'pm_card_visa',
          confirm: true
        });
        return {
          paymentIntentId: intent.id,
          status: intent.status,
          amountCents,
          quotedUsd,
          chargedUsd: amountCents / 100
        };
      } catch (err) {
        throw toBillingError(err);
      }
    },

    async capture(paymentIntentId) {
      try {
        const intent = await stripe.paymentIntents.capture(paymentIntentId);
        return { status: intent.status };
      } catch (err) {
        throw toBillingError(err);
      }
    },

    async void(paymentIntentId) {
      try {
        const intent = await stripe.paymentIntents.cancel(paymentIntentId);
        return { status: intent.status };
      } catch (err) {
        throw toBillingError(err);
      }
    },

    async retrieve(paymentIntentId) {
      try {
        const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
        return { status: intent.status, amountCents: intent.amount };
      } catch (err) {
        throw toBillingError(err);
      }
    }
  };
}
