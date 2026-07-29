import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startInvokeRouter, callInvoke, UPSTREAM_TEXT } from './helpers/invoke-harness.js';

const ARGS = { capability: 'llm-completion claude-fable', input: 'Reply with exactly: pong', max_price_usd: 1.0 };

test('T7a: cold call returns input_required with a form consent and opaque requestState', async (t) => {
  const r = await startInvokeRouter();
  t.after(r.close);
  const res = await callInvoke(r.baseUrl, ARGS);
  assert.equal(res.result.resultType, 'input_required', JSON.stringify(res).slice(0, 300));
  const consent = res.result.inputRequests.consent;
  assert.equal(consent.method, 'elicitation/create');
  assert.equal(consent.params.mode, 'form');
  assert.match(consent.params.message, /\$0\.50/, 'consent shows the floored card charge');
  assert.match(consent.params.message, /llm402\.ai/, 'consent names the upstream host');
  assert.deepEqual(consent.params.requestedSchema.required, ['approve']);
  assert.ok(typeof res.result.requestState === 'string' && res.result.requestState.length > 50);
  assert.equal(r.billing.calls.authorize.length, 1, 'card hold authorized at quote time');
  assert.equal(r.billing.calls.capture.length, 0, 'nothing captured before consent');
});

test('T7b: approved retry settles, captures, and returns the receipt', async (t) => {
  const r = await startInvokeRouter();
  t.after(r.close);
  const first = await callInvoke(r.baseUrl, ARGS);
  const res = await callInvoke(r.baseUrl, ARGS, {
    inputResponses: { consent: { action: 'accept', content: { approve: true } } },
    requestState: first.result.requestState
  });
  assert.ok(!res.error, JSON.stringify(res).slice(0, 400));
  assert.ok(!res.result.isError, JSON.stringify(res.result).slice(0, 400));
  assert.match(res.result.content[0].text, new RegExp(UPSTREAM_TEXT.slice(0, 10)));
  const receipt = res.result._meta['io.402index/receipt'];
  assert.equal(receipt.rail, 'l402');
  assert.equal(receipt.paid_sats, 580, 'sats from the firm quote fixture');
  assert.equal(receipt.charged_usd, 0.5, 'card charge floored at $0.50');
  assert.match(receipt.payment_intent, /^pi_test_/);
  assert.ok(receipt.latency_ms >= 0);
  assert.ok(receipt.candidates_considered >= 1);
  assert.equal(r.billing.calls.capture.length, 1, 'captured exactly once');
  assert.equal(r.billing.calls.void.length, 0);
});

test('T7c: tampered requestState is rejected and nothing is captured', async (t) => {
  const r = await startInvokeRouter();
  t.after(r.close);
  const first = await callInvoke(r.baseUrl, ARGS);
  const blob = first.result.requestState;
  const mid = Math.floor(blob.length / 2);
  const tampered = blob.slice(0, mid) + (blob[mid] === 'A' ? 'B' : 'A') + blob.slice(mid + 1);
  const res = await callInvoke(r.baseUrl, ARGS, {
    inputResponses: { consent: { action: 'accept', content: { approve: true } } },
    requestState: tampered
  });
  assert.ok(res.result.isError, JSON.stringify(res).slice(0, 300));
  assert.match(res.result.content[0].text, /INTEGRITY/);
  assert.equal(r.billing.calls.capture.length, 0);
});

test('T7d: a replayed requestState is refused the second time', async (t) => {
  const r = await startInvokeRouter();
  t.after(r.close);
  const first = await callInvoke(r.baseUrl, ARGS);
  const retry = {
    inputResponses: { consent: { action: 'accept', content: { approve: true } } },
    requestState: first.result.requestState
  };
  const ok = await callInvoke(r.baseUrl, ARGS, retry);
  assert.ok(!ok.result.isError, 'first redemption succeeds');
  const replay = await callInvoke(r.baseUrl, ARGS, retry);
  assert.ok(replay.result.isError, 'replay refused');
  assert.match(replay.result.content[0].text, /REPLAY/);
  assert.equal(r.billing.calls.capture.length, 1, 'captured exactly once across both attempts');
});

