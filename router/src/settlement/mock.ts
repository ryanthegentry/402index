import { createHash } from 'node:crypto';
import type { PaymentRequest, Settlement, SettlementAdapter } from './index.js';
import { decodeInvoice } from './index.js';

// Deterministic synthetic settlement: same request, same proof, zero funds
// moved. The proof is sha256 of the raw payment material, well-formed but
// never valid upstream — synthetic legs are marked by movesRealFunds, never
// by forging a credential.
export function createMockSettlement(): SettlementAdapter {
  async function pay(req: PaymentRequest): Promise<Settlement> {
    const proof = createHash('sha256').update(req.raw).digest('hex');
    const paidSats = req.amountSats ?? 0;
    return {
      proof,
      proofKind: req.rail === 'l402' ? 'preimage' : 'txhash',
      paidSats,
      paidAmount: req.amount,
      feeSats: 0,
      durationMs: 1,
      preimage: proof
    };
  }
  return {
    name: 'mock',
    rails: ['l402', 'x402'],
    networks: ['*'],
    minSats: 0,
    movesRealFunds: false,
    canSettle: (req) => req.rail === 'l402' || req.rail === 'x402',
    pay,
    async payInvoice(invoice: string): Promise<Settlement> {
      const { amountSats } = decodeInvoice(invoice);
      return pay({
        rail: 'l402', network: 'lightning', asset: 'BTC',
        amount: String(amountSats), amountSats, payTo: null,
        credential: '', raw: invoice, expiresAt: null
      });
    }
  };
}
