import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseX402Challenge, X402ParseError } from '../dist/challenge-x402.js';
import { buildRegistry, SettlementError } from '../dist/settlement/index.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/x402-v2-ping.json', import.meta.url), 'utf8'));

test('M8a: a real captured x402 v2 challenge maps onto PaymentRequest', () => {
  const req = parseX402Challenge(fx.paymentRequiredHeader, { networks: ['eip155:8453'] });
  assert.equal(req.rail, 'x402');
  assert.equal(req.network, 'eip155:8453');
  assert.equal(req.asset, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  assert.equal(req.amount, '10000', 'exact smallest-unit amount, as a string');
  assert.equal(req.amountSats, null, 'not sat-denominated — callers must decide, never coerce');
  assert.equal(req.payTo, '0x85BdB78Ad4C39565F767da6733a071F86BAEDb6b');
  assert.equal(req.extra?.name, 'USD Coin', 'EIP-712 domain name carried through, never hardcoded');
  assert.ok(req.raw.length > 50, 'raw carries the accepts entry');
});

test('M8b: the accepts entry is chosen by settleable network', () => {
  assert.throws(
    () => parseX402Challenge(fx.paymentRequiredHeader, { networks: ['solana:mainnet'] }),
    (err) => err instanceof X402ParseError && err.code === 'NO_SETTLEABLE_NETWORK'
  );
});

test('M8c: malformed base64 or JSON is a typed error', () => {
  assert.throws(
    () => parseX402Challenge('not-base64-json!!!', { networks: ['eip155:8453'] }),
    (err) => err instanceof X402ParseError && err.code === 'MALFORMED'
  );
});

test('M8d: the parsed request selects the x402 stub, which refuses with RAIL_UNAVAILABLE', async () => {
  const req = parseX402Challenge(fx.paymentRequiredHeader, { networks: ['eip155:8453'] });
  const registry = buildRegistry({ settlementAdapter: 'golem', golemCliDir: '/nowhere' });
  const adapter = registry.select(req);
  assert.equal(adapter.name, 'x402-stub');
  await assert.rejects(
    () => adapter.pay(req, { maxSats: 0 }),
    (err) => err instanceof SettlementError && err.code === 'RAIL_UNAVAILABLE'
  );
});
