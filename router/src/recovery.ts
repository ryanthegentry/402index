import type { Database } from 'better-sqlite3';
import { retryUnredeemed, type Credentials } from './credentials.js';
import type { Ledger } from './ledger.js';
import type { Route } from './routes/index.js';

// Scheduled recovery of paid-but-unredeemed credentials (D5). It costs
// nothing — no settlement, no card — and a provider that recovered turns an
// absorbed loss back into a delivered job, repairing the ledger row. Runs
// in-process; a pass still in flight is never overlapped, and a failed pass
// is logged and survived, never fatal to the server.

export interface RecoveryScheduleDeps {
  db: Database;
  ledger: Ledger;
  creds: Credentials;
  routes: Route[];
  fetchImpl: typeof fetch;
  intervalMs: number;
  timeoutMs?: number;
  log?: (line: string) => void;
}

export function startRecoverySchedule(deps: RecoveryScheduleDeps): { stop(): void } {
  const log = deps.log ?? console.log;
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const results = await retryUnredeemed({
        db: deps.db,
        ledger: deps.ledger,
        creds: deps.creds,
        routes: deps.routes,
        fetchImpl: deps.fetchImpl,
        timeoutMs: deps.timeoutMs ?? 300_000
      });
      if (results.length > 0) {
        const recovered = results.filter((r) => r.delivered);
        const sats = recovered.reduce((n, r) => n + r.settledSats, 0);
        log(`[recovery] retried ${results.length} credential(s): ${recovered.length} delivered, recovered ${sats} sats`);
      }
    } catch (err) {
      log(`[recovery] pass failed: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), deps.intervalMs);
  return {
    stop() {
      clearInterval(timer);
    }
  };
}
