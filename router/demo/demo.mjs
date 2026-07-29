// Demo driver. Runs the real router in-process and speaks the PRD wire
// protocol to it. `happy` settles real mainnet sats through Golem against a
// live upstream; `fail` proves the guarantee (void on upstream failure) with
// real Stripe against a forced-500 upstream, mock settlement so no sats are
// burned demonstrating a card-side property.
import { createRouterApp } from '../dist/index.js';
import { loadConfig } from '../dist/config.js';

const scenario = process.argv[2];
if (scenario !== 'happy' && scenario !== 'fail') {
  console.error('usage: node demo/demo.mjs happy|fail');
  process.exit(2);
}

const PRINCIPAL = 'demo-agent';
const ARGS = {
  capability: 'llm-completion claude-fable',
  input: 'In one sentence: what did the 402index settlement router just prove?',
  max_price_usd: 1.0
};

if (scenario === 'happy') {
  console.log('T0 SUCCEEDED — settlement is REAL: Golem wallet on Atlas, mainnet sats, Ark → Boltz → Lightning.');
} else {
  console.log('FAIL SCENARIO — real Stripe hold + real void (verified via Stripe API); settlement mocked so no sats are spent proving a card-side property.');
}

const config = loadConfig();
if (scenario === 'fail') config.settlementAdapter = 'mock';

const failFetch = async (url, init = {}) => {
  const u = String(url);
  const auth = init.headers?.Authorization ?? init.headers?.authorization;
  if (u.startsWith('https://l402.space/l402/') && auth) {
    console.log('  [forced] upstream answers 500 (simulating a dead endpoint after settlement)');
    return new Response('upstream exploded', { status: 500 });
  }
  return fetch(url, init);
};

const { app, shutdown, routerDb } = createRouterApp(config, scenario === 'fail' ? { fetchImpl: failFetch } : {});
routerDb.prepare('INSERT OR IGNORE INTO cards (principal, payment_method) VALUES (?, ?)').run(PRINCIPAL, 'pm_card_visa');

const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const baseUrl = `http://127.0.0.1:${server.address().port}`;

let rpcId = 0;
async function callInvoke(extra = {}) {
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
      jsonrpc: '2.0',
      id: rpcId,
      method: 'tools/call',
      params: {
        name: 'invoke',
        arguments: ARGS,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': { elicitation: {} },
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

try {
  console.log(`\n[1] Agent asks for an outcome, not a URL:`);
  console.log(`    invoke({ capability: '${ARGS.capability}', max_price_usd: $${ARGS.max_price_usd.toFixed(2)} })`);
  console.log('    The agent holds a card credential and no crypto wallet.');
  const t0 = Date.now();
  const first = await callInvoke();
  if (first.result?.resultType !== 'input_required') {
    bail('expected input_required on the cold call', first);
  } else {
    const consent = first.result.inputRequests.consent;
    console.log(`\n[2] Router interrupts with a consent question (MRTR, elicitation/create, mode=form):`);
    console.log(`    "${consent.params.message}"`);
    console.log(`    requestState: ${first.result.requestState.length} bytes, opaque to the client`);
    console.log('    Agent approves.');

    const second = await callInvoke({
      inputResponses: { consent: { action: 'accept', content: { approve: true } } },
      requestState: first.result.requestState
    });

    if (scenario === 'happy') {
      if (second.result?.isError) {
        bail('expected a receipt, got an error result', second.result.content?.[0]);
      } else {
        const receipt = second.result._meta['io.402index/receipt'];
        console.log(`\n[3] Settled and delivered in ${((Date.now() - t0) / 1000).toFixed(1)}s total:`);
        const text = second.result.content[0].text;
        let pretty = text;
        try { pretty = JSON.parse(text).choices?.[0]?.message?.content ?? text; } catch {}
        console.log(`    upstream says: ${String(pretty).slice(0, 300)}`);
        console.log(`\n[4] RECEIPT`);
        for (const [k, v] of Object.entries(receipt)) console.log(`    ${k}: ${v}`);
        const pi = await stripeGet(`payment_intents/${receipt.payment_intent}`);
        console.log(`    stripe verification: status=${pi.status} amount_received=$${(pi.amount_received / 100).toFixed(2)}`);
        if (receipt.paid_sats <= 0) bail('receipt paid_sats is not positive');
        else if (pi.status !== 'succeeded') bail(`expected captured intent, Stripe says ${pi.status}`);
        else console.log('\nCard in, crypto out: the agent paid with a card; the provider was paid in sats it can spend.');
      }
    } else {
      if (!second.result?.isError) {
        bail('expected the error result carrying the guarantee', second);
      } else {
        console.log(`\n[3] Upstream failed after settlement. Router's answer to the agent:`);
        console.log(`    "${second.result.content[0].text}"`);
        const piId = /pi_[A-Za-z0-9]+/.exec(second.result.content[0].text)?.[0];
        const pi = piId ? await stripeGet(`payment_intents/${piId}`) : undefined;
        console.log(`\n[4] STRIPE VERIFICATION (live API, intent ${piId})`);
        console.log(`    status=${pi?.status} amount_received=$${((pi?.amount_received ?? 0) / 100).toFixed(2)}`);
        if (pi?.status !== 'canceled') bail(`expected canceled, Stripe says ${pi?.status}`);
        else console.log('\nThe guarantee held: upstream died, the card hold was voided, the agent was charged $0.');
      }
    }
  }
} finally {
  await shutdown();
  server.close();
  process.exit(process.exitCode ?? 0);
}
