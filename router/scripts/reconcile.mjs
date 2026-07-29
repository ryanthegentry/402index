#!/usr/bin/env node
// Prints the loss ledger beside the live Golem wallet and exits non-zero on
// any mismatch or unresolved in-flight row. The wallet baseline is the
// 2026-07-28 funding amount unless overridden.
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRouterDb } from '../dist/db.js';
import { createLedger } from '../dist/ledger.js';
import { parseGolemBalance, computeReconciliation } from '../dist/backfill.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.ROUTER_DATA_DIR || join(__dirname, '..', 'data');
const baselineSats = Number(process.env.WALLET_BASELINE_SATS || 49875);
const golemDir = process.env.GOLEM_CLI_DIR || join(process.env.HOME || '', 'workspace', 'projects', 'golem');

function golemBalance() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['dist/cli/index.js', 'balance'], { cwd: golemDir, env: process.env });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('golem balance timed out')); }, 60_000);
    const check = () => {
      const sats = parseGolemBalance(out);
      if (sats !== null) { clearTimeout(timer); child.kill('SIGKILL'); resolve(sats); }
    };
    child.stdout.on('data', (c) => { out += c.toString(); check(); });
    child.stderr.on('data', (c) => { out += c.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

const db = openRouterDb(dataDir);
const ledger = createLedger(db);
const summary = ledger.summary();
const unresolved = ledger.unresolved(Number(process.env.REDEEM_TIMEOUT_MS || 300_000));
const walletSats = await golemBalance();
const rec = computeReconciliation({ ledgerSats: summary.totalSats, baselineSats, walletSats });

console.log('== 402index loss ledger ==');
console.log(`ledger outflow:   ${summary.totalSats} sats across ${summary.perRoute.reduce((n, r) => n + r.jobs, 0)} jobs`);
console.log(`absorbed losses:  ${summary.lossSats} sats (loss rate ${(summary.lossRate * 100).toFixed(1)}%)`);
for (const r of summary.perRoute) {
  console.log(`  ${r.route.padEnd(12)} jobs=${r.jobs} delivered=${r.delivered} lost=${r.lost} inFlight=${r.inFlight} sats=${r.sats} loss=${r.lossSats}`);
}
console.log('== wallet ==');
console.log(`baseline ${baselineSats} − balance ${walletSats} = delta ${rec.walletDelta} sats`);
console.log(rec.match ? 'RECONCILED to the sat.' : `MISMATCH: ledger ${rec.ledgerSats} vs wallet delta ${rec.walletDelta} (off by ${rec.discrepancy})`);
if (unresolved.length > 0) {
  console.log(`UNRESOLVED in-flight rows past the redeem timeout: ${JSON.stringify(unresolved)}`);
}
db.close();
process.exit(rec.match && unresolved.length === 0 ? 0 : 1);
