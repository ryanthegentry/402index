import type { PaymentRequest, Settlement, SettlementAdapter } from './index.js';
import { SettlementError } from './index.js';

// The deliberate stub. It exists so the registry, the PaymentRequest shape,
// and route selection are all exercised against a real x402 v2 challenge
// tonight — while paying nothing. Building a payer needs a funded EVM key
// and a second (USDC) spend cap, both explicitly out of scope.
export function createX402Stub(): SettlementAdapter {
  const refuse = async (): Promise<Settlement> => {
    throw new SettlementError(
      'RAIL_UNAVAILABLE',
      'x402 settlement is designed but not funded: it needs an EVM private key holding USDC on Base ' +
        '(eip155:8453) and a USDC-denominated spend cap. Neither exists on this system by decision.'
    );
  };
  return {
    name: 'x402-stub',
    rails: ['x402'],
    networks: ['eip155:8453'],
    minSats: 0,
    movesRealFunds: false,
    canSettle: (req: PaymentRequest) => req.rail === 'x402',
    pay: refuse,
    payInvoice: refuse
  };
}
