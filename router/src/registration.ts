import Stripe from 'stripe';
import type { Database } from 'better-sqlite3';

// In-loop card registration. First contact with a cardless agent mints a real
// Stripe Checkout URL (setup mode) inside the MCP loop; the agent's next call
// polls the session and, once the human finished the hosted page, stores the
// saved payment method as the card on file. Requires SetupIntents Write +
// Checkout Sessions Write on the (still restricted) key — verified live
// 2026-07-29.

interface StripeLike {
  customers: {
    create(params?: Record<string, unknown>): Promise<{ id: string }>;
  };
  checkout: {
    sessions: {
      create(params: Record<string, unknown>): Promise<{ id: string; url: string | null; status: string | null }>;
      retrieve(id: string): Promise<{
        id: string;
        status: string | null;
        customer?: string | { id: string } | null;
        setup_intent: string | { id: string } | null;
      }>;
      expire?(id: string): Promise<unknown>;
    };
  };
  setupIntents: {
    retrieve(id: string): Promise<{ payment_method: string | { id: string } | null }>;
  };
}

export interface Registration {
  checkoutUrlFor(principal: string): Promise<string>;
  completeIfRegistered(principal: string): Promise<boolean>;
  abandon(principal: string): Promise<void>;
}

export function createRegistration(
  db: Database,
  opts: { stripeSecretKey?: string; stripeImpl?: StripeLike; successUrl?: string }
): Registration {
  const stripe: StripeLike =
    opts.stripeImpl ?? (new Stripe(opts.stripeSecretKey ?? '') as unknown as StripeLike);
  const successUrl = opts.successUrl ?? 'https://402index.io/registered';
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_registrations (
      principal TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      checkout_url TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const getPending = db.prepare('SELECT session_id, checkout_url FROM pending_registrations WHERE principal = ?');
  const putPending = db.prepare('INSERT OR REPLACE INTO pending_registrations (principal, session_id, checkout_url) VALUES (?, ?, ?)');
  const dropPending = db.prepare('DELETE FROM pending_registrations WHERE principal = ?');
  const putCard = db.prepare('INSERT OR REPLACE INTO cards (principal, payment_method, customer) VALUES (?, ?, ?)');

  return {
    async checkoutUrlFor(principal: string): Promise<string> {
      const pending = getPending.get(principal) as { session_id: string; checkout_url: string } | undefined;
      if (pending) {
        const session = await stripe.checkout.sessions.retrieve(pending.session_id);
        if (session.status === 'open') return pending.checkout_url;
        dropPending.run(principal);
      }
      // Customer first, so Checkout attaches the card to it — an unattached
      // PaymentMethod cannot be charged on later invokes.
      const customer = await stripe.customers.create({
        metadata: { source: '402index-router-registration', principal }
      });
      const session = await stripe.checkout.sessions.create({
        mode: 'setup',
        customer: customer.id,
        payment_method_types: ['card'],
        client_reference_id: principal,
        success_url: successUrl
      });
      if (!session.url) throw new Error('Stripe returned a session without a hosted URL');
      putPending.run(principal, session.id, session.url);
      return session.url;
    },

    async completeIfRegistered(principal: string): Promise<boolean> {
      const pending = getPending.get(principal) as { session_id: string } | undefined;
      if (!pending) return false;
      const session = await stripe.checkout.sessions.retrieve(pending.session_id);
      if (session.status !== 'complete' || !session.setup_intent) return false;
      const setupIntentId = typeof session.setup_intent === 'string' ? session.setup_intent : session.setup_intent.id;
      const si = await stripe.setupIntents.retrieve(setupIntentId);
      const pm = typeof si.payment_method === 'string' ? si.payment_method : si.payment_method?.id;
      if (!pm) return false;
      const customerId =
        typeof session.customer === 'string' ? session.customer : (session.customer?.id ?? null);
      putCard.run(principal, pm, customerId);
      dropPending.run(principal);
      return true;
    },

    async abandon(principal: string): Promise<void> {
      const pending = getPending.get(principal) as { session_id: string } | undefined;
      if (!pending) return;
      try {
        await stripe.checkout.sessions.expire?.(pending.session_id);
      } catch {
        // an already-expired or completed session is fine; the row still goes
      }
      dropPending.run(principal);
    }
  };
}
