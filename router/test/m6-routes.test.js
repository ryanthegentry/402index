import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRoutes } from '../dist/routes/index.js';

const direct = JSON.parse(readFileSync(new URL('./fixtures/direct-l402-token.json', import.meta.url), 'utf8'));
const gateway = JSON.parse(readFileSync(new URL('./fixtures/l402space-402.json', import.meta.url), 'utf8'));

const CANDIDATE = {
  id: 'svc-lf',
  name: 'Lightning Faucet LLM Prompt',
  url: 'https://lightningfaucet.com/api/l402/llm-prompt',
  priceSats: 500,
  latencyMs: 232,
  httpMethod: 'GET',
  score: 1,
  fallback: false
};
const UPSTREAM_REQ = { url: 'https://lightningfaucet.com/api/l402/llm-prompt?prompt=x', method: 'GET' };

// Serves the DIRECT challenge on the bare upstream and the GATEWAY challenge
// on the wrapped l402.space URL; follows the fixture's redirect semantics by
// reporting a different final URL for the direct hit.
function routeFetch() {
  return async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://l402.space/l402/')) {
      return new Response(JSON.stringify(gateway.body), {
        status: 402,
        headers: { 'www-authenticate': gateway.wwwAuthenticate, 'content-type': 'application/json' }
      });
    }
    const res = new Response(JSON.stringify(direct.body), {
      status: 402,
      headers: { 'www-authenticate': direct.wwwAuthenticate, 'content-type': 'application/json' }
    });
    Object.defineProperty(res, 'url', { value: direct.finalUrl });
    return res;
  };
}

test('M6a: the direct route quotes from the upstream challenge and redeems at the post-redirect URL', async () => {
  const [directRoute] = buildRoutes(['direct-l402']);
  const q = await directRoute.quote(CANDIDATE, UPSTREAM_REQ, { fetchImpl: routeFetch() });
  assert.equal(q.route, 'direct-l402');
  assert.equal(q.paymentRequest.amountSats, 500, 'the upstream price, not the gateway re-quote');
  assert.ok(q.paymentRequest.raw.startsWith('lnbc'), 'raw carries the upstream bolt11');
  assert.equal(q.redeemUrl, direct.finalUrl, 'redeem where the redirect landed, not the catalog URL');
  assert.equal(q.credentialKind, 'token');
});

test('M6b: the gateway route quotes the wrapped URL with the larger re-quoted amount', async () => {
  const [gatewayRoute] = buildRoutes(['l402space']);
  const q = await gatewayRoute.quote(CANDIDATE, UPSTREAM_REQ, { fetchImpl: routeFetch() });
  assert.equal(q.route, 'l402space');
  assert.equal(q.paymentRequest.amountSats, 580, 'gateway re-quote includes markup');
  assert.ok(q.redeemUrl.startsWith('https://l402.space/l402/'), 'redemption goes through the gateway');
});

test('M6c: the same candidate through both routes yields two different prices', async () => {
  const routes = buildRoutes(['direct-l402', 'l402space']);
  const quotes = [];
  for (const r of routes) quotes.push(await r.quote(CANDIDATE, UPSTREAM_REQ, { fetchImpl: routeFetch() }));
  assert.equal(quotes[1].paymentRequest.amountSats - quotes[0].paymentRequest.amountSats, 80, 'the 16% gateway margin, measurable');
});

test('M6d: redeem sends Authorization: L402 credential:proof to the stored redeem URL', async () => {
  const [directRoute] = buildRoutes(['direct-l402']);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), auth: init.headers?.Authorization, method: init.method });
    return new Response('{"ok":true}', { status: 200 });
  };
  const res = await directRoute.redeem(
    { redeem_url: direct.finalUrl, http_method: 'GET', body: null, credential: 'CREDX' },
    { proof: 'ab'.repeat(32) },
    { timeoutMs: 5000, fetchImpl }
  );
  assert.equal(res.status, 200);
  assert.equal(calls[0].url, direct.finalUrl);
  assert.equal(calls[0].auth, `L402 CREDX:${'ab'.repeat(32)}`);
});

test('M6e: a non-402 answer on the direct quote is a typed skip, not a crash', async () => {
  const [directRoute] = buildRoutes(['direct-l402']);
  const fetchImpl = async () => new Response('nope', { status: 403 });
  await assert.rejects(
    () => directRoute.quote(CANDIDATE, UPSTREAM_REQ, { fetchImpl }),
    (err) => /403/.test(err.message)
  );
});
