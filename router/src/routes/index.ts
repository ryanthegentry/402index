import type { PaymentRequest } from '../settlement/index.js';
import type { Candidate } from '../quote.js';
import { createDirectL402Route } from './direct-l402.js';
import { createL402SpaceRoute } from './l402space.js';

// The route answers "who quotes the price, and where do I redeem"; the
// adapter answers "how do I pay". Direct-L402 and gateway-L402 are two routes
// over one adapter; a future gateway-x402-out is one route over another.

export interface UpstreamRequest {
  url: string;
  method: string;
  body?: string;
}

export interface RouteQuote {
  route: string;
  paymentRequest: PaymentRequest;
  redeemUrl: string;
  httpMethod: string;
  body?: string;
  credentialKind: 'macaroon' | 'token';
}

export interface RedeemJob {
  redeem_url: string;
  http_method: string;
  body: string | null;
  credential: string;
}

export interface Route {
  name: string;
  supports(candidate: Candidate): boolean;
  quote(candidate: Candidate, req: UpstreamRequest, ctx: { fetchImpl: typeof fetch }): Promise<RouteQuote>;
  redeem(job: RedeemJob, settlement: { proof: string }, opts: { timeoutMs: number; fetchImpl: typeof fetch }): Promise<Response>;
}

const FACTORIES: Record<string, () => Route> = {
  'direct-l402': createDirectL402Route,
  'l402space': createL402SpaceRoute
};

export function buildRoutes(order: string[]): Route[] {
  return order.map((name) => {
    const factory = FACTORIES[name];
    if (!factory) throw new Error(`unknown route "${name}" in ROUTER_ROUTE_ORDER`);
    return factory();
  });
}

export function redeemHeaders(credential: string, proof: string, hasBody: boolean): Record<string, string> {
  return {
    Authorization: `L402 ${credential}:${proof}`,
    ...(hasBody ? { 'content-type': 'application/json' } : {})
  };
}
