import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRegistry, SettlementError } from '../dist/settlement/index.js';
import { createGolemSettlement } from '../dist/settlement/golem.js';
import { createMockSettlement } from '../dist/settlement/mock.js';
import { createX402Stub } from '../dist/settlement/x402.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/settlement.json', import.meta.url), 'utf8'));

const l402Req = (over = {}) => ({
  rail: 'l402', network: 'lightning', asset: 'BTC',
  amount: '580', amountSats: 580, payTo: null,
  credential: 'tok', raw: fx.paidInvoice580, expiresAt: null, ...over
});
const x402Req = {
  rail: 'x402', network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  amount: '10000', amountSats: null, payTo: '0x85BdB78',
  credential: '', raw: 'base64stuff', expiresAt: null
};

function registry(pin) {
  return buildRegistry({ settlementAdapter: pin ?? 'golem', golemCliDir: '/nowhere' });
}

test('M4a: an in-range l402/lightning request selects golem', () => {
  const adapter = registry().select(l402Req());
  assert.equal(adapter.name, 'golem');
  assert.equal(adapter.movesRealFunds, true);
});

test('M4b: a request under the settlement floor selects nothing', () => {
  assert.equal(registry().select(l402Req({ amountSats: 100, amount: '100' })), null);
});

test('M4c: an x402 request selects the stub, which refuses to pay with RAIL_UNAVAILABLE', async () => {
  const adapter = registry().select(x402Req);
  assert.equal(adapter.name, 'x402-stub');
  assert.equal(adapter.movesRealFunds, false);
  await assert.rejects(
    () => adapter.pay(x402Req, { maxSats: 2000 }),
    (err) => err instanceof SettlementError && err.code === 'RAIL_UNAVAILABLE' && /EVM|key|USDC/i.test(err.message)
  );
});

test('M4d: an unknown rail selects nothing rather than throwing', () => {
  assert.equal(registry().select({ ...x402Req, rail: 'mpp' }), null);
});

test('M4e: pinning SETTLEMENT_ADAPTER=mock wins over movesRealFunds preference', () => {
  const adapter = registry('mock').select(l402Req());
  assert.equal(adapter.name, 'mock');
  assert.equal(adapter.movesRealFunds, false);
});

test('M4f: golem pays a PaymentRequest through the new pay() surface', async () => {
  const golem = createGolemSettlement({
    golemCliDir: '/nowhere',
    swapsDbPath: '/nonexistent/boltz-swaps.db',
    spawnImpl: async () => ({ stdout: 'Payment sent!\n  Preimage: 9228d3c4...\n  Duration: 8.3s\n  Balance:  48,713 sats\n', exitCode: 0 })
  });
  assert.deepEqual(golem.rails, ['l402']);
  assert.ok(golem.canSettle(l402Req()));
  assert.ok(!golem.canSettle(x402Req), 'golem cannot settle x402');
  // pay() routes through the same swaps-db preimage flow payInvoice used;
  // with no swaps db the preimage check must fail loudly, not silently pass
  await assert.rejects(() => golem.pay(l402Req(), { maxSats: 2000 }), (err) => err instanceof SettlementError);
});

test('M4g: mock settles any rail it claims, deterministically, with movesRealFunds false', async () => {
  const mock = createMockSettlement();
  assert.equal(mock.movesRealFunds, false);
  assert.ok(mock.canSettle(l402Req()));
  const s = await mock.pay(l402Req(), { maxSats: 2000 });
  assert.equal(s.paidSats, 580);
  assert.equal(s.proofKind, 'preimage');
  assert.match(s.proof, /^[0-9a-f]{64}$/);
});
