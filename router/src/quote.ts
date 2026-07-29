import type { Database } from 'better-sqlite3';

// Candidate selection from the LIVE 402index.io API plus the firm quote from
// l402.space. The catalog price is only a pre-filter; the 402 challenge from
// the gateway is the authoritative price ("the quote in the challenge is
// authoritative — you never pay more than it states").
//
// Live-API gotchas (verified against production 2026-07-28): the health filter
// is `health=healthy` (`health_status=` is silently ignored); `limit` caps
// server-side at 200 so pagination is by offset; `price_usd` is 0.000/null on
// most rows — filter on price_sats and convert with a live BTC rate.

const GATEWAY = 'https://l402.space/l402/';
const INDEX_API = 'https://402index.io/api/v1';
const PAGE_SIZE = 200;

export class QuoteError extends Error {
  code: 'NO_CHALLENGE' | 'INVALID_CHALLENGE' | 'NO_CANDIDATES';
  constructor(code: QuoteError['code'], message: string) {
    super(message);
    this.name = 'QuoteError';
    this.code = code;
  }
}

export interface Candidate {
  id: string;
  name: string;
  url: string;
  priceSats: number;
  latencyMs: number | null;
  httpMethod: string;
  score: number;
  fallback: boolean;
}

interface LiveServiceRow {
  id: string;
  name?: string;
  description?: string;
  url?: string;
  price_sats?: number | null;
  lnget_compatible?: number | null;
  latency_p50_ms?: number | null;
  http_method?: string | null;
  category?: string | null;
  capabilities?: string | null;
}

export async function fetchCandidates(
  routerDb: Database,
  opts: {
    capability: string;
    maxPriceUsd: number;
    minSats: number;
    btcUsd: number;
    fetchImpl?: typeof fetch;
    apiBase?: string;
    // URLs proven to deliver end-to-end by hand; they bypass ONLY the
    // lnget_compatible filter and rank after every compatible candidate.
    provenFallbacks?: string[];
  }
): Promise<Candidate[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiBase = opts.apiBase ?? INDEX_API;

  const rows: LiveServiceRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const url = `${apiBase}/services?protocol=L402&health=healthy&limit=${PAGE_SIZE}&offset=${offset}`;
    const res = await fetchImpl(url);
    if (!res.ok) throw new QuoteError('NO_CANDIDATES', `live index API returned ${res.status}`);
    const page = (await res.json()) as { services?: LiveServiceRow[] };
    const pageRows = page.services ?? [];
    rows.push(...pageRows);
    if (pageRows.length < PAGE_SIZE) break;
  }

  const degraded = new Set(
    (routerDb.prepare('SELECT service_id FROM degraded_candidates').all() as { service_id: string }[])
      .map((r) => r.service_id)
  );

  const terms = opts.capability.toLowerCase().split(/[-_\s]+/).filter(Boolean);
  const candidates: Candidate[] = [];
  const fallbacks = new Set(opts.provenFallbacks ?? []);
  for (const row of rows) {
    const priceSats = row.price_sats ?? 0;
    if (!row.url) continue;
    const isFallback = fallbacks.has(row.url);
    if (row.lnget_compatible !== 1 && !isFallback) continue;
    if (priceSats < opts.minSats) continue;
    if ((priceSats / 1e8) * opts.btcUsd > opts.maxPriceUsd) continue;
    if (degraded.has(row.id)) continue;
    const haystack = [row.name, row.description, row.category, row.capabilities, row.url]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    const score = terms.filter((t) => haystack.includes(t)).length;
    if (score === 0) continue;
    candidates.push({
      id: row.id,
      name: row.name ?? row.url,
      url: row.url,
      priceSats,
      latencyMs: row.latency_p50_ms ?? null,
      httpMethod: row.http_method ?? 'GET',
      score,
      fallback: isFallback
    });
  }
  candidates.sort(
    (a, b) =>
      Number(a.fallback) - Number(b.fallback) ||
      b.score - a.score ||
      (a.latencyMs ?? 99999) - (b.latencyMs ?? 99999)
  );
  return candidates;
}

export function wrapForGateway(upstreamUrl: string): string {
  return GATEWAY + encodeURIComponent(upstreamUrl);
}

export interface Quote {
  wrappedUrl: string;
  token: string;
  invoice: string;
  amountSats: number;
  priceUsd: number | null;
}

export async function fetchQuote(
  upstreamUrl: string,
  opts: { method?: string; body?: string; fetchImpl?: typeof fetch } = {}
): Promise<Quote> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const wrappedUrl = wrapForGateway(upstreamUrl);
  const res = await fetchImpl(wrappedUrl, {
    method: opts.method ?? 'GET',
    ...(opts.body ? { body: opts.body, headers: { 'content-type': 'application/json' } } : {})
  });
  if (res.status !== 402) {
    throw new QuoteError('NO_CHALLENGE', `expected 402 from gateway, got ${res.status}`);
  }
  const www = res.headers.get('www-authenticate') ?? '';
  const token = /token="([^"]+)"/.exec(www)?.[1];
  const invoice = /invoice="([^"]+)"/.exec(www)?.[1];
  let body: { amountSats?: number; priceUsd?: number } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // header-only challenge; amountSats check below rejects it
  }
  if (!www.startsWith('L402') || !token || !invoice || typeof body.amountSats !== 'number') {
    throw new QuoteError('INVALID_CHALLENGE', `unparseable 402 challenge from gateway (header: ${www.slice(0, 40)}…)`);
  }
  return { wrappedUrl, token, invoice, amountSats: body.amountSats, priceUsd: body.priceUsd ?? null };
}
