import type { PaymentRequest } from './settlement/index.js';

// Parses an x402 v2 `payment-required` header (base64 JSON) into the
// rail-agnostic PaymentRequest. Parsing only — the payer is deliberately
// unbuilt (see settlement/x402.ts). Read `extra` verbatim: the EIP-712
// domain name lives there ('USD Coin' on Base mainnet) and hardcoding it
// is a known trap.

export class X402ParseError extends Error {
  code: 'MALFORMED' | 'NO_SETTLEABLE_NETWORK';
  constructor(code: X402ParseError['code'], message: string) {
    super(message);
    this.name = 'X402ParseError';
    this.code = code;
  }
}

interface AcceptsEntry {
  scheme?: string;
  network?: string;
  asset?: string;
  amount?: string;
  payTo?: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

export function parseX402Challenge(
  headerValue: string,
  opts: { networks: string[] }
): PaymentRequest & { extra?: Record<string, unknown> } {
  let decoded: { x402Version?: number; accepts?: AcceptsEntry[] };
  try {
    const pad = headerValue + '='.repeat((4 - (headerValue.length % 4)) % 4);
    decoded = JSON.parse(Buffer.from(pad, 'base64').toString('utf8'));
  } catch {
    throw new X402ParseError('MALFORMED', `payment-required header is not base64 JSON (first 40 chars: ${headerValue.slice(0, 40)})`);
  }
  const accepts = decoded.accepts ?? [];
  const entry = accepts.find((a) => a.network && opts.networks.includes(a.network));
  if (!entry) {
    const offered = accepts.map((a) => a.network).join(', ') || 'none';
    throw new X402ParseError('NO_SETTLEABLE_NETWORK', `no accepts entry on a settleable network (offered: ${offered})`);
  }
  if (typeof entry.amount !== 'string' || !entry.asset) {
    throw new X402ParseError('MALFORMED', 'accepts entry missing amount or asset');
  }
  return {
    rail: 'x402',
    network: entry.network as string,
    asset: entry.asset,
    amount: entry.amount,
    amountSats: null,
    payTo: entry.payTo ?? null,
    credential: '',
    raw: JSON.stringify(entry),
    expiresAt: null,
    extra: entry.extra
  };
}
