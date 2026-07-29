import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { selectAdapter, SettlementError } from '../dist/settlement/index.js';
import { createGolemSettlement } from '../dist/settlement/golem.js';
import { createMockSettlement } from '../dist/settlement/mock.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'settlement.json'), 'utf8'));

function fakeSwapsDb(swapRecord) {
  const dir = mkdtempSync(join(tmpdir(), 'swaps-test-'));
  const path = join(dir, 'boltz-swaps.db');
  const db = new Database(path);
  db.exec(`CREATE TABLE boltz_swaps (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL,
    created_at INTEGER NOT NULL, data TEXT NOT NULL
  )`);
  db.prepare('INSERT INTO boltz_swaps (id, type, status, created_at, data) VALUES (?, ?, ?, ?, ?)')
    .run(swapRecord.id, swapRecord.type, swapRecord.status, Date.now(), JSON.stringify(swapRecord));
  db.close();
  return path;
}

test('T6a: selectAdapter picks mock or golem by config', () => {
  const mock = selectAdapter({ settlementAdapter: 'mock', golemCliDir: '/nowhere' });
  assert.equal(mock.name, 'mock');
  const golem = selectAdapter({ settlementAdapter: 'golem', golemCliDir: '/nowhere' });
  assert.equal(golem.name, 'golem');
});

test('T6b: mock settlement is deterministic and spends nothing', async () => {
  const mock = createMockSettlement();
  const a = await mock.payInvoice(fx.paidInvoice580, { maxSats: 2000 });
  const b = await mock.payInvoice(fx.paidInvoice580, { maxSats: 2000 });
  assert.equal(a.preimage, b.preimage, 'same invoice, same synthetic preimage');
  assert.match(a.preimage, /^[0-9a-f]{64}$/);
  assert.equal(a.paidSats, 580, 'paidSats decoded from the bolt11 amount');
  assert.equal(mock.minSats, 0);
});

test('T6c: golem refuses an invoice under the Boltz floor before spawning', async () => {
  const golem = createGolemSettlement({
    golemCliDir: '/nowhere',
    spawnImpl: () => { throw new Error('spawn must not be called for a below-floor invoice'); }
  });
  assert.equal(golem.minSats, 333);
  await assert.rejects(
    () => golem.payInvoice(fx.pingInvoice1sat, { maxSats: 2000 }),
    (err) => err instanceof SettlementError && err.code === 'BELOW_MIN'
  );
});

test('T6d: golem refuses an invoice over maxSats before spawning', async () => {
  const golem = createGolemSettlement({
    golemCliDir: '/nowhere',
    spawnImpl: () => { throw new Error('spawn must not be called for an over-max invoice'); }
  });
  await assert.rejects(
    () => golem.payInvoice(fx.paidInvoice580, { maxSats: 500 }),
    (err) => err instanceof SettlementError && err.code === 'OVER_MAX'
  );
});

test('T6e: golem parses CLI success, reads the full preimage from the swaps db, and verifies it', async () => {
  const swapsDbPath = fakeSwapsDb(fx.swapRecord);
  const golem = createGolemSettlement({
    golemCliDir: '/nowhere',
    swapsDbPath,
    spawnImpl: async () => ({
      stdout: 'Connecting to Ark server...\nPaying Lightning invoice (Ark → Boltz → Lightning)...\n\nPayment sent!\n  Preimage: 9228d3c4...\n  Duration: 8.3s\n  Balance:  48,713 sats\n',
      exitCode: 0
    })
  });
  const result = await golem.payInvoice(fx.paidInvoice580, { maxSats: 2000 });
  assert.equal(result.preimage, fx.preimage580, 'full 64-hex preimage from swaps db');
  assert.equal(result.paidSats, 580);
  assert.equal(result.feeSats, 1, 'expectedAmount 581 minus invoice 580');
});

test('T6f: golem CLI failure surfaces as PAY_FAILED with the CLI error text', async () => {
  const golem = createGolemSettlement({
    golemCliDir: '/nowhere',
    spawnImpl: async () => ({
      stdout: 'Connecting to Ark server...\nError: Boltz API error: 400 {"error":"1 is less than minimal of 333"}\n',
      exitCode: 1
    })
  });
  await assert.rejects(
    () => golem.payInvoice(fx.paidInvoice580, { maxSats: 2000 }),
    (err) => err instanceof SettlementError && err.code === 'PAY_FAILED' && /Boltz API error/.test(err.message)
  );
});

test('T6g: golem rejects a swaps-db preimage that does not match the invoice payment hash', async () => {
  const doctored = structuredClone(fx.swapRecord);
  doctored.preimage = 'f'.repeat(64);
  const swapsDbPath = fakeSwapsDb(doctored);
  const golem = createGolemSettlement({
    golemCliDir: '/nowhere',
    swapsDbPath,
    spawnImpl: async () => ({ stdout: 'Payment sent!\n  Preimage: ffffffff...\n', exitCode: 0 })
  });
  await assert.rejects(
    () => golem.payInvoice(fx.paidInvoice580, { maxSats: 2000 }),
    (err) => err instanceof SettlementError && err.code === 'PREIMAGE_UNAVAILABLE'
  );
});
