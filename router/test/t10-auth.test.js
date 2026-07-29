import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startInvokeRouter, UPSTREAM_TEXT } from './helpers/invoke-harness.js';

// Group A — bearer auth and per-principal caps (hosted-settlement-router PRD,
// D3/D9). Identity comes from the token, never from clientInfo; revocation is
// by value and takes effect without a restart; per-principal spend caps hold
// beside the global ones.

const ARGS = { capability: 'llm-completion claude-fable', input: 'Reply with exactly: pong', max_price_usd: 1.0 };
const MIN_ENV = { ROUTER_STATE_KEY: 'ab'.repeat(32) };

// startInvokeRouter with auth-mode env applied for the duration of the router.
async function startAuthRouter(extraEnv = {}, overrides = {}) {
  const applied = { ROUTER_AUTH_MODE: 'required', ...extraEnv };
  const saved = {};
  for (const [k, v] of Object.entries(applied)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  try {
    const r = await startInvokeRouter(overrides);
    return { ...r, close: async () => { restore(); await r.close(); } };
  } catch (err) {
    restore();
    throw err;
  }
}

// Raw wire call carrying an Authorization header; returns HTTP status + body.
let rpcId = 9000;
async function callAuthed(baseUrl, args, { token, clientName = 'wire-test-agent', inputResponses, requestState } = {}) {
  rpcId += 1;
  const params = {
    name: 'invoke',
    arguments: args,
    _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {}, url: {} } },
      'io.modelcontextprotocol/clientInfo': { name: clientName, version: '1.0.0' }
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
      'mcp-name': 'invoke',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method: 'tools/call', params })
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
  return { status: res.status, body };
}

const settledOk = {
  name: 'fake-golem',
  minSats: 333,
  movesRealFunds: true,
  payInvoice: async () => ({
    proof: 'aa'.repeat(32), proofKind: 'preimage', preimage: 'aa'.repeat(32),
    paidSats: 580, paidAmount: '580', feeSats: 0, durationMs: 5
  })
};

test('T10a: config refuses a non-loopback bind without auth required', async () => {
  const { loadConfig } = await import('../dist/config.js');
  assert.throws(
    () => loadConfig({ ...MIN_ENV, ROUTER_BIND_HOST: '0.0.0.0' }),
    /ROUTER_AUTH_MODE/,
    'open port without bearer auth must refuse to configure'
  );
  const cfg = loadConfig({ ...MIN_ENV, ROUTER_BIND_HOST: '0.0.0.0', ROUTER_AUTH_MODE: 'required' });
  assert.equal(cfg.authMode, 'required');
  assert.equal(cfg.bindHost, '0.0.0.0');
  const local = loadConfig(MIN_ENV);
  assert.equal(local.authMode, 'off');
  assert.equal(local.bindHost, '127.0.0.1');
  // Railway hands the listen port over as PORT; ROUTER_PORT still wins locally
  assert.equal(loadConfig({ ...MIN_ENV, PORT: '8080' }).port, 8080);
  assert.equal(loadConfig({ ...MIN_ENV, PORT: '8080', ROUTER_PORT: '4402' }).port, 4402);
});

test('T10b: unauthenticated and garbage-token requests to /mcp get HTTP 401 and never reach billing', async (t) => {
  const r = await startAuthRouter();
  t.after(r.close);
  const bare = await callAuthed(r.baseUrl, ARGS, {});
  assert.equal(bare.status, 401, JSON.stringify(bare.body).slice(0, 200));
  const garbage = await callAuthed(r.baseUrl, ARGS, { token: '402r_' + 'ff'.repeat(24) });
  assert.equal(garbage.status, 401);
  assert.equal(r.billing.calls.authorize.length, 0, 'no card hold on an unauthenticated request');
});

test('T10c: the token names the principal; clientInfo cannot impersonate', async (t) => {
  const r = await startAuthRouter();
  t.after(r.close);
  const { issueToken } = await import('../dist/auth.js');
  const aliceToken = issueToken(r.routerDb, 'alice');
  r.routerDb.prepare('INSERT INTO cards (principal, payment_method) VALUES (?, ?)').run('alice', 'pm_card_alice');
  // clientInfo claims a principal with no card; if clientInfo won, this would
  // be a registration elicitation. The token's principal (alice, card on file)
  // must win, so it is a consent elicitation.
  const res = await callAuthed(r.baseUrl, ARGS, { token: aliceToken, clientName: 'mallory' });
  assert.equal(res.status, 200);
  assert.equal(res.body.result.resultType, 'input_required', JSON.stringify(res.body).slice(0, 300));
  assert.ok(res.body.result.inputRequests.consent, 'consent flow for the token principal, not registration for the claimed one');
});

test('T10d: revocation by value takes effect without a restart', async (t) => {
  const r = await startAuthRouter();
  t.after(r.close);
  const { issueToken, revokeToken } = await import('../dist/auth.js');
  const token = issueToken(r.routerDb, 'alice');
  r.routerDb.prepare('INSERT INTO cards (principal, payment_method) VALUES (?, ?)').run('alice', 'pm_card_alice');
  const before = await callAuthed(r.baseUrl, ARGS, { token });
  assert.equal(before.status, 200, 'token works before revocation');
  assert.equal(revokeToken(r.routerDb, token), true);
  const after = await callAuthed(r.baseUrl, ARGS, { token });
  assert.equal(after.status, 401, 'revoked token is refused on the very next request');
});

