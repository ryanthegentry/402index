import type { Database } from 'better-sqlite3';

// Spend caps for real sats. checkJob() must be called before any money moves;
// recordSpend() after settlement succeeds. The ledger is persisted so the
// cumulative cap survives restarts.
type GuardCode = 'JOB_CAP' | 'TOTAL_CAP' | 'PRINCIPAL_JOB_CAP' | 'PRINCIPAL_TOTAL_CAP';

export class GuardError extends Error {
  code: GuardCode;
  constructor(code: GuardCode, message: string) {
    super(message);
    this.name = 'GuardError';
    this.code = code;
  }
}

export interface GuardLimits {
  maxSatsPerJob: number;
  maxTotalSats: number;
}

// Resolved per-request from the bearer token (overrides) or config (defaults).
export interface PrincipalLimits {
  principal: string;
  maxSatsPerJob: number;
  maxTotalSats: number;
}

export function createGuards(db: Database, limits: GuardLimits) {
  const sumStmt = db.prepare('SELECT COALESCE(SUM(sats), 0) AS total FROM spend_ledger');
  const principalSumStmt = db.prepare('SELECT COALESCE(SUM(sats), 0) AS total FROM spend_ledger WHERE principal = ?');
  const insertStmt = db.prepare('INSERT INTO spend_ledger (sats, upstream) VALUES (?, ?)');

  function totalSpent(): number {
    return (sumStmt.get() as { total: number }).total;
  }

  return {
    totalSpent,
    checkJob(sats: number, forPrincipal?: PrincipalLimits): void {
      if (sats > limits.maxSatsPerJob) {
        throw new GuardError('JOB_CAP', `job of ${sats} sats exceeds per-job cap ${limits.maxSatsPerJob}`);
      }
      const total = totalSpent();
      if (total + sats > limits.maxTotalSats) {
        throw new GuardError('TOTAL_CAP', `job of ${sats} sats would take total to ${total + sats}, over cap ${limits.maxTotalSats}`);
      }
      if (forPrincipal) {
        if (sats > forPrincipal.maxSatsPerJob) {
          throw new GuardError(
            'PRINCIPAL_JOB_CAP',
            `job of ${sats} sats exceeds principal "${forPrincipal.principal}" per-job cap ${forPrincipal.maxSatsPerJob}`
          );
        }
        const spent = (principalSumStmt.get(forPrincipal.principal) as { total: number }).total;
        if (spent + sats > forPrincipal.maxTotalSats) {
          throw new GuardError(
            'PRINCIPAL_TOTAL_CAP',
            `job of ${sats} sats would take principal "${forPrincipal.principal}" to ${spent + sats}, over cap ${forPrincipal.maxTotalSats}`
          );
        }
      }
    },
    recordSpend(sats: number, upstream: string): void {
      insertStmt.run(sats, upstream);
    }
  };
}
