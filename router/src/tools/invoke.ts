import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { inputRequired, type McpServer } from '@modelcontextprotocol/server';
import type { Database } from 'better-sqlite3';
import type { RouterConfig } from '../config.js';
import { canonicalArgsDigest, mintState, verifyState, StateError, type StatePayload } from '../state.js';
import { fetchCandidates, fetchQuote, type Candidate } from '../quote.js';
import { GuardError, type createGuards } from '../guards.js';
import { SettlementError, type SettlementAdapter, type Settlement } from '../settlement/index.js';

// The MRTR state machine. Cold call: pick a candidate from the live index,
// get a firm quote from l402.space, authorize the card hold, ask consent.
// Approved retry: verify state, settle over Lightning, redeem, capture.
// Any failure after authorization voids the hold — the agent pays only for
// delivered results.

const MIN_CHARGE_USD = 0.5; // Stripe's PaymentIntent floor; the binding inbound constraint
const MAX_DEAD_CANDIDATES = 3;
const DEFAULT_REDEEM_TIMEOUT_MS = 300_000; // an impatient redeem burns the credit (see NOTES.md)

interface BillingLike {
  authorize(quotedUsd: number, opts?: { paymentMethod?: string }): Promise<{ paymentIntentId: string; chargedUsd: number }>;
  capture(paymentIntentId: string): Promise<{ status: string }>;
  void(paymentIntentId: string): Promise<{ status: string }>;
}

export interface InvokeDeps {
  config: RouterConfig;
  routerDb: Database;
  guards: ReturnType<typeof createGuards>;
  billing: BillingLike;
  adapter: SettlementAdapter;
  fetchImpl: typeof fetch;
  btcUsd: () => Promise<number>;
  redeemTimeoutMs?: number;
  // Mints the card-registration URL for the cold-start path. The default
  // cannot mint a live Stripe Checkout URL: the restricted key lacks
  // setup_intents/checkout.sessions write scope (probed 2026-07-28,
  // more_permissions_required).
  checkoutUrlFactory?: (principal: string) => Promise<string>;
}

interface McpReqSurface {
  requestState?: <T>() => T | undefined;
  inputResponses?: Record<string, unknown>;
  envelope?: Record<string, unknown>;
}

const invokeArgs = z.object({
  capability: z.string(),
  input: z.string(),
  max_price_usd: z.number().positive()
});
type InvokeArgs = z.infer<typeof invokeArgs>;

function errResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

function principalOf(mcpReq: McpReqSurface): string {
  const env = mcpReq.envelope ?? {};
  const info = (env['io.modelcontextprotocol/clientInfo'] ?? env['clientInfo']) as
    | { name?: string }
    | undefined;
  return info?.name ?? 'unknown-client';
}

// The router only knows how to phrase one capability family for now: an
// OpenAI-style chat body for POST endpoints, a prompt query param for GET.
// A real product would drive this from the index's input_schema.
function buildUpstreamRequest(candidate: Candidate, input: string): { url: string; method: string; body?: string } {
  if (candidate.httpMethod.toUpperCase() === 'POST') {
    // max_tokens sizes the job: LLM endpoints price per requested ceiling
    // (llm402.ai: ~100 sats/1000 tokens on fable-tier, ~4x that on premium
    // tiers), and jobs under the 333-sat Boltz floor cannot settle over
    // Lightning at all. 4000 keeps the whole candidate ladder inside the
    // 333-sat floor and the 2000-sat per-job cap.
    return {
      url: candidate.url,
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: input }], max_tokens: 4000 })
    };
  }
  const sep = candidate.url.includes('?') ? '&' : '?';
  return { url: `${candidate.url}${sep}prompt=${encodeURIComponent(input)}`, method: 'GET' };
}

export function registerInvokeTool(server: McpServer, deps: InvokeDeps): void {
  server.registerTool(
    'invoke',
    {
      description:
        'Acquire a capability by outcome: 402index finds a paid endpoint, quotes a firm USD price, ' +
        'asks your consent, then pays the provider on its own rail and returns the result. ' +
        'You are charged only when the result is delivered.',
      inputSchema: invokeArgs
    },
    async (args: InvokeArgs, ctx: unknown) => {
      const mcpReq = (ctx as { mcpReq?: McpReqSurface }).mcpReq ?? {};
      const principal = principalOf(mcpReq);
      const argsDigest = canonicalArgsDigest(args);
      const rawState = mcpReq.requestState?.<string>();
      if (typeof rawState === 'string') {
        return handleRetry(deps, mcpReq, args, principal, argsDigest, rawState);
      }
      return handleColdCall(deps, args, principal, argsDigest);
    }
  );
}

