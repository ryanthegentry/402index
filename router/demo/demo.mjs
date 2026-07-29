// Demo driver, multirail edition. Runs the real router in-process and speaks
// the MCP 2026-07-28 wire protocol to it.
//
//   live     the showpiece: cold start → real Checkout URL → first paid call
//            with a standing budget → a mandated call with ZERO interruptions.
//            Real mainnet sats over the direct-L402 route. TTFP on display.
//   compare  one real job forced through the l402.space gateway, then prints
//            the direct-vs-gateway ledger rows side by side.
//   fail     the guarantee: upstream dies after settlement → hold voided,
//            $0 charged, verified against the live Stripe API.
import { createRouterApp } from '../dist/index.js';
import { loadConfig } from '../dist/config.js';
import { createLedger } from '../dist/ledger.js';

const scenario = process.argv[2];
if (!['live', 'happy', 'compare', 'fail', 'books'].includes(scenario ?? '')) {
  console.error('usage: node demo/demo.mjs live|compare|fail|books   (happy = live)');
  process.exit(2);
}
const mode = scenario === 'happy' ? 'live' : scenario;

const PRINCIPAL = 'demo-agent';
const ask = (input) => ({ capability: 'llm-completion claude-fable', input, max_price_usd: 1.0 });

const config = loadConfig();
if (mode === 'fail') config.settlementAdapter = 'mock';

const failFetch = async (url, init = {}) => {
  const auth = init.headers?.Authorization ?? init.headers?.authorization;
  if (auth) {
    console.log('  [forced] upstream answers 500 on redemption (simulating a dead endpoint after settlement)');
    return new Response('upstream exploded', { status: 500 });
  }
  return fetch(url, init);
};

const { app, shutdown, routerDb } = createRouterApp(config, mode === 'fail' ? { fetchImpl: failFetch } : {});
const ledger = createLedger(routerDb);

const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const baseUrl = `http://127.0.0.1:${server.address().port}`;

let rpcId = 0;
async function invoke(args, extra = {}) {
  rpcId += 1;
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-method': 'tools/call',
      'mcp-name': 'invoke'
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: rpcId, method: 'tools/call',
      params: {
        name: 'invoke', arguments: args,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {}, url: {} } },
          'io.modelcontextprotocol/clientInfo': { name: PRINCIPAL, version: '1.0.0' }
        },
        ...extra
      }
    })
  });
  return res.json();
}