test('T7e: declined consent voids the hold and charges nothing', async (t) => {
  const r = await startInvokeRouter();
  t.after(r.close);
  const first = await callInvoke(r.baseUrl, ARGS);
  const res = await callInvoke(r.baseUrl, ARGS, {
    inputResponses: { consent: { action: 'decline' } },
    requestState: first.result.requestState
  });
  assert.ok(res.result.isError);
  assert.match(res.result.content[0].text, /declined|charged \$0/i);
  assert.equal(r.billing.calls.void.length, 1, 'hold voided');
  assert.equal(r.billing.calls.capture.length, 0);
});

test('T7f: wrong principal on retry is rejected (state bound to the caller)', async (t) => {
  const r = await startInvokeRouter();
  t.after(r.close);
  const first = await callInvoke(r.baseUrl, ARGS);
  // same blob, different clientInfo name → PRINCIPAL
  const rpc = {
    jsonrpc: '2.0', id: 999, method: 'tools/call',
    params: {
      name: 'invoke', arguments: ARGS,
      inputResponses: { consent: { action: 'accept', content: { approve: true } } },
      requestState: first.result.requestState,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': { elicitation: {} },
        'io.modelcontextprotocol/clientInfo': { name: 'a-different-agent', version: '9.9.9' }
      }
    }
  };
  const res = await fetch(`${r.baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-method': 'tools/call', 'mcp-name': 'invoke' },
    body: JSON.stringify(rpc)
  }).then((x) => x.json());
  assert.ok(res.result.isError, JSON.stringify(res).slice(0, 300));
  assert.match(res.result.content[0].text, /PRINCIPAL/);
  assert.equal(r.billing.calls.capture.length, 0);
});

test('T7g: upstream 5xx after settlement voids the hold and degrades the candidate', async (t) => {
  const r = await startInvokeRouter({ behavior: { redeemStatus: 500 } });
  t.after(r.close);
  const first = await callInvoke(r.baseUrl, ARGS);
  const res = await callInvoke(r.baseUrl, ARGS, {
    inputResponses: { consent: { action: 'accept', content: { approve: true } } },
    requestState: first.result.requestState
  });
  assert.ok(res.result.isError);
  assert.match(res.result.content[0].text, /charged \$0/i, 'the guarantee is stated to the agent');
  assert.equal(r.billing.calls.void.length, 1, 'hold voided on upstream failure');
  assert.equal(r.billing.calls.capture.length, 0);
  const degraded = r.routerDb.prepare('SELECT service_id FROM degraded_candidates').all();
  assert.equal(degraded.length, 1, 'candidate marked degraded locally');
});

test('T7h: a firm quote under the settlement floor skips the candidate instead of settling', async (t) => {
  const { readFileSync } = await import('node:fs');
  const fx = JSON.parse(readFileSync(new URL('./fixtures/settlement.json', import.meta.url), 'utf8'));
  const floorAdapter = {
    name: 'mock',
    minSats: 333,
    payInvoice: async () => { throw new Error('must not settle a below-floor invoice'); }
  };
  const r = await startInvokeRouter({
    adapter: floorAdapter,
    behavior: {
      challengeOverride: {
        wwwAuthenticate: `L402 version="0" token="${'t'.repeat(120)}" invoice="${fx.pingInvoice1sat}"`,
        body: { error: 'Payment required', amountSats: 1 }
      }
    }
  });
  t.after(r.close);
  const res = await callInvoke(r.baseUrl, ARGS);
  assert.ok(res.result.isError, JSON.stringify(res.result).slice(0, 300));
  assert.match(res.result.content[0].text, /ALL_CANDIDATES_FAILED/);
  assert.match(res.result.content[0].text, /under the settlement floor/);
  assert.equal(r.billing.calls.authorize.length, 0, 'no hold for an unsettleable quote');
});
