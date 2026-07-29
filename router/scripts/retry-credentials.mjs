#!/usr/bin/env node
// Re-attempts every L402 credential we paid for but never redeemed. A paid
// credential stays valid after a failed delivery, so a provider that recovers
// turns an absorbed loss back into a delivered job — the ledger row is
// repaired when that happens. Costs nothing: no settlement, no card.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRouterDb } from '../dist/db.js';
import { createLedger } from '../dist/ledger.js';
import { createCredentials, retryUnredeemed } from '../dist/credentials.js';
import { buildRoutes } from '../dist/routes/index.js';
import { loadConfig } from '../dist/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = loadConfig();
const db = openRouterDb(process.env.ROUTER_DATA_DIR || join(__dirname, '..', 'data'));
const creds = createCredentials(db);

const pending = creds.unredeemed();
if (pending.length === 0) {
  console.log('no unredeemed paid credentials — nothing to recover');
  process.exit(0);
}
console.log(`retrying ${pending.length} paid credential(s), ${pending.reduce((n, r) => n + r.settled_sats, 0)} sats at stake:`);

const results = await retryUnredeemed({
  db,
  ledger: createLedger(db),
  creds,
  routes: buildRoutes(['direct-l402', 'l402space']),
  fetchImpl: fetch,
  timeoutMs: Number(process.env.REDEEM_TIMEOUT_MS || 300_000)
});

let recovered = 0;
for (const r of results) {
  const host = new URL(r.upstream).host;
  if (r.delivered) {
    recovered += r.settledSats;
    console.log(`  RECOVERED ${r.settledSats} sats — ${host}: ${r.detail.slice(0, 120)}`);
  } else {
    console.log(`  still failing — ${host} (${r.settledSats} sats): ${r.detail.slice(0, 120)}`);
  }
}
console.log(`recovered ${recovered} sats this pass`);
db.close();
