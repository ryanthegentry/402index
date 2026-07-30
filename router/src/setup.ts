import Stripe from 'stripe';
import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { issueToken } from './auth.js';

// The one human-interactive surface (D2/D9), visited once: card via Stripe
// Checkout in setup mode, a standing budget, and a bearer token with the
// `claude mcp add` line. Anonymous issuance — the principal is minted here,
// the token is rendered exactly once and stored only as a hash. Served by
// the router process because the tokens/cards/mandates tables live in its
// SQLite file, and SQLite has one writer; the main 402index app links here.

interface SetupStripeLike {
  customers: {
    create(params?: Record<string, unknown>): Promise<{ id: string }>;
  };
  checkout: {
    sessions: {
      create(params: Record<string, unknown>): Promise<{ id: string; url: string | null }>;
      retrieve(id: string): Promise<{
        id: string;
        status: string | null;
        customer?: string | { id: string } | null;
        metadata?: Record<string, string> | null;
        setup_intent: string | { id: string } | null;
      }>;
    };
  };
  setupIntents: {
    retrieve(id: string): Promise<{ payment_method: string | { id: string } | null }>;
  };
}

export interface SetupSurface {
  page(baseUrl: string): string;
  createSession(form: Record<string, unknown>, baseUrl: string): Promise<{ url: string }>;
  complete(sessionId: string, baseUrl: string): Promise<string>;
}

function htmlPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 640px; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; color: #1a1a1a; }
  code, pre { background: #f4f4f4; border-radius: 4px; padding: 2px 6px; font-size: 0.9em; }
  pre { padding: 12px; overflow-x: auto; }
  input { padding: 6px 8px; margin: 4px 0 12px; width: 8rem; display: block; }
  button { padding: 8px 16px; font-size: 1em; cursor: pointer; }
  .warn { background: #fff6e5; border: 1px solid #e8c98a; border-radius: 6px; padding: 10px 14px; }
</style>
</head>
<body>${body}</body>
</html>`;
}

export function createSetup(
  db: Database,
  opts: {
    stripeSecretKey?: string;
    stripeImpl?: SetupStripeLike;
    publicUrl?: string;
    tokenLimits?: { maxSatsPerJob?: number; maxTotalSats?: number };
  }
): SetupSurface {
  const stripe: SetupStripeLike =
    opts.stripeImpl ?? (new Stripe(opts.stripeSecretKey ?? '') as unknown as SetupStripeLike);
  db.exec(`
    CREATE TABLE IF NOT EXISTS setup_sessions (
      session_id TEXT PRIMARY KEY,
      principal TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const base = (reqBase: string) => (opts.publicUrl || reqBase).replace(/\/$/, '');

  return {
    page(reqBase: string): string {
      return htmlPage(
        '402index router — set up your agent',
        `<h1>Pay 402 endpoints from Claude Code — no wallet</h1>
<p>One visit: register a card, grant your agent a standing budget, get a token.
Your agent is charged only when a result is delivered, floored at $0.50 per job,
and it can read its own receipt.</p>
<form method="post" action="${base(reqBase)}/setup/session">
  <label>Standing budget (USD)
    <input type="number" name="budget_usd" value="20" min="1" max="500" step="1" required>
  </label>
  <label>Budget valid for (days)
    <input type="number" name="budget_days" value="30" min="1" max="90" step="1" required>
  </label>
  <button type="submit">Register card with Stripe (test mode)</button>
</form>
<p class="warn">Preview: Stripe runs in test mode — use card 4242&nbsp;4242&nbsp;4242&nbsp;4242. No real charges.</p>`
      );
    },

    async createSession(form: Record<string, unknown>, reqBase: string): Promise<{ url: string }> {
      const budgetUsd = Math.min(500, Math.max(1, Math.round(Number(form.budget_usd) || 20)));
      const budgetDays = Math.min(90, Math.max(1, Math.round(Number(form.budget_days) || 30)));
      // The Customer must exist before Checkout so the collected card is
      // ATTACHED to it — an unattached PaymentMethod cannot be charged later,
      // which is exactly how the first live walkthrough failed.
      const customer = await stripe.customers.create({
        metadata: { source: '402index-router-setup' }
      });
      const session = await stripe.checkout.sessions.create({
        mode: 'setup',
        customer: customer.id,
        payment_method_types: ['card'],
        metadata: { budget_usd: String(budgetUsd), budget_days: String(budgetDays) },
        success_url: `${base(reqBase)}/setup/complete?session_id={CHECKOUT_SESSION_ID}`
      });
      if (!session.url) throw new Error('Stripe returned a session without a hosted URL');
      return { url: session.url };
    },

    async complete(sessionId: string, reqBase: string): Promise<string> {
      const used = db.prepare('SELECT principal FROM setup_sessions WHERE session_id = ?').get(sessionId);
      if (used) {
        return htmlPage(
          'Already set up',
          `<h1>This session was already used</h1>
<p>The token was shown once and is not stored in a recoverable form. If you lost
it, run setup again from the start — the old token can be revoked on request.</p>`
        );
      }
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (session.status !== 'complete' || !session.setup_intent) {
        return htmlPage(
          'Not finished',
          `<h1>Card registration is not finished</h1>
<p>Complete the Stripe Checkout step, then follow its redirect back here.</p>`
        );
      }
      const setupIntentId =
        typeof session.setup_intent === 'string' ? session.setup_intent : session.setup_intent.id;
      const si = await stripe.setupIntents.retrieve(setupIntentId);
      const pm = typeof si.payment_method === 'string' ? si.payment_method : si.payment_method?.id;
      if (!pm) {
        return htmlPage('Not finished', '<h1>No payment method on the session yet</h1><p>Retry the Checkout step.</p>');
      }

      const customerId =
        typeof session.customer === 'string' ? session.customer : (session.customer?.id ?? null);
      const budgetUsd = Number(session.metadata?.budget_usd) || 20;
      const budgetDays = Number(session.metadata?.budget_days) || 30;
      const principal = `agent-${randomBytes(4).toString('hex')}`;
      db.prepare('INSERT INTO cards (principal, payment_method, customer) VALUES (?, ?, ?)').run(principal, pm, customerId);
      db.prepare(
        `INSERT INTO mandates (principal, budget_usd, spent_usd, expires_at) VALUES (?, ?, 0, datetime('now', ?))`
      ).run(principal, budgetUsd, `+${budgetDays} days`);
      const token = issueToken(db, principal, opts.tokenLimits ?? {});
      db.prepare('INSERT INTO setup_sessions (session_id, principal) VALUES (?, ?)').run(sessionId, principal);

      const mcpUrl = `${base(reqBase)}/mcp`;
      return htmlPage(
        'Your agent is ready',
        `<h1>Done — your agent can pay 402 endpoints</h1>
<p>Principal <code>${principal}</code>, standing budget $${budgetUsd} for ${budgetDays} days.</p>
<p class="warn"><strong>This token is shown once and never again.</strong> It is stored
only as a hash. Copy it now.</p>
<pre>${token}</pre>
<p>Add the router to Claude Code:</p>
<pre>claude mcp add --transport http 402index-router ${mcpUrl} \\
  --header "Authorization: Bearer ${token}"</pre>
<p>Then ask Claude to use the <code>invoke</code> tool. In-budget calls run with
zero interruptions; you are charged only on delivery.</p>`
      );
    }
  };
}
