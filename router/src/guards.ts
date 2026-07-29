import type { Database } from 'better-sqlite3';

// Spend caps for real sats. checkJob() must be called before any money moves;
// recordSpend() after settlement succeeds. The ledger is persisted so the
// cumulative cap survives restarts.
export class GuardError extends Error {
  code: 'JOB_CAP' | 'TOTAL_CAP';
  constructor(code: 'JOB_CAP' | 'TOTAL_CAP', message: string) {
    super(message);
    this.name = 'GuardError';
    this.code = code;
  }
}

export interface GuardLimits {
  maxSatsPerJob: number;
  maxTotalSats: number;
}

export function createGuards(db: Database, limits: GuardLimits) {
  const sumStmt = db.prepare('SELECT COALESCE(SUM(sats), 0) AS total FROM spend_ledger');
  const insertStmt = db.prepare('INSERT INTO spend_ledger (sats, upstream) VALUES (?, ?)');

  function totalSpent(): number {
    return (sumStmt.get() as { total: number }).total;
  }

  return {
    totalSpent,
    checkJob(sats: number): void {
      if (sats > limits.maxSatsPerJob) {
        throw new GuardError('JOB_CAP', `job of ${sats} sats exceeds per-job cap ${limits.maxSatsPerJob}`);
      }
      const total = totalSpent();
      if (total + sats > limits.maxTotalSats) {
        throw new GuardError('TOTAL_CAP', `job of ${sats} sats would take total to ${total + sats}, over cap ${limits.maxTotalSats}`);
      }
    },
    recordSpend(sats: number, upstream: string): void {
      insertStmt.run(sats, upstream);
    }
  };
}
