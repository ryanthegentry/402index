import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Group F, router half — GolemSettlement gains an HTTP transport beside the
// CLI spawner (PRD D6/D7): POST /api/pay-invoice on Golem's Railway server,
// selected by config. Same SettlementAdapter contract, so nothing above the
// adapter boundary changes. The preimage from the wire is verified locally
// against the invoice's payment hash — the transport is never trusted.

const __dirname = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'settlement.json'), 'utf8'));

const OPTS = { baseUrl: 'https://golem.test', apiKey: 'golem-test-key' };

function wireFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  impl.calls = calls;
  return impl;
}

test('T14a: a settled payment returns a verified Settlement with wallet-outflow fee accounting', async () => {
  const { createGolemHttpSettlement } = await import('../dist/settlement/golem-http.js');
  // the payer route's success shape after its red-team round: amountSats is
  // the invoice face value, debitedSats is what actually left the wallet
  const fetchImpl = wireFetch(async () =>
    new Response(JSON.stringify({ preimage: fx.preimage580, amountSats: 580, debitedSats: 581, txid: 'ark-tx-1', durationMs: 8000 }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  );
  const adapter = createGolemHttpSettlement({ ...OPTS, fetchImpl });
  const settlement = await adapter.payInvoice(fx.paidInvoice580, { maxSats: 2000 });

  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://golem.test/api/pay-invoice');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'Bearer golem-test-key');
  assert.deepEqual(JSON.parse(call.init.body), { invoice: fx.paidInvoice580, maxSats: 2000 });

  assert.equal(settlement.proofKind, 'preimage');
  assert.equal(settlement.proof, fx.preimage580);
  assert.equal(settlement.paidSats, 580, 'invoice amount');
  assert.equal(settlement.feeSats, 1, 'debitedSats minus invoice amount — the swap fee the wallet actually paid');
  assert.equal(adapter.name, 'golem-http');
  assert.equal(adapter.movesRealFunds, true);
  assert.equal(adapter.minSats, 333, 'same Boltz floor as the CLI transport');
});

test('T14b: below the Boltz floor fails pre-flight without touching the wire', async () => {
  const { createGolemHttpSettlement } = await import('../dist/settlement/golem-http.js');
  const { SettlementError } = await import('../dist/settlement/index.js');
  const fetchImpl = wireFetch(async () => { throw new Error('must not be called'); });
  const adapter = createGolemHttpSettlement({ ...OPTS, fetchImpl });
  await assert.rejects(
    () => adapter.payInvoice(fx.pingInvoice1sat, { maxSats: 2000 }),
    (err) => err instanceof SettlementError && err.code === 'BELOW_MIN'
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('T14c: over maxSats fails pre-flight without touching the wire', async () => {
  const { createGolemHttpSettlement } = await import('../dist/settlement/golem-http.js');
  const { SettlementError } = await import('../dist/settlement/index.js');
  const fetchImpl = wireFetch(async () => { throw new Error('must not be called'); });
  const adapter = createGolemHttpSettlement({ ...OPTS, fetchImpl });
  await assert.rejects(
    () => adapter.payInvoice(fx.paidInvoice580, { maxSats: 400 }),
    (err) => err instanceof SettlementError && err.code === 'OVER_MAX'
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('T14d: server-side refusals surface their code; a paid mismatch is PREIMAGE_UNAVAILABLE', async () => {
  const { createGolemHttpSettlement } = await import('../dist/settlement/golem-http.js');
  const { SettlementError } = await import('../dist/settlement/index.js');

  const daily = createGolemHttpSettlement({
    ...OPTS,
    fetchImpl: wireFetch(async () =>
      new Response(JSON.stringify({ error: 'daily cap', code: 'DAILY_CAP' }), { status: 429 }))
  });
  await assert.rejects(
    () => daily.payInvoice(fx.paidInvoice580, { maxSats: 2000 }),
    (err) => err instanceof SettlementError && err.code === 'PAY_FAILED' && /DAILY_CAP/.test(err.message)
  );

  // ANY refusal carrying paid:true means sats may have left — regardless of
  // its code (PREIMAGE_MISMATCH, PAY_TIMEOUT, PAY_AMBIGUOUS, or codes the
  // payer route grows later). Never a clean refusal.
  for (const [code, status] of [['PREIMAGE_MISMATCH', 502], ['PAY_TIMEOUT', 504], ['PAY_AMBIGUOUS', 502]]) {
    const paidErr = createGolemHttpSettlement({
      ...OPTS,
      fetchImpl: wireFetch(async () =>
        new Response(JSON.stringify({ error: 'funds state unknown', code, paid: true }), { status }))
    });
    await assert.rejects(
      () => paidErr.payInvoice(fx.paidInvoice580, { maxSats: 2000 }),
      (err) => err instanceof SettlementError && err.code === 'PREIMAGE_UNAVAILABLE',
      `paid:true with ${code} is an outflow with no proof`
    );
  }
});

test('T14e: a wire preimage that does not hash to the payment hash is refused locally', async () => {
  const { createGolemHttpSettlement } = await import('../dist/settlement/golem-http.js');
  const { SettlementError } = await import('../dist/settlement/index.js');
  const adapter = createGolemHttpSettlement({
    ...OPTS,
    fetchImpl: wireFetch(async () =>
      new Response(JSON.stringify({ preimage: 'ff'.repeat(32), amountSats: 581, txid: 't' }), { status: 200 }))
  });
  await assert.rejects(
    () => adapter.payInvoice(fx.paidInvoice580, { maxSats: 2000 }),
    (err) => err instanceof SettlementError && err.code === 'PREIMAGE_UNAVAILABLE'
  );
});

test('T14f: SETTLEMENT_ADAPTER=golem-http pins the HTTP transport in the registry', async () => {
  const { buildRegistry, paymentRequestFromInvoice } = await import('../dist/settlement/index.js');
  const req = paymentRequestFromInvoice(fx.paidInvoice580, 'cred');

  const http = buildRegistry({
    settlementAdapter: 'golem-http',
    golemCliDir: '/nowhere',
    golemHttpUrl: 'https://golem.test',
    golemHttpApiKey: 'k'
  });
  assert.equal(http.select(req).name, 'golem-http');

  const cli = buildRegistry({
    settlementAdapter: 'golem',
    golemCliDir: '/nowhere',
    golemHttpUrl: 'https://golem.test',
    golemHttpApiKey: 'k'
  });
  assert.equal(cli.select(req).name, 'golem', 'the CLI transport stays the default');
});

test('T14g: config refuses golem-http without a URL and key', async () => {
  const { loadConfig } = await import('../dist/config.js');
  const MIN_ENV = { ROUTER_STATE_KEY: 'ab'.repeat(32) };
  assert.throws(
    () => loadConfig({ ...MIN_ENV, SETTLEMENT_ADAPTER: 'golem-http' }),
    /GOLEM_HTTP_URL|GOLEM_HTTP_API_KEY/
  );
  const cfg = loadConfig({
    ...MIN_ENV,
    SETTLEMENT_ADAPTER: 'golem-http',
    GOLEM_HTTP_URL: 'https://golem.test',
    GOLEM_HTTP_API_KEY: 'k'
  });
  assert.equal(cfg.settlementAdapter, 'golem-http');
});
