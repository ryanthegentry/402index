import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startInvokeRouter, callInvoke, UPSTREAM_TEXT } from './helpers/invoke-harness.js';

// Group B — the receipt ships on three surfaces (PRD D4): structuredContent
// against a declared outputSchema, one authored text line the model can read,
// and the existing _meta record for the harness. The authored line matters
// most on 2025-era clients, where _meta never surfaces.

const ARGS = { capability: 'llm-completion claude-fable', input: 'Reply with exactly: pong', max_price_usd: 1.0 };

function seedMandate(routerDb, principal) {
  routerDb
    .prepare(`INSERT INTO mandates (principal, budget_usd, spent_usd, expires_at) VALUES (?, 100, 0, datetime('now', '+7 days'))`)
    .run(principal);
}

test('T11a: a delivered job returns the receipt as structuredContent, an authored line, and _meta', async (t) => {
  const r = await startInvokeRouter();
  t.after(r.close);
  seedMandate(r.routerDb, 'wire-test-agent');
  const res = await callInvoke(r.baseUrl, ARGS);
  assert.ok(!res.result.isError, JSON.stringify(res).slice(0, 400));

  const receipt = res.result.structuredContent;
  assert.ok(receipt, 'structuredContent carries the receipt');
  assert.equal(receipt.paid_sats, 580);
  assert.equal(receipt.charged_usd, 0.5);
  assert.equal(receipt.mandated, true);
  assert.deepEqual(receipt, res.result._meta['io.402index/receipt'], 'one receipt object on both surfaces');

  assert.match(res.result.content[0].text, new RegExp(UPSTREAM_TEXT.slice(0, 10)), 'upstream body stays first');
  const line = res.result.content.at(-1).text;
  assert.match(line, /\$0\.50/, 'authored line shows the card charge');
  assert.match(line, /580 sats/, 'authored line shows the sats paid');
  assert.match(line, /l402space|direct-l402/, 'authored line names the route');
});

test('T11b: tools/list declares the receipt outputSchema', async (t) => {
  const r = await startInvokeRouter();
  t.after(r.close);
  const res = await fetch(`${r.baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-method': 'tools/list'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {}, url: {} } },
          'io.modelcontextprotocol/clientInfo': { name: 'wire-test-agent', version: '1.0.0' }
        }
      }
    })
  });
  const body = await res.json();
  const tool = body.result.tools.find((x) => x.name === 'invoke');
  assert.ok(tool.outputSchema, 'invoke declares an outputSchema');
  assert.ok(tool.outputSchema.properties.paid_sats, 'schema names paid_sats');
  assert.ok(tool.outputSchema.properties.charged_usd, 'schema names charged_usd');
});

test('T11c: a 2025-era client sees the receipt line in content', async (t) => {
  process.env.ROUTER_LEGACY_MODE = 'stateless';
  const r = await startInvokeRouter();
  t.after(async () => {
    delete process.env.ROUTER_LEGACY_MODE;
    await r.close();
  });
  // no clientInfo envelope arrives on a 2025 stateless request, so the
  // principal is unknown-client; it needs a card and a mandate for the
  // single-round-trip mandated path (the only interactive-free legacy path)
  r.routerDb.prepare('INSERT INTO cards (principal, payment_method) VALUES (?, ?)').run('unknown-client', 'pm_card_visa');
  seedMandate(r.routerDb, 'unknown-client');
  const res = await fetch(`${r.baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'invoke', arguments: ARGS }
    })
  });
  const ctype = res.headers.get('content-type') ?? '';
  let body;
  if (ctype.includes('text/event-stream')) {
    const text = await res.text();
    const dataLines = text.split('\n').filter((l) => l.startsWith('data:'));
    body = JSON.parse(dataLines[dataLines.length - 1].slice(5));
  } else {
    body = await res.json();
  }
  assert.ok(body.result, JSON.stringify(body).slice(0, 400));
  assert.ok(!body.result.isError, JSON.stringify(body.result).slice(0, 400));
  const texts = body.result.content.filter((c) => c.type === 'text').map((c) => c.text);
  assert.ok(texts.some((x) => /\$0\.50/.test(x) && /580 sats/.test(x)), `receipt line visible to a legacy client: ${JSON.stringify(texts).slice(0, 300)}`);
});
