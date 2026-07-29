import type { Route, RouteQuote, UpstreamRequest } from './index.js';
import { redeemHeaders } from './index.js';
import type { Candidate } from '../quote.js';
import { parseL402Challenge } from '../challenge.js';

// Quotes from the upstream's own 402 and redeems at the upstream — no gateway
// in the middle. 16% cheaper on the one pair measured, and the leg that keeps
// the delivery record ours. The redeem URL is wherever the quote request
// LANDED (redirects followed): lightningfaucet's catalog URL 301s to the real
// endpoint, and the credential binds to the final URL.
export function createDirectL402Route(): Route {
  return {
    name: 'direct-l402',
    supports: () => true,

    async quote(candidate: Candidate, req: UpstreamRequest, ctx): Promise<RouteQuote> {
      const res = await ctx.fetchImpl(req.url, {
        method: req.method,
        redirect: 'follow',
        ...(req.body ? { body: req.body, headers: { 'content-type': 'application/json' } } : {})
      });
      if (res.status !== 402) {
        throw new Error(`direct quote: upstream answered ${res.status}, not 402`);
      }
      const www = res.headers.get('www-authenticate') ?? '';
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null; // text or empty bodies are fine; the bolt11 carries the amount
      }
      const parsed = parseL402Challenge(www, body);
      return {
        route: 'direct-l402',
        paymentRequest: {
          rail: 'l402',
          network: 'lightning',
          asset: 'BTC',
          amount: String(parsed.amountSats),
          amountSats: parsed.amountSats,
          payTo: null,
          credential: parsed.credential,
          raw: parsed.invoice,
          expiresAt: parsed.expiresAt // epoch milliseconds
        },
        redeemUrl: res.url || req.url,
        httpMethod: req.method,
        body: req.body,
        credentialKind: parsed.credentialKind
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
