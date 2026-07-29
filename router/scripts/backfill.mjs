#!/usr/bin/env node
// One-shot, idempotent: labels the 2026-07-28/29 history in the live ledger.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRouterDb } from '../dist/db.js';
import { backfillJuly29 } from '../dist/backfill.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = openRouterDb(process.env.ROUTER_DATA_DIR || join(__dirname, '..', 'data'));
backfillJuly29(db);
const sums = db.prepare('SELECT COUNT(*) AS n, SUM(sats) AS s, SUM(loss_sats) AS l FROM spend_ledger').get();
console.log(`backfill: ${sums.n} rows, ${sums.s} sats out, ${sums.l} sats lost`);
db.close();
