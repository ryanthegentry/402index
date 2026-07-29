import { createHash } from 'node:crypto';
import type { SettlementAdapter } from './index.js';
import { decodeInvoice } from './index.js';

// Deterministic synthetic settlement: same invoice, same preimage, zero sats
// moved. The preimage is sha256 of the invoice string, so it is well-formed
// but will NOT hash to the invoice's payment hash — receipts mark the leg
// as synthetic via adapter name, never by forging a valid preimage.
export function createMockSettlement(): SettlementAdapter {
  return {
    name: 'mock',
    minSats: 0,
    async payInvoice(invoice: string) {
      const { amountSats } = decodeInvoice(invoice);
      return {
        preimage: createHash('sha256').update(invoice).digest('hex'),
        paidSats: amountSats,
        feeSats: 0,
        durationMs: 1
      };
    }
  };
}
