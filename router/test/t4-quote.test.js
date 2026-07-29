import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { openRouterDb } from '../dist/db.js';
import { fetchCandidates, fetchQuote, wrapForGateway, QuoteError } from '../dist/quote.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fx402 = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'l402space-402.json'), 'utf8'));
const fxCandidates = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'live-candidates.json'), 'utf8'));

// Serves the captured live-API pages: offset 0 → real subset, anything else → empty.
function candidatesFetch(calls = []) {
  return async (url) => {
    calls.push(String(url));
    const u = new URL(String(url));
    const page = u.searchParams.get('offset') === '0' ? fxCandidates.page0 : fxCandidates.page1;
    return new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

function freshRouterDb() {
  return openRouterDb(mkdtempSync(join(tmpdir(), 'quote-test-')));
}

test('T4a: fetchCandidates filters floor, budget, lnget, degraded; ranks by score then latency', async () => {
  const routerDb = freshRouterDb();
  const calls = [];
  const picks = await fetchCandidates(routerDb, {
    capability: 'llm-completion',
    maxPriceUsd: 1.0,
    minSats: 333,
    btcUsd: 50000,
    fetchImpl: candidatesFetch(calls)
  });
  const urls = picks.map((p) => p.url);
  assert.ok(urls.includes('https://llm402.ai/v1/chat/completions/claude-fable-5%3Abatch'), `batch target in ${JSON.stringify(urls)}`);
  assert.ok(urls.includes('https://llm402.ai/v1/chat/completions/gpt-5.2-pro'), 'gpt-5.2-pro in picks');
  assert.ok(!urls.some((u) => u.endsWith('/claude-fable-5')), '177 sats is under the Boltz floor');
  assert.ok(!urls.some((u) => u.includes('DeepSeek-V3')), '21 sats is under the floor');
  assert.ok(!urls.some((u) => u.includes('veo-2.0')), '6696 sats ≈ $3.35 is over the $1 budget');
  assert.ok(!urls.some((u) => u.includes('lightningenable')), 'lnget_compatible=0 excluded');
  assert.ok(calls[0].includes('protocol=L402') && calls[0].includes('health=healthy') && calls[0].includes('offset=0'),
    `live API called with the verified filters: ${calls[0]}`);
  // equal capability score → lower latency first
  assert.equal(picks[0].url, 'https://llm402.ai/v1/chat/completions/gpt-5.2-pro');
});

test('T4b: capability terms steer selection (claude-fable beats lower latency)', async () => {
  const routerDb = freshRouterDb();
  const picks = await fetchCandidates(routerDb, {
    capability: 'llm-completion claude-fable',
    maxPriceUsd: 1.0,
    minSats: 333,
    btcUsd: 50000,
    fetchImpl: candidatesFetch()
  });
  assert.equal(picks[0].url, 'https://llm402.ai/v1/chat/completions/claude-fable-5%3Abatch');
});

test('T4c: locally degraded candidates are excluded', async () => {
  const routerDb = freshRouterDb();
  const all = await fetchCandidates(routerDb, {
    capability: 'llm-completion', maxPriceUsd: 1.0, minSats: 333, btcUsd: 50000, fetchImpl: candidatesFetch()
  });
  const gpt = all.find((p) => p.url.includes('gpt-5.2-pro'));
  routerDb.prepare('INSERT INTO degraded_candidates (service_id, reason) VALUES (?, ?)').run(gpt.id, 'test');
  const picks = await fetchCandidates(routerDb, {
    capability: 'llm-completion', maxPriceUsd: 1.0, minSats: 333, btcUsd: 50000, fetchImpl: candidatesFetch()
  });
  assert.ok(!picks.some((p) => p.url.includes('gpt-5.2-pro')), 'degraded candidate excluded');
});

test('T4d: wrapForGateway url-encodes the full upstream into the l402 rail path', () => {
  const wrapped = wrapForGateway('https://lightningfaucet.com/api/l402/llm-prompt?prompt=hi there');
  assert.equal(
    wrapped,
    'https://l402.space/l402/' + encodeURIComponent('https://lightningfaucet.com/api/l402/llm-prompt?prompt=hi there')
  );
});

test('T4e: fetchQuote parses a real captured 402 challenge', async () => {
  const mockFetch = async () => new Response(JSON.stringify(fx402.body), {
    status: 402,
    headers: { 'www-authenticate': fx402.wwwAuthenticate, 'content-type': 'application/json' }
  });
  const quote = await fetchQuote('https://lightningfaucet.com/api/l402/llm-prompt?prompt=x', { fetchImpl: mockFetch });
  assert.equal(quote.amountSats, 580);
  assert.ok(quote.token.length > 100, 'token extracted');
  assert.ok(quote.invoice.startsWith('lnbc'), 'bolt11 invoice extracted');
  assert.equal(quote.wrappedUrl, wrapForGateway('https://lightningfaucet.com/api/l402/llm-prompt?prompt=x'));
});

test('T4f: fetchQuote on a non-402 response throws NO_CHALLENGE', async () => {
  const mockFetch = async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  await assert.rejects(
    () => fetchQuote('https://free.example/api', { fetchImpl: mockFetch }),
    (err) => err instanceof QuoteError && err.code === 'NO_CHALLENGE'
  );
});

test('T4g: fetchQuote on a malformed challenge throws INVALID_CHALLENGE', async () => {
  const mockFetch = async () => new Response('{"error":"Payment required"}', {
    status: 402,
    headers: { 'www-authenticate': 'Basic realm="nope"', 'content-type': 'application/json' }
  });
  await assert.rejects(
    () => fetchQuote('https://weird.example/api', { fetchImpl: mockFetch }),
    (err) => err instanceof QuoteError && err.code === 'INVALID_CHALLENGE'
  );
});

test('T4h: provenFallbacks bypass only the lnget filter and rank last', async () => {
  const routerDb = freshRouterDb();
  const base = {
    capability: 'llm-completion claude-fable', maxPriceUsd: 1.0, minSats: 333, btcUsd: 50000, fetchImpl: candidatesFetch()
  };
  const without = await fetchCandidates(routerDb, base);
  assert.ok(!without.some((p) => p.url.includes('lightningfaucet')), 'lnget=0 stays excluded by default');
  const withFallback = await fetchCandidates(routerDb, {
    ...base,
    provenFallbacks: ['https://lightningfaucet.com/api/l402/llm-prompt']
  });
  const urls = withFallback.map((p) => p.url);
  assert.ok(urls.includes('https://lightningfaucet.com/api/l402/llm-prompt'), `fallback included in ${JSON.stringify(urls)}`);
  assert.equal(urls[urls.length - 1], 'https://lightningfaucet.com/api/l402/llm-prompt', 'fallback ranks last');
});
