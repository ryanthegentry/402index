import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startInvokeRouter } from './helpers/invoke-harness.js';

const ARGS = { capability: 'llm-completion claude-fable', input: 'Reply with exactly: pong', max_price_usd: 1.0 };

// Scenario C: an agent with no card on file gets a url-mode elicitation
// pointing at card registration instead of a consent form. The live Stripe
// Checkout URL cannot be minted with the restricted key (verbatim probe:
// more_permissions_required for setup_intents/checkout.sessions) — the URL
// factory is injectable and asserted structurally, as the PRD allows.

async function callAs(baseUrl, clientName, args, extra = {}) {
  const params = {
    name: 'invoke',
    arguments: args,
    _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {}, url: {} } },
      'io.modelcontextprotocol/clientInfo': { name: clientName, version: '1.0.0' }
    },
    ...extra
  };
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-method': 'tools/call', 'mcp-name': 'invoke' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9), method: 'tools/call', params })
  });
  return res.json();
}

test('T9a: no card on file → input_required with a url-mode registration elicitation', async (t) => {
  const r = await startInvokeRouter({
    checkoutUrlFactory: async (principal) => `https://checkout.stripe.example/setup/${encodeURIComponent(principal)}`
  });
  t.after(r.close);
  const res = await callAs(r.baseUrl, 'cold-agent', ARGS);
  assert.equal(res.result.resultType, 'input_required', JSON.stringify(res).slice(0, 300));
  const register = res.result.inputRequests.register;
  assert.equal(register.method, 'elicitation/create');
  assert.equal(register.params.mode, 'url');
  assert.match(register.params.url, /^https:\/\/checkout\.stripe\.example\/setup\/cold-agent$/);
  assert.match(register.params.message, /card/i);
  assert.equal(r.billing.calls.authorize.length, 0, 'no hold before a card exists');
});

test('T9b: after registration the same agent gets the normal consent flow', async (t) => {
  const r = await startInvokeRouter({
    checkoutUrlFactory: async () => 'https://checkout.stripe.example/setup/x'
  });
  t.after(r.close);
  const cold = await callAs(r.baseUrl, 'cold-agent', ARGS);
  assert.equal(cold.result.inputRequests.register.params.mode, 'url');
  // Simulate completed registration. The Stripe-API simulation the PRD asks
  // for is blocked by the restricted key's scope, so registration is recorded
  // directly where the router keeps cards on file.
  r.routerDb.prepare('INSERT INTO cards (principal, payment_method) VALUES (?, ?)').run('cold-agent', 'pm_card_visa');
  const warm = await callAs(r.baseUrl, 'cold-agent', ARGS);
  assert.equal(warm.result.resultType, 'input_required');
  assert.ok(warm.result.inputRequests.consent, 'consent form now offered');
  assert.equal(warm.result.inputRequests.consent.params.mode, 'form');
  assert.equal(r.billing.calls.authorize.length, 1, 'hold authorized once the card exists');
});
