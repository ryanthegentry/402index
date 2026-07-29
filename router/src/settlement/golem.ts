import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { PaymentRequest, Settlement, SettlementAdapter } from './index.js';
import { SettlementError, decodeInvoice } from './index.js';

// Pays a bolt11 invoice by spawning the local Golem CLI (Ark → Boltz →
// Lightning submarine swap). Two constraints learned the hard way in T0:
//  - Boltz refuses swaps under 333 sats, so anything smaller fails pre-flight.
//  - The CLI truncates the preimage to 8 chars on stdout and never exits on
//    its own (open Ark connection); the full preimage is read from Golem's
//    boltz-swaps.db afterwards and the child is killed once stdout settles.

export const BOLTZ_MIN_SATS = 333;
const CLI_TIMEOUT_MS = 120_000;

export interface SpawnResult {
  stdout: string;
  exitCode: number;
}

export interface GolemSettlementOptions {
  golemCliDir: string;
  swapsDbPath?: string;
  spawnImpl?: (invoice: string, maxSats: number) => Promise<SpawnResult>;
}

function defaultSpawn(golemCliDir: string) {
  return (invoice: string, maxSats: number): Promise<SpawnResult> =>
    new Promise((resolve, reject) => {
      const child = spawn('node', ['dist/cli/index.js', 'pay', invoice, '--max-price', String(maxSats)], {
        cwd: golemCliDir,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let out = '';
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill('SIGKILL');
        fn();
      };
      const timer = setTimeout(
        () => finish(() => reject(new SettlementError('PAY_FAILED', `golem pay timed out after ${CLI_TIMEOUT_MS}ms; output: ${out.slice(-300)}`))),
        CLI_TIMEOUT_MS
      );
      const onData = (chunk: Buffer) => {
        out += chunk.toString();
        // stdout is the completion signal — the CLI process never exits on its own
        if (/Payment sent!/.test(out) && /Balance:/.test(out)) finish(() => resolve({ stdout: out, exitCode: 0 }));
        else if (/^Error:/m.test(out)) finish(() => resolve({ stdout: out, exitCode: 1 }));
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', (err) => finish(() => reject(new SettlementError('PAY_FAILED', `golem spawn failed: ${err.message}`))));
      child.on('exit', (code) => finish(() => resolve({ stdout: out, exitCode: code ?? 1 })));
    });
}

function readPreimage(swapsDbPath: string, invoice: string): { preimage: string; expectedAmount: number } | null {
  let db: Database.Database;
  try {
    db = new Database(swapsDbPath, { readonly: true });
  } catch {
    return null; // unreadable swaps db reads as "no proof", never as success
  }
  try {
    const rows = db
      .prepare("SELECT data FROM boltz_swaps WHERE type = 'submarine' ORDER BY created_at DESC LIMIT 20")
      .all() as { data: string }[];
    for (const row of rows) {
      const data = JSON.parse(row.data) as {
        preimage?: string;
        request?: { invoice?: string };
        response?: { expectedAmount?: number };
      };
      if (data.request?.invoice === invoice && data.preimage) {
        return { preimage: data.preimage, expectedAmount: data.response?.expectedAmount ?? 0 };
      }
    }
    return null;
  } finally {
    db.close();
  }
}

export function createGolemSettlement(opts: GolemSettlementOptions): SettlementAdapter {
  const swapsDbPath =
    opts.swapsDbPath ?? join(process.env.HOME || '', '.golem', 'data', 'boltz-swaps.db');
  const spawnImpl = opts.spawnImpl ?? defaultSpawn(opts.golemCliDir);

  async function payBolt11(invoice: string, payOpts: { maxSats: number }): Promise<Settlement> {
    const { amountSats, paymentHash } = decodeInvoice(invoice);
    if (amountSats < BOLTZ_MIN_SATS) {
      throw new SettlementError('BELOW_MIN', `invoice of ${amountSats} sats is under the Boltz floor of ${BOLTZ_MIN_SATS}`);
    }
    if (amountSats > payOpts.maxSats) {
      throw new SettlementError('OVER_MAX', `invoice of ${amountSats} sats exceeds maxSats ${payOpts.maxSats}`);
    }

    const started = Date.now();
    const result = await spawnImpl(invoice, payOpts.maxSats);
    if (result.exitCode !== 0 || !/Payment sent!/.test(result.stdout)) {
      const errLine = /^Error:.*$/m.exec(result.stdout)?.[0] ?? result.stdout.slice(-300);
      throw new SettlementError('PAY_FAILED', `golem pay failed: ${errLine}`);
    }

    const swap = readPreimage(swapsDbPath, invoice);
    if (!swap || createHash('sha256').update(Buffer.from(swap.preimage, 'hex')).digest('hex') !== paymentHash) {
      throw new SettlementError(
        'PREIMAGE_UNAVAILABLE',
        swap ? 'swaps-db preimage does not hash to the invoice payment hash' : 'no swap record found for the paid invoice'
      );
    }

    return {
      proof: swap.preimage,
      proofKind: 'preimage',
      preimage: swap.preimage,
      paidSats: amountSats,
      paidAmount: String(amountSats),
      feeSats: swap.expectedAmount ? swap.expectedAmount - amountSats : 0,
      durationMs: Date.now() - started
    };
  }

  return {
    name: 'golem',
    rails: ['l402'],
    networks: ['lightning'],
    minSats: BOLTZ_MIN_SATS,
    movesRealFunds: true,
    canSettle: (req: PaymentRequest) =>
      req.rail === 'l402' && req.network === 'lightning' && req.amountSats !== null,
    pay: (req: PaymentRequest, payOpts: { maxSats: number }) => payBolt11(req.raw, payOpts),
    payInvoice: payBolt11
  };
}
