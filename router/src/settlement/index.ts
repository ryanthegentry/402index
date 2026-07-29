import { decode as decodeBolt11 } from 'light-bolt11-decoder';
import { createGolemSettlement } from './golem.js';
import { createGolemHttpSettlement } from './golem-http.js';
import { createMockSettlement } from './mock.js';
import { createX402Stub } from './x402.js';

// Rail-agnostic settlement. The adapter answers "how do I pay this"; the
// route (routes/) answers "who quotes and where do I redeem". Adapter names
// are open strings — real-money accounting keys off movesRealFunds, never
// off a name.

export type Rail = 'l402' | 'x402';

export interface PaymentRequest {
  rail: Rail;
  network: string;           // 'lightning' | 'eip155:8453' | …
  asset: string;             // 'BTC' | ERC-20 contract address
  amount: string;            // exact, smallest native unit, decimal string
  amountSats: number | null; // null on non-sat rails; every caller must decide
  payTo: string | null;
  credential: string;        // macaroon | token — echoed on redemption
  raw: string;               // bolt11 for l402; base64 accepts-entry for x402
  expiresAt: number | null;
}

export interface Settlement {
  proof: string;
  proofKind: 'preimage' | 'txhash';
  paidSats: number;          // 0 on a non-sat rail
  paidAmount: string;        // exact native smallest unit
  feeSats: number;
  durationMs: number;
  /** @deprecated alias of proof when proofKind is 'preimage'; kept for the PoC-era tests */
  preimage: string;
}

export interface SettlementAdapter {
  name: string;              // open — no union
  rails: Rail[];
  networks: string[];        // '*' permitted
  minSats: number;
  movesRealFunds: boolean;
  canSettle(req: PaymentRequest): boolean;
  pay(req: PaymentRequest, opts: { maxSats: number }): Promise<Settlement>;
  /** @deprecated bolt11-only PoC surface; use pay() */
  payInvoice(invoice: string, opts: { maxSats: number }): Promise<Settlement>;
}

export class SettlementError extends Error {
  code: 'PAY_FAILED' | 'PREIMAGE_UNAVAILABLE' | 'BELOW_MIN' | 'OVER_MAX' | 'RAIL_UNAVAILABLE';
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

// Turns a bolt11 into the canonical l402 PaymentRequest shape.
export function paymentRequestFromInvoice(invoice: string, credential: string): PaymentRequest {
  const { amountSats } = decodeInvoice(invoice);
  return {
    rail: 'l402',
    network: 'lightning',
    asset: 'BTC',
    amount: String(amountSats),
    amountSats,
    payTo: null,
    credential,
    raw: invoice,
    expiresAt: null
  };
}

export interface AdapterRegistry {
  register(a: SettlementAdapter, opts?: { onlyWhenPinned?: boolean }): void;
  select(req: PaymentRequest): SettlementAdapter | null;
  all(): SettlementAdapter[];
}

export function createAdapterRegistry(opts: { pinned?: string } = {}): AdapterRegistry {
  const adapters: { adapter: SettlementAdapter; onlyWhenPinned: boolean }[] = [];
  return {
    register(adapter, regOpts = {}) {
      adapters.push({ adapter, onlyWhenPinned: regOpts.onlyWhenPinned ?? false });
    },
    select(req) {
      const able = adapters
        .filter(({ adapter, onlyWhenPinned }) =>
          adapter.canSettle(req) &&
          (req.amountSats === null || req.amountSats >= adapter.minSats) &&
          (!onlyWhenPinned || opts.pinned === adapter.name)
        )
        .map(({ adapter }) => adapter);
      if (able.length === 0) return null;
      if (opts.pinned) {
        const pinned = able.find((a) => a.name === opts.pinned);
        if (pinned) return pinned;
      }
      return able.find((a) => a.movesRealFunds) ?? able[0];
    },
    all() {
      return adapters.map(({ adapter }) => adapter);
    }
  };
}

export function buildRegistry(config: {
  settlementAdapter: string;
  golemCliDir: string;
  golemHttpUrl?: string;
  golemHttpApiKey?: string;
}): AdapterRegistry {
  const registry = createAdapterRegistry({
    pinned:
      config.settlementAdapter === 'mock' || config.settlementAdapter === 'golem-http'
        ? config.settlementAdapter
        : undefined
  });
  registry.register(createGolemSettlement({ golemCliDir: config.golemCliDir }));
  if (config.golemHttpUrl && config.golemHttpApiKey) {
    registry.register(
      createGolemHttpSettlement({ baseUrl: config.golemHttpUrl, apiKey: config.golemHttpApiKey })
    );
  }
  // the mock is a test double: reachable only by explicit pin, never by fallback
  registry.register(createMockSettlement(), { onlyWhenPinned: true });
  registry.register(createX402Stub());
  return registry;
}

/** @deprecated PoC-era single-adapter selection; kept for existing tests. */
export function selectAdapter(config: { settlementAdapter: string; golemCliDir: string }): SettlementAdapter {
  return config.settlementAdapter === 'mock'
    ? createMockSettlement()
    : createGolemSettlement({ golemCliDir: config.golemCliDir });
}