async function handleColdCall(deps: InvokeDeps, args: InvokeArgs, principal: string, argsDigest: string) {
  console.log(`[invoke] cold call from "${principal}": ${args.capability} (max $${args.max_price_usd})`);
  const card = deps.routerDb
    .prepare('SELECT payment_method FROM cards WHERE principal = ?')
    .get(principal) as { payment_method: string } | undefined;
  if (!card) {
    const factory =
      deps.checkoutUrlFactory ??
      (async () => {
        throw new Error(
          'cold-start registration URL unavailable: the restricted Stripe key lacks setup_intents/checkout.sessions write scope'
        );
      });
    let url: string;
    try {
      url = await factory(principal);
    } catch (err) {
      return errResult(`REGISTRATION_UNAVAILABLE: ${(err as Error).message}`);
    }
    return inputRequired({
      inputRequests: {
        register: inputRequired.elicitUrl({
          message: 'No card on file for this agent. Register a card to pay for capabilities, then retry.',
          url
        })
      }
    });
  }

  const btcUsd = await deps.btcUsd();
  const candidates = await fetchCandidates(deps.routerDb, {
    capability: args.capability,
    maxPriceUsd: args.max_price_usd,
    minSats: deps.adapter.minSats,
    btcUsd,
    fetchImpl: deps.fetchImpl,
    provenFallbacks: deps.config.provenFallbacks
  });
  if (candidates.length === 0) {
    return errResult(`NO_CANDIDATES: no healthy, payable endpoint matches "${args.capability}" under $${args.max_price_usd}`);
  }

  const failures: string[] = [];
  for (const candidate of candidates.slice(0, MAX_DEAD_CANDIDATES)) {
    const upstream = buildUpstreamRequest(candidate, args.input);
    let quote;
    try {
      quote = await fetchQuote(upstream.url, { method: upstream.method, body: upstream.body, fetchImpl: deps.fetchImpl });
    } catch (err) {
      failures.push(`${candidate.url}: ${(err as Error).message}`);
      continue; // a dead or misbehaving candidate is stale index data, not a bug
    }

    if (quote.amountSats < deps.adapter.minSats) {
      // catalog prices are static probe prices; the gateway prices the actual
      // request dynamically and can undercut the settlement floor
      failures.push(`${candidate.url}: firm quote ${quote.amountSats} sats is under the settlement floor of ${deps.adapter.minSats}`);
      continue;
    }
    const quoteUsd = Math.round((quote.amountSats / 1e8) * btcUsd * 100) / 100;
    const chargedUsd = Math.max(quoteUsd, MIN_CHARGE_USD);
    if (chargedUsd > args.max_price_usd) {
      failures.push(`${candidate.url}: firm quote $${chargedUsd} exceeds budget $${args.max_price_usd}`);
      continue;
    }
    try {
      deps.guards.checkJob(quote.amountSats);
    } catch (err) {
      if (err instanceof GuardError) return errResult(`${err.code}: ${err.message}`);
      throw err;
    }

    const auth = await deps.billing.authorize(quoteUsd, { paymentMethod: card.payment_method });
    const nonce = randomBytes(16).toString('hex');
    const payload: StatePayload = {
      principal,
      upstream: candidate.url,
      serviceId: candidate.id,
      argsDigest,
      quotedSats: quote.amountSats,
      quotedUsd: chargedUsd,
      paymentIntentId: auth.paymentIntentId,
      issuedAt: Math.floor(Date.now() / 1000),
      ttlSeconds: deps.config.stateTtlSeconds,
      nonce
    };
    deps.routerDb
      .prepare(
        'INSERT INTO pending_jobs (nonce, invoice, token, wrapped_url, http_method, body, candidates_considered) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(nonce, quote.invoice, quote.token, quote.wrappedUrl, upstream.method, upstream.body ?? null, candidates.length);
    const blob = mintState(deps.config.stateKeyHex, payload);

    const host = new URL(candidate.url).host;
    return inputRequired({
      inputRequests: {
        consent: inputRequired.elicit({
          message: `$${chargedUsd.toFixed(2)} — ${host}, quoted firm by l402.space. Approve?`,
          requestedSchema: {
            type: 'object',
            properties: { approve: { type: 'boolean' } },
            required: ['approve']
          }
        })
      },
      requestState: blob
    });
  }
  return errResult(`ALL_CANDIDATES_FAILED after ${failures.length}: ${failures.join(' | ')}`);
}

async function handleRetry(
  deps: InvokeDeps,
  mcpReq: McpReqSurface,
  args: InvokeArgs,
  principal: string,
  argsDigest: string,
  rawState: string
) {
  let payload: StatePayload;
  try {
    payload = verifyState(deps.config.stateKeyHex, deps.routerDb, rawState, { principal, argsDigest });
  } catch (err) {
    if (err instanceof StateError) {
      return errResult(`${err.code}: requestState rejected (${err.message}). You were charged $0.`);
    }
    throw err;
  }

  const consent = mcpReq.inputResponses?.['consent'] as
    | { action?: string; content?: { approve?: unknown } }
    | undefined;
  const approved = consent?.action === 'accept' && consent.content?.approve === true;
  if (!approved) {
    await deps.billing.void(payload.paymentIntentId);
    return errResult('Consent declined — the card hold was voided and you were charged $0.');
  }

  const job = deps.routerDb
    .prepare('SELECT invoice, token, wrapped_url, http_method, body, candidates_considered FROM pending_jobs WHERE nonce = ?')
    .get(payload.nonce) as
    | { invoice: string; token: string; wrapped_url: string; http_method: string; body: string | null; candidates_considered: number }
    | undefined;
  deps.routerDb.prepare('DELETE FROM pending_jobs WHERE nonce = ?').run(payload.nonce);
  if (!job) {
    await deps.billing.void(payload.paymentIntentId);
    return errResult('JOB_LOST: redemption material is gone (router restarted?) — hold voided, you were charged $0. Invoke again.');
  }

  try {
    deps.guards.checkJob(payload.quotedSats);
  } catch (err) {
    if (err instanceof GuardError) {
      await deps.billing.void(payload.paymentIntentId);
      return errResult(`${err.code}: ${err.message} — hold voided, you were charged $0.`);
    }
    throw err;
  }

  const started = Date.now();
  let settlement: Settlement;
  try {
    settlement = await deps.adapter.payInvoice(job.invoice, { maxSats: deps.config.maxSatsPerJob });
  } catch (err) {
    await deps.billing.void(payload.paymentIntentId);
    const detail = err instanceof SettlementError ? `${err.code}: ${err.message}` : (err as Error).message;
    return errResult(`SETTLEMENT_FAILED (${detail}) — hold voided, you were charged $0.`);
  }
  // the ledger tracks real sats; synthetic settlements are marked by the
  // adapter's capability flag, never by its name
  if (deps.adapter.movesRealFunds) {
    deps.guards.recordSpend(settlement.paidSats + settlement.feeSats, payload.upstream);
  }

  let upstreamRes: Response | undefined;
  let failure: string | undefined;
  try {
    upstreamRes = await deps.fetchImpl(job.wrapped_url, {
      method: job.http_method,
      headers: {
        Authorization: `L402 ${job.token}:${settlement.preimage}`,
        ...(job.body ? { 'content-type': 'application/json' } : {})
      },
      ...(job.body ? { body: job.body } : {}),
      signal: AbortSignal.timeout(deps.redeemTimeoutMs ?? DEFAULT_REDEEM_TIMEOUT_MS)
    });
    if (!upstreamRes.ok) failure = `upstream returned ${upstreamRes.status}`;
  } catch (err) {
    failure = `upstream unreachable: ${(err as Error).message}`;
  }

  if (failure || !upstreamRes) {
    await deps.billing.void(payload.paymentIntentId);
    deps.routerDb
      .prepare('INSERT OR REPLACE INTO degraded_candidates (service_id, reason) VALUES (?, ?)')
      .run(payload.serviceId, failure ?? 'unknown');
    return errResult(
      `UPSTREAM_FAILED (${failure}) — card hold ${payload.paymentIntentId} was voided and you were charged $0. The candidate was marked degraded.`
    );
  }

  const text = await upstreamRes.text();
  await deps.billing.capture(payload.paymentIntentId);
  return {
    content: [{ type: 'text' as const, text }],
    _meta: {
      'io.402index/receipt': {
        upstream: payload.upstream,
        rail: 'l402',
        paid_sats: settlement.paidSats,
        charged_usd: payload.quotedUsd,
        payment_intent: payload.paymentIntentId,
        latency_ms: Date.now() - started,
        candidates_considered: job.candidates_considered
      }
    }
  };
}
