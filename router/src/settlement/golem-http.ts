import { createHash } from 'node:crypto';
import type { PaymentRequest, Settlement, SettlementAdapter } from './index.js';
import { SettlementError, decodeInvoice } from './index.js';
import { BOLTZ_MIN_SATS } from './golem.js';

// Pays a bolt11 invoice over POST /api/pay-invoice on Golem's hosted server
// (PRD D6/D7) — the transport a Railway-hosted router uses instead of
// spawning the CLI. Same SettlementAdapter contract, same Boltz floor, same
// discipline: the preimage that comes back over the wire is verified locally
// against the invoice's payment hash before it is trusted as proof.

const HTTP_TIMEOUT_MS = 120_000; // a Boltz swap runs ~8s; leave the same headroom the CLI gets

export interface GolemHttpOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createGolemHttpSettlement(opts: GolemHttpOptions): SettlementAdapter {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? HTTP_TIMEOUT_MS;
  const endpoint = `${opts.baseUrl.replace(/\/$/, '')}/api/pay-invoice`;

  async function payBolt11(invoice: string, payOpts: { maxSats: number }): Promise<Settlement> {
    const { amountSats, paymentHash } = decodeInvoice(invoice);
    if (amountSats < BOLTZ_MIN_SATS) {
      throw new SettlementError('BELOW_MIN', `invoice of ${amountSats} sats is under the Boltz floor of ${BOLTZ_MIN_SATS}`);
    }
    if (amountSats > payOpts.maxSats) {
      throw new SettlementError('OVER_MAX', `invoice of ${amountSats} sats exceeds maxSats ${payOpts.maxSats}`);
    }

    const started = Date.now();
    let res: Response;
    try {
      res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ invoice, maxSats: payOpts.maxSats }),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      throw new SettlementError('PAY_FAILED', `pay-invoice unreachable: ${(err as Error).message}`);
    }

    let body: { preimage?: string; amountSats?: number; txid?: string; error?: string; code?: string; paid?: boolean } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // non-JSON body; the status handling below carries the failure
    }

    if (!res.ok) {
      // paid:true on ANY refusal — mismatch, timeout, ambiguous — means sats
      // may have left the wallet with no usable proof: the error class the
      // ledger treats as an outflow, never as a clean refusal.
      if (body.paid) {
        throw new SettlementError(
          'PREIMAGE_UNAVAILABLE',
          `pay-invoice reports funds may have moved without proof (${body.code ?? 'no code'}): ${body.error ?? 'no detail'}`
        );
      }
      throw new SettlementError('PAY_FAILED', `pay-invoice returned ${res.status} (${body.code ?? 'no code'}): ${body.error ?? 'no detail'}`);
    }

    const preimage = body.preimage ?? '';
    if (createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex') !== paymentHash) {
      throw new SettlementError('PREIMAGE_UNAVAILABLE', 'wire preimage does not hash to the invoice payment hash');
    }

    // amountSats on the wire is what the wallet actually paid (swap fee
    // included); the ledger's `sats` column must equal wallet outflow.
    const wireAmount = body.amountSats ?? amountSats;
    return {
      proof: preimage,
      proofKind: 'preimage',
      preimage,
      paidSats: amountSats,
      paidAmount: String(amountSats),
      feeSats: Math.max(0, wireAmount - amountSats),
      durationMs: Date.now() - started
    };
  }

  return {
    name: 'golem-http',
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
