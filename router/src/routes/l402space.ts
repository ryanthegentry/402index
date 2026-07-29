import type { Route, RouteQuote, UpstreamRequest } from './index.js';
import { redeemHeaders } from './index.js';
import type { Candidate } from '../quote.js';
import { fetchQuote } from '../quote.js';

// The gateway route: l402.space wraps the upstream, re-quotes with its markup,
// and settles the upstream's own rail. Breadth (x402/MPP upstreams reachable
// over Lightning) at a measured 16% premium — and the delivery record accrues
// to the gateway, which is what the direct route exists to hedge.
export function createL402SpaceRoute(): Route {
  return {
    name: 'l402space',
    supports: () => true,

    async quote(candidate: Candidate, req: UpstreamRequest, ctx): Promise<RouteQuote> {
      const q = await fetchQuote(req.url, { method: req.method, body: req.body, fetchImpl: ctx.fetchImpl });
      return {
        route: 'l402space',
        paymentRequest: {
          rail: 'l402',
          network: 'lightning',
          asset: 'BTC',
          amount: String(q.amountSats),
          amountSats: q.amountSats,
          payTo: null,
          credential: q.token,
          raw: q.invoice,
          expiresAt: null
        },
        redeemUrl: q.wrappedUrl,
        httpMethod: req.method,
        body: req.body,
        credentialKind: 'token'
      };
    },

    async redeem(job, settlement, opts): Promise<Response> {
      return opts.fetchImpl(job.redeem_url, {
        method: job.http_method,
        headers: redeemHeaders(job.credential, settlement.proof, Boolean(job.body)),
        ...(job.body ? { body: job.body } : {}),
        signal: AbortSignal.timeout(opts.timeoutMs)
      });
    }
  };
}