async function stripeGet(path) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Basic ${Buffer.from(process.env.STRIPE_SECRET_KEY + ':').toString('base64')}` }
  });
  return res.json();
}

function bail(msg, payload) {
  console.error(`\nDEMO FAILED: ${msg}`);
  if (payload) console.error(JSON.stringify(payload).slice(0, 800));
  process.exitCode = 1;
}

function printReceipt(receipt, wallSeconds) {
  console.log('    ┌─ RECEIPT ─────────────────────────────────────');
  console.log(`    │ route          ${receipt.route}   rail ${receipt.rail}`);
  console.log(`    │ paid_sats      ${receipt.paid_sats}   charged $${receipt.charged_usd.toFixed(2)}`);
  console.log(`    │ upstream       ${new URL(receipt.upstream).host}`);
  console.log(`    │ payment_intent ${receipt.payment_intent}`);
  console.log(`    │ mandated       ${receipt.mandated}`);
  const st = receipt.stage_timings ?? {};
  const fmt = (k) => (st[k] !== undefined ? `${(st[k] / 1000).toFixed(1)}s` : '—');
  console.log(`    │ stages         quote ${fmt('quote_ms')} · authorize ${fmt('authorize_ms')} · consent-wait ${fmt('consent_wait_ms')} · settle ${fmt('settle_ms')} · redeem ${fmt('redeem_ms')}`);
  console.log(`    └─ TTFP (wall clock): ${wallSeconds.toFixed(1)}s`);
}

function latestLedgerRow() {
  return routerDb.prepare('SELECT * FROM spend_ledger ORDER BY id DESC LIMIT 1').get();
}

try {
  if (mode === 'live') {
    console.log('CARD IN, CRYPTO OUT — live demo. Real mainnet sats over the direct-L402 route; Stripe test-mode card.');
    console.log('KPI on display: TTFP — time from agent query to first paid endpoint response.\n');

    // ACT 1 — a genuinely cold agent
    routerDb.prepare('DELETE FROM cards WHERE principal = ?').run(PRINCIPAL);
    routerDb.prepare('DELETE FROM mandates WHERE principal = ?').run(PRINCIPAL);
    routerDb.prepare('DELETE FROM pending_registrations WHERE principal = ?').run(PRINCIPAL);

    console.log('[1] COLD START — the agent has no card registered anywhere:');
    const t0 = Date.now();
    const cold = await invoke(ask('warmup'));
    if (cold.result?.inputRequests?.register?.params?.mode !== 'url') {
      bail('expected the url-mode registration elicitation', cold);
      throw new Error('halt');
    }
    const checkoutUrl = cold.result.inputRequests.register.params.url;
    console.log('    Router answers with a REAL Stripe Checkout page, minted in-loop:');
    console.log(`    ${checkoutUrl}`);
    console.log('    One tap, once ever. (Headless demo: simulating the tap via the cards table;');
    console.log('    the hosted page cannot be completed by API, so the shown session is expired cleanly.)');
    routerDb.prepare('INSERT INTO cards (principal, payment_method) VALUES (?, ?)').run(PRINCIPAL, 'pm_card_visa');
    const { createRegistration } = await import('../dist/registration.js');
    await createRegistration(routerDb, { stripeSecretKey: config.stripeSecretKey }).abandon(PRINCIPAL);

    // ACT 2 — first paid call: consent once, grant a standing budget
    console.log('\n[2] FIRST PAID CALL — the router quotes, holds the card, and asks once:');
    const t1 = Date.now();
    const q1 = ask('In one sentence: what does a settlement router prove when it pays a Lightning invoice for a card?');
    const first = await invoke(q1);
    if (first.result?.resultType !== 'input_required' || !first.result.inputRequests?.consent) {
      bail('expected the consent interruption', first);
      throw new Error('halt');
    }
    console.log(`    "${first.result.inputRequests.consent.params.message.split(' Optionally')[0]}"`);
    console.log('    Agent approves AND grants a standing budget: $2.00 over 7 days.');
    const second = await invoke(q1, {
      inputResponses: { consent: { action: 'accept', content: { approve: true, standing_budget_usd: 2, standing_budget_days: 7 } } },
      requestState: first.result.requestState
    });
    if (second.result?.isError) {
      bail('first paid call failed', second.result.content?.[0]);
      throw new Error('halt');
    }
    const r1 = second.result._meta['io.402index/receipt'];
    let text1 = second.result.content[0].text;
    try { text1 = JSON.parse(text1).response ?? text1; } catch {}
    console.log(`    upstream says: ${String(text1).slice(0, 140)}`);
    printReceipt(r1, (Date.now() - t1) / 1000);

    // ACT 3 — the kill shot: zero interruptions under the mandate
    console.log('\n[3] SECOND CALL — the standing budget covers it. NO consent round. One round trip:');
    const t2 = Date.now();
    const q2 = ask('Reply with exactly: the router now pays without asking, under a $2 budget');
    const third = await invoke(q2);
    if (third.result?.resultType !== 'complete' || third.result?.isError) {
      bail('expected a single-round mandated completion', third);
      throw new Error('halt');
    }
    const r2 = third.result._meta['io.402index/receipt'];
    let text2 = third.result.content[0].text;
    try { text2 = JSON.parse(text2).response ?? text2; } catch {}
    console.log(`    upstream says: ${String(text2).slice(0, 140)}`);
    printReceipt(r2, (Date.now() - t2) / 1000);

    // ACT 4 — the books
    console.log('\n[4] THE BOOKS — every underwritten job, reconciled to the sat:');
    const s = ledger.summary();
    for (const r of s.perRoute) {
      console.log(`    ${r.route.padEnd(12)} jobs=${r.jobs} delivered=${r.delivered} lost=${r.lost} sats=${r.sats} absorbed=${r.lossSats}`);
    }
    console.log(`    loss rate ${(s.lossRate * 100).toFixed(1)}% — the number only the underwriter can publish.`);
    const pi = await stripeGet(`payment_intents/${r2.payment_intent}`);
    console.log(`    stripe: ${r2.payment_intent} → ${pi.status}, $${(pi.amount_received / 100).toFixed(2)} received`);
    const m = routerDb.prepare('SELECT budget_usd, spent_usd FROM mandates WHERE principal = ?').get(PRINCIPAL);
    console.log(`    mandate: $${m.spent_usd.toFixed(2)} of $${m.budget_usd.toFixed(2)} used`);
    console.log(`\nCold start to first paid response: ${((Date.now() - t0) / 1000).toFixed(1)}s including registration.`);
    console.log(`Marginal TTFP under the mandate: ${((Date.now() - t2) / 1000).toFixed(1)}s, zero interruptions.`);
  }

  if (mode === 'compare') {
    console.log('TWO ROUTES, ONE UPSTREAM — the gateway leg, for the ledger comparison.\n');
    routerDb.prepare('INSERT OR IGNORE INTO cards (principal, payment_method) VALUES (?, ?)').run(PRINCIPAL, 'pm_card_visa');
    // show the consent flow deterministically — a live-run mandate would skip it
    routerDb.prepare('DELETE FROM mandates WHERE principal = ?').run(PRINCIPAL);
    const q = ask('Reply with exactly: this job went through the gateway');
    const first = await invoke(q);
    if (first.result?.resultType !== 'input_required') { bail('expected consent', first); throw new Error('halt'); }
    const res = await invoke(q, {
      inputResponses: { consent: { action: 'accept', content: { approve: true } } },
      requestState: first.result.requestState
    });
    if (res.result?.isError) { bail('gateway job failed', res.result.content?.[0]); throw new Error('halt'); }
    const receipt = res.result._meta['io.402index/receipt'];
    printReceipt(receipt, 0);
    console.log('\nDirect vs gateway for the same upstream, from the loss ledger:');
    const rows = routerDb
      .prepare(`SELECT route, settled_sats, delivered FROM spend_ledger
                WHERE upstream LIKE '%lightningfaucet%' AND settled_sats IS NOT NULL
                ORDER BY id DESC LIMIT 6`)
      .all();
    for (const row of rows) {
      console.log(`    ${row.route.padEnd(12)} settled=${row.settled_sats} sats delivered=${row.delivered}`);
    }
    const direct = rows.find((r) => r.route === 'direct-l402');
    const gw = rows.find((r) => r.route === 'l402space');
    if (direct && gw) {
      const margin = gw.settled_sats - direct.settled_sats;
      console.log(`    gateway premium on this pair: ${margin} sats (${((margin / direct.settled_sats) * 100).toFixed(0)}%) — margin the direct route keeps.`);
    }
  }

  if (mode === 'books') {
    console.log('THE LOSS LEDGER — settlement-verified delivery, the dataset only the underwriter can write.\n');
    const s = ledger.summary();
    for (const r of s.perRoute) {
      console.log(`  ${r.route.padEnd(12)} jobs=${r.jobs} delivered=${r.delivered} lost=${r.lost} sats=${r.sats} absorbed=${r.lossSats}`);
    }
    console.log(`  absorbed-loss rate: ${(s.lossRate * 100).toFixed(1)}%`);
    console.log('\nSame upstream, both routes (lightningfaucet.com):');
    const rows = routerDb
      .prepare(`SELECT route, settled_sats, delivered, failure_reason FROM spend_ledger
                WHERE upstream LIKE '%lightningfaucet%' AND settled_sats IS NOT NULL ORDER BY id`)
      .all();
    for (const row of rows) {
      console.log(`  ${row.route.padEnd(12)} settled=${row.settled_sats} delivered=${row.delivered}${row.failure_reason ? ` (${row.failure_reason})` : ''}`);
    }
    console.log('\nThe gateway scores this host 1.000 reliability on its own books. Ours show the losses.');
  }

  if (mode === 'fail') {
    console.log('FAIL SCENARIO — real Stripe hold + real void (verified via Stripe API); settlement mocked so no sats are spent proving a card-side property.\n');
    routerDb.prepare('INSERT OR IGNORE INTO cards (principal, payment_method) VALUES (?, ?)').run(PRINCIPAL, 'pm_card_visa');
    routerDb.prepare('DELETE FROM mandates WHERE principal = ?').run(PRINCIPAL);
    const q = ask('this call is doomed by design');
    const first = await invoke(q);
    if (first.result?.resultType !== 'input_required') { bail('expected consent', first); throw new Error('halt'); }
    console.log(`[1] Consent: "${first.result.inputRequests.consent.params.message.split(' Optionally')[0]}" — agent approves.`);
    const res = await invoke(q, {
      inputResponses: { consent: { action: 'accept', content: { approve: true } } },
      requestState: first.result.requestState
    });
    if (!res.result?.isError) { bail('expected the guarantee error', res); throw new Error('halt'); }
    console.log(`[2] Router: "${res.result.content[0].text}"`);
    const piId = /pi_[A-Za-z0-9]+/.exec(res.result.content[0].text)?.[0];
    const pi = piId ? await stripeGet(`payment_intents/${piId}`) : undefined;
    console.log(`[3] Stripe verification: ${piId} → status=${pi?.status} amount_received=$${((pi?.amount_received ?? 0) / 100).toFixed(2)}`);
    if (pi?.status !== 'canceled') bail(`expected canceled, Stripe says ${pi?.status}`);
    else console.log('\nThe guarantee held: upstream died, the hold was voided, the agent was charged $0.');
  }
} catch (err) {
  if (err.message !== 'halt') throw err;
} finally {
  await shutdown();
  server.close();
  process.exit(process.exitCode ?? 0);
}