test('T10e: another principal\'s token cannot spend against this principal\'s mandate', async (t) => {
  const r = await startAuthRouter({}, { adapter: settledOk });
  t.after(r.close);
  const { issueToken } = await import('../dist/auth.js');
  // alice holds a generous standing budget; bob holds a card and his own token
  r.routerDb
    .prepare("INSERT INTO mandates (principal, budget_usd, spent_usd, expires_at) VALUES ('alice', 100, 0, datetime('now', '+7 days'))")
    .run();
  r.routerDb.prepare('INSERT INTO cards (principal, payment_method) VALUES (?, ?)').run('bob', 'pm_card_bob');
  const bobToken = issueToken(r.routerDb, 'bob');
  const res = await callAuthed(r.baseUrl, ARGS, { token: bobToken, clientName: 'alice' });
  assert.equal(res.status, 200);
  assert.equal(res.body.result.resultType, 'input_required', 'bob has no mandate, so bob gets the consent round');
  const alice = r.routerDb.prepare("SELECT spent_usd FROM mandates WHERE principal = 'alice'").get();
  assert.equal(alice.spent_usd, 0, 'alice\'s mandate is untouched');
});

test('T10f: a token-scoped per-job cap rejects the job before any money moves', async (t) => {
  const r = await startAuthRouter();
  t.after(r.close);
  const { issueToken } = await import('../dist/auth.js');
  const token = issueToken(r.routerDb, 'alice', { maxSatsPerJob: 100 });
  r.routerDb.prepare('INSERT INTO cards (principal, payment_method) VALUES (?, ?)').run('alice', 'pm_card_alice');
  const res = await callAuthed(r.baseUrl, ARGS, { token });
  assert.equal(res.status, 200);
  assert.ok(res.body.result.isError, JSON.stringify(res.body).slice(0, 300));
  assert.match(res.body.result.content[0].text, /PRINCIPAL_JOB_CAP/, 'the 580-sat quote exceeds the 100-sat token cap');
});

test('T10g: the per-principal total cap counts only that principal\'s ledger rows', async (t) => {
  const r = await startAuthRouter({ ROUTER_PRINCIPAL_MAX_TOTAL_SATS: '1000' });
  t.after(r.close);
  const { issueToken } = await import('../dist/auth.js');
  const aliceToken = issueToken(r.routerDb, 'alice');
  const bobToken = issueToken(r.routerDb, 'bob');
  for (const p of ['alice', 'bob']) {
    r.routerDb.prepare('INSERT INTO cards (principal, payment_method) VALUES (?, ?)').run(p, `pm_card_${p}`);
  }
  // alice has already spent 600 sats; the 580-sat job would take her to 1180 > 1000
  r.routerDb.prepare('INSERT INTO spend_ledger (sats, upstream, principal) VALUES (600, ?, ?)').run('https://example.com', 'alice');
  const aliceRes = await callAuthed(r.baseUrl, ARGS, { token: aliceToken });
  assert.ok(aliceRes.body.result.isError, JSON.stringify(aliceRes.body).slice(0, 300));
  assert.match(aliceRes.body.result.content[0].text, /PRINCIPAL_TOTAL_CAP/);
  // bob has spent nothing; the same job proceeds to consent
  const bobRes = await callAuthed(r.baseUrl, ARGS, { token: bobToken });
  assert.equal(bobRes.body.result.resultType, 'input_required', JSON.stringify(bobRes.body).slice(0, 300));
});

test('T10i: a host allow-list refuses requests for unlisted hosts before auth runs', async (t) => {
  const r = await startAuthRouter({ ROUTER_ALLOWED_HOSTS: 'router.402index.io' });
  t.after(r.close);
  const { issueToken } = await import('../dist/auth.js');
  const token = issueToken(r.routerDb, 'alice');
  // the harness calls via 127.0.0.1:<port>, which is not on the list
  const res = await callAuthed(r.baseUrl, ARGS, { token });
  assert.equal(res.status, 421, JSON.stringify(res.body).slice(0, 200));
  // and an unset list (default) keeps serving — covered by every other test here
});

test('T10h: a mandated settlement records the token principal on the ledger row', async (t) => {
  const r = await startAuthRouter({}, { adapter: settledOk });
  t.after(r.close);
  const { issueToken } = await import('../dist/auth.js');
  const token = issueToken(r.routerDb, 'alice');
  r.routerDb.prepare('INSERT INTO cards (principal, payment_method) VALUES (?, ?)').run('alice', 'pm_card_alice');
  r.routerDb
    .prepare("INSERT INTO mandates (principal, budget_usd, spent_usd, expires_at) VALUES ('alice', 100, 0, datetime('now', '+7 days'))")
    .run();
  const res = await callAuthed(r.baseUrl, ARGS, { token });
  assert.equal(res.status, 200);
  assert.ok(!res.body.result.isError, JSON.stringify(res.body).slice(0, 400));
  assert.match(res.body.result.content[0].text, new RegExp(UPSTREAM_TEXT.slice(0, 10)));
  const row = r.routerDb.prepare('SELECT principal, sats FROM spend_ledger ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.principal, 'alice', 'spend is attributed to the token principal');
  assert.equal(row.sats, 580);
});
