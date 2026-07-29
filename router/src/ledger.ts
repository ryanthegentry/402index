import type { Database } from 'better-sqlite3';

// The loss ledger: one row per underwritten job, written twice. The first
// write happens the instant money leaves the wallet — before the delivery
// attempt — so the spend cap counts in-flight jobs. The second write records
// the outcome. `sats` (= settledSats + feeSats) stays the wallet-outflow
// column that guards.totalSpent() sums; loss_sats books what the router
// absorbed when a paid job did not deliver.

export interface SettlementRecord {
  serviceId: string;
  upstream: string;
  rail: string;
  network: string;
  route: string;
  adapter: string;
  quotedSats: number;
  settledSats: number;
  feeSats: number;
  chargedUsd: number | null;
  btcUsd: number | null;
  paymentIntent: string | null;
  jobNonce: string | null;
}

export interface DeliveryOutcome {
  delivered: boolean;
  latencyMs?: number;
  failureReason?: string;
  stageTimings?: Record<string, number>;
}

export interface LedgerSummary {
  totalSats: number;
  lossSats: number;
  lossRate: number;
  perRoute: { route: string; jobs: number; delivered: number; lost: number; inFlight: number; sats: number; lossSats: number }[];
}

export function createLedger(db: Database) {
  const insert = db.prepare(`
    INSERT INTO spend_ledger
      (sats, upstream, service_id, rail, network, route, adapter,
       quoted_sats, settled_sats, fee_sats, charged_usd, btc_usd,
       payment_intent, job_nonce, delivered, loss_sats, settled_at)
    VALUES
      (@sats, @upstream, @serviceId, @rail, @network, @route, @adapter,
       @quotedSats, @settledSats, @feeSats, @chargedUsd, @btcUsd,
       @paymentIntent, @jobNonce, NULL, 0, datetime('now'))
  `);
  const resolve = db.prepare(`
    UPDATE spend_ledger
    SET delivered = @delivered,
        loss_sats = CASE WHEN @delivered = 1 THEN 0 ELSE sats END,
        failure_reason = @failureReason,
        latency_ms = @latencyMs,
        stage_timings = @stageTimings,
        resolved_at = datetime('now')
    WHERE id = @id
  `);

  return {
    recordSettlement(rec: SettlementRecord): number {
      const result = insert.run({ ...rec, sats: rec.settledSats + rec.feeSats });
      return Number(result.lastInsertRowid);
    },

    recordDelivery(id: number, outcome: DeliveryOutcome): void {
      resolve.run({
        id,
        delivered: outcome.delivered ? 1 : 0,
        failureReason: outcome.failureReason ?? null,
        latencyMs: outcome.latencyMs ?? null,
        stageTimings: outcome.stageTimings ? JSON.stringify(outcome.stageTimings) : null
      });
    },

    unresolved(olderThanMs: number): { id: number; upstream: string; sats: number; settled_at: string }[] {
      return db
        .prepare(
          `SELECT id, upstream, sats, settled_at FROM spend_ledger
           WHERE delivered IS NULL AND settled_at IS NOT NULL
             AND settled_at < datetime('now', ?)
           ORDER BY id`
        )
        .all(`-${Math.floor(olderThanMs / 1000)} seconds`) as {
        id: number; upstream: string; sats: number; settled_at: string;
      }[];
    },

    summary(): LedgerSummary {
      const totals = db
        .prepare('SELECT COALESCE(SUM(sats),0) AS total, COALESCE(SUM(loss_sats),0) AS loss FROM spend_ledger')
        .get() as { total: number; loss: number };
      const perRoute = db
        .prepare(
          `SELECT COALESCE(route, 'unknown') AS route,
                  COUNT(*) AS jobs,
                  SUM(CASE WHEN delivered = 1 THEN 1 ELSE 0 END) AS delivered,
                  SUM(CASE WHEN delivered = 0 THEN 1 ELSE 0 END) AS lost,
                  SUM(CASE WHEN delivered IS NULL THEN 1 ELSE 0 END) AS inFlight,
                  COALESCE(SUM(sats),0) AS sats,
                  COALESCE(SUM(loss_sats),0) AS lossSats
           FROM spend_ledger GROUP BY COALESCE(route, 'unknown') ORDER BY route`
        )
        .all() as LedgerSummary['perRoute'];
      return {
        totalSats: totals.total,
        lossSats: totals.loss,
        lossRate: totals.total > 0 ? totals.loss / totals.total : 0,
        perRoute
      };
    }
  };
}

export type Ledger = ReturnType<typeof createLedger>;
