import type { Database } from 'better-sqlite3';
import type { Route } from './routes/index.js';
import type { Ledger } from './ledger.js';

// A paid L402 credential is a bearer asset, not a receipt. We bought it with
// real sats; it stays valid after a failed delivery and can be redeemed
// again. The router persists it the moment settlement succeeds — before the
// redemption attempt — so a 502 can never destroy something we own.

export interface CredentialRecord {
  ledgerId: number | null;
  serviceId: string;
  upstream: string;
  route: string;
  redeemUrl: string;
  httpMethod: string;
  body: string | null;
  credential: string;
  proof: string;
  settledSats: number;
}

export interface StoredCredential extends Record<string, unknown> {
  id: number;
  ledger_id: number | null;
  upstream: string;
  route: string;
  redeem_url: string;
  http_method: string;
  body: string | null;
  credential: string;
  proof: string;
  settled_sats: number;
  redeemed: number;
  attempts: number;
  last_error: string | null;
}

export function createCredentials(db: Database) {
  const insert = db.prepare(`
    INSERT INTO paid_credentials
      (ledger_id, service_id, upstream, route, redeem_url, http_method, body,
       credential, proof, settled_sats, redeemed, attempts, paid_at)
    VALUES
      (@ledgerId, @serviceId, @upstream, @route, @redeemUrl, @httpMethod, @body,
       @credential, @proof, @settledSats, 0, 0, datetime('now'))
  `);
  return {
    record(rec: CredentialRecord): number {
      return Number(insert.run(rec as unknown as Record<string, unknown>).lastInsertRowid);
    },
    markRedeemed(id: number): void {
      db.prepare("UPDATE paid_credentials SET redeemed = 1, redeemed_at = datetime('now') WHERE id = ?").run(id);
    },
    recordAttempt(id: number, error: string): void {
      db.prepare(
        "UPDATE paid_credentials SET attempts = attempts + 1, last_error = ?, last_attempt_at = datetime('now') WHERE id = ?"
      ).run(error, id);
    },
    unredeemed(): StoredCredential[] {
      return db
        .prepare('SELECT * FROM paid_credentials WHERE redeemed = 0 ORDER BY id')
        .all() as StoredCredential[];
    },
    get(id: number): StoredCredential {
      return db.prepare('SELECT * FROM paid_credentials WHERE id = ?').get(id) as StoredCredential;
    }
  };
}

export type Credentials = ReturnType<typeof createCredentials>;

// Re-attempts every credential we paid for but never redeemed. A recovery
// repairs the ledger row too: the job did deliver, so the absorbed loss goes
// back to zero.
export async function retryUnredeemed(deps: {
  db: Database;
  ledger: Ledger;
  creds: Credentials;
  routes: Route[];
  fetchImpl: typeof fetch;
  timeoutMs: number;
}): Promise<{ id: number; upstream: string; settledSats: number; delivered: boolean; detail: string }[]> {
  const out: { id: number; upstream: string; settledSats: number; delivered: boolean; detail: string }[] = [];
  for (const row of deps.creds.unredeemed()) {
    const route = deps.routes.find((r) => r.name === row.route) ?? deps.routes[0];
    let delivered = false;
    let detail = '';
    try {
      const res = await route.redeem(
        { redeem_url: row.redeem_url, http_method: row.http_method, body: row.body, credential: row.credential },
        { proof: row.proof },
        { timeoutMs: deps.timeoutMs, fetchImpl: deps.fetchImpl }
      );
      delivered = res.ok;
      detail = delivered ? (await res.text()).slice(0, 200) : `upstream returned ${res.status}`;
    } catch (err) {
      detail = `upstream unreachable: ${(err as Error).message}`;
    }

    if (delivered) {
      deps.creds.markRedeemed(row.id);
      if (row.ledger_id !== null) {
        deps.ledger.recordDelivery(row.ledger_id, { delivered: true, failureReason: undefined });
      }
    } else {
      deps.creds.recordAttempt(row.id, detail);
    }
    out.push({ id: row.id, upstream: row.upstream, settledSats: row.settled_sats, delivered, detail });
  }
  return out;
}
