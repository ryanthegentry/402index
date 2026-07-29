import { readFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fx402 = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'l402space-402.json'), 'utf8'));
const fxDirect = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'direct-l402-token.json'), 'utf8'));
const fxCandidates = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'live-candidates.json'), 'utf8'));

export const UPSTREAM_TEXT = 'pong from the paid upstream';

// One routing fetch mock for the whole invoke flow: live-index pages,
// unpaid 402 challenge, paid redemption. `behavior.redeemStatus` lets the
// failure tests turn the upstream into a 500 or a timeout.
export function routingFetch(behavior = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method ?? 'GET', hasAuth: Boolean(init.headers?.Authorization ?? init.headers?.authorization) });
    if (u.includes('/api/v1/services')) {
      const page = new URL(u).searchParams.get('offset') === '0' ? fxCandidates.page0 : fxCandidates.page1;
      return new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // direct hits on the upstream candidates themselves (multirail route)
    if (/llm402\.ai|lightningfaucet\.com/.test(u) && !u.startsWith('https://l402.space/')) {
      const auth = init.headers?.Authorization ?? init.headers?.authorization;
      if (!auth) {
        if (behavior.directQuoteStatus) {
          return new Response('direct quote refused', { status: behavior.directQuoteStatus });
        }
        return new Response(JSON.stringify(fxDirect.body), {
          status: 402,
          headers: { 'www-authenticate': fxDirect.wwwAuthenticate, 'content-type': 'application/json' }
        });
      }
      if (behavior.redeemStatus === 500) return new Response('upstream exploded', { status: 500 });
      return new Response(JSON.stringify({ choices: [{ message: { content: UPSTREAM_TEXT } }] }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
    if (u.startsWith('https://l402.space/l402/')) {
      const auth = init.headers?.Authorization ?? init.headers?.authorization;
      if (!auth) {
        const challenge = behavior.challengeOverride ?? fx402;
        return new Response(JSON.stringify(challenge.body), {
          status: 402,
          headers: { 'www-authenticate': challenge.wwwAuthenticate, 'content-type': 'application/json' }
        });
      }
      if (behavior.redeemStatus === 500) {
        return new Response('upstream exploded', { status: 500 });
      }
      if (behavior.redeemHang) {
        // hang until the caller's AbortSignal fires, like a real stalled fetch
        return new Promise((_resolve, reject) => {
          const signal = init.signal;
          if (signal) {
            const onAbort = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
          }
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: UPSTREAM_TEXT } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    throw new Error(`routingFetch: unexpected URL ${u}`);
  };
  impl.calls = calls;
  return impl;
}

export function fakeBilling() {
  const calls = { authorize: [], capture: [], void: [] };
  let n = 0;
  return {
    calls,
    async authorize(quotedUsd) {
      n += 1;
      const paymentIntentId = `pi_test_${n}`;
      calls.authorize.push({ quotedUsd, paymentIntentId });
      return {
        paymentIntentId,
        status: 'requires_capture',
        amountCents: Math.max(Math.round(quotedUsd * 100), 50),
        quotedUsd,
        chargedUsd: Math.max(quotedUsd, 0.5)
      };
    },
    async capture(id) { calls.capture.push(id); return { status: 'succeeded' }; },
    async void(id) { calls.void.push(id); return { status: 'canceled' }; },
    async retrieve() { return { status: 'requires_capture', amountCents: 50 }; }
  };
}

export async function startInvokeRouter(overrides = {}) {
  process.env.ROUTER_DATA_DIR = mkdtempSync(join(tmpdir(), 'invoke-test-'));
  process.env.ROUTER_STATE_KEY = 'ab'.repeat(32);
  process.env.SETTLEMENT_ADAPTER = 'mock';
  // The session env may still carry the PRD's original caps (200/5000);
  // the corrected caps are 2000/20000 and tests pin them explicitly.
  process.env.ROUTER_MAX_SATS_PER_JOB = '2000';
  process.env.ROUTER_MAX_TOTAL_SATS = '20000';
  // Legacy tests keep the PoC's gateway-only behavior; multirail tests pass
  // routeOrder explicitly to get the direct-first default.
  process.env.ROUTER_ROUTE_ORDER = overrides.routeOrder ?? 'l402space';
  const { createRouterApp } = await import('../../dist/index.js');
  const { loadConfig } = await import('../../dist/config.js');
  const billing = overrides.billing ?? fakeBilling();
  const fetchImpl = overrides.fetchImpl ?? routingFetch(overrides.behavior);
  const { app, shutdown, routerDb } = createRouterApp(loadConfig(), {
    billing,
    fetchImpl,
    adapter: overrides.adapter,
    btcUsd: async () => 50000,
    redeemTimeoutMs: overrides.redeemTimeoutMs,
    checkoutUrlFactory: overrides.checkoutUrlFactory,
    registrationStripeImpl: overrides.registrationStripeImpl,
    setupStripeImpl: overrides.setupStripeImpl
  });
  // the wire-test principal has a card on file; cold-start tests use other principals
  routerDb.prepare('INSERT INTO cards (principal, payment_method) VALUES (?, ?)').run('wire-test-agent', 'pm_card_visa');
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    billing,
    fetchImpl,
    routerDb,
    close: async () => {
      await shutdown?.();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

let rpcId = 0;

// Like callInvoke but with a caller-chosen principal (clientInfo name).
export async function callInvokeAs(baseUrl, principal, args, extra = {}) {
  rpcId += 1;
  const params = {
    name: 'invoke',
    arguments: args,
    _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {}, url: {} } },
      'io.modelcontextprotocol/clientInfo': { name: principal, version: '1.0.0' }
    },
    ...extra
  };
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-method': 'tools/call',
      'mcp-name': 'invoke'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method: 'tools/call', params })
  });
  return res.json();
}

// Speaks the PRD section 7 wire shapes verbatim.
export async function callInvoke(baseUrl, args, { inputResponses, requestState } = {}) {
  rpcId += 1;
  const params = {
    name: 'invoke',
    arguments: args,
    _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': { elicitation: {} },
      'io.modelcontextprotocol/clientInfo': { name: 'wire-test-agent', version: '1.0.0' }
    }
  };
  if (inputResponses) params.inputResponses = inputResponses;
  if (requestState) params.requestState = requestState;
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-method': 'tools/call',
      'mcp-name': 'invoke'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method: 'tools/call', params })
  });
  const ctype = res.headers.get('content-type') ?? '';
  if (ctype.includes('text/event-stream')) {
    const text = await res.text();
    const dataLines = text.split('\n').filter((l) => l.startsWith('data:'));
    return JSON.parse(dataLines[dataLines.length - 1].slice(5));
  }
  return res.json();
}
