import { decode as decodeBolt11 } from 'light-bolt11-decoder';
import { createGolemSettlement } from './golem.js';
import { createMockSettlement } from './mock.js';

export interface Settlement {
  preimage: string; // 64 hex chars
  paidSats: number;
  feeSats: number;
  durationMs: number;
}

export interface SettlementAdapter {
  name: 'golem' | 'mock';
  minSats: number; // smallest invoice this adapter can settle (Boltz floor for golem)
  payInvoice(invoice: string, opts: { maxSats: number }): Promise<Settlement>;
}

export class SettlementError extends Error {
  code: 'PAY_FAILED' | 'PREIMAGE_UNAVAILABLE' | 'BELOW_MIN' | 'OVER_MAX';
  constructor(code: SettlementError['code'], message: string) {
    super(message);
    this.name = 'SettlementError';
    this.code = code;
  }
}

export function decodeInvoice(invoice: string): { amountSats: number; paymentHash: string } {
  const decoded = decodeBolt11(invoice) as { sections: { name: string; value?: unknown }[] };
  const amountMsat = decoded.sections.find((s) => s.name === 'amount')?.value;
  const paymentHash = decoded.sections.find((s) => s.name === 'payment_hash')?.value;
  if (typeof amountMsat !== 'string' || typeof paymentHash !== 'string') {
    throw new SettlementError('PAY_FAILED', 'bolt11 invoice missing amount or payment hash');
  }
  return { amountSats: Number(amountMsat) / 1000, paymentHash };
}

export function selectAdapter(config: { settlementAdapter: 'golem' | 'mock'; golemCliDir: string }): SettlementAdapter {
  return config.settlementAdapter === 'mock'
    ? createMockSettlement()
    : createGolemSettlement({ golemCliDir: config.golemCliDir });
}
