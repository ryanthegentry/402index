import type { Database } from 'better-sqlite3';

// The five known payments of 2026-07-28/29, so the ledger reconciles against
// the wallet from its first run. Three exist as unlabelled rows (updated by
// upstream+sats match); the two pre-ledger T0 payments are inserted. Safe to
// run repeatedly.

const LF = 'https://lightningfaucet.com/api/l402/llm-prompt';

const HISTORY = [
  { sats: 581, upstream: LF, delivered: 0, reason: 'T0 #1 — paid, gateway delivered to a dead client socket, credit burned', insert: true },
  { sats: 581, upstream: LF, delivered: 1, reason: null, insert: true },
  { sats: 403, upstream: 'https://llm402.ai/v1/chat/completions/claude-fable-5%3Abatch', delivered: 0, reason: 'upstream returned 502 after settlement', insert: false },
  { sats: 1206, upstream: 'https://llm402.ai/v1/chat/completions/claude-opus-4.7-fast', delivered: 0, reason: 'upstream returned 502 after settlement', insert: false },
  { sats: 581, upstream: LF, delivered: 1, reason: null, insert: false }
];

export function backfillJuly29(db: Database): void {
  const markExisting = db.prepare(`
    UPDATE spend_ledger SET
      rail = 'l402', network = 'lightning', route = 'l402space', adapter = 'golem',
      settled_sats = sats - 1, fee_sats = 1,
      delivered = @delivered,
      loss_sats = CASE WHEN @delivered = 1 THEN 0 ELSE sats END,
      failure_reason = @reason,
      settled_at = COALESCE(settled_at, created_at),
      resolved_at = COALESCE(resolved_at, created_at)
    WHERE id = (
      SELECT id FROM spend_ledger
      WHERE upstream = @upstream AND sats = @sats AND route IS NULL
      ORDER BY id LIMIT 1
    )
  `);
  const insertT0 = db.prepare(`
    INSERT INTO spend_ledger
      (sats, upstream, rail, network, route, adapter, settled_sats, fee_sats,
       delivered, loss_sats, failure_reason, settled_at, resolved_at, created_at)
    VALUES
      (@sats, @upstream, 'l402', 'lightning', 'l402space', 'golem', @sats - 1, 1,
       @delivered, CASE WHEN @delivered = 1 THEN 0 ELSE @sats END, @reason,
       '2026-07-29 03:40:00', '2026-07-29 03:45:00', '2026-07-29 03:40:00')
  `);
  const t0Count = db
    .prepare("SELECT COUNT(*) AS n FROM spend_ledger WHERE settled_at LIKE '2026-07-29 03:4%'")
    .get() as { n: number };

  const run = db.transaction(() => {
    for (const row of HISTORY.filter((r) => !r.insert)) markExisting.run(row);
    if (t0Count.n === 0) {
      for (const row of HISTORY.filter((r) => r.insert)) insertT0.run(row);
    }
  });
  run();
}

export function parseGolemBalance(stdout: string): number | null {
  const m = /Available:\s+([\d,]+) sats/.exec(stdout);
  return m ? Number(m[1].replaceAll(',', '')) : null;
}

export function computeReconciliation(input: { ledgerSats: number; baselineSats: number; walletSats: number }) {
  const walletDelta = input.baselineSats - input.walletSats;
  return {
    walletDelta,
    ledgerSats: input.ledgerSats,
    match: walletDelta === input.ledgerSats,
    discrepancy: Math.abs(walletDelta - input.ledgerSats)
  };
}
