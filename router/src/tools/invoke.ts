import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { inputRequired, type McpServer } from '@modelcontextprotocol/server';
import type { Database } from 'better-sqlite3';
import type { RouterConfig } from '../config.js';
import { canonicalArgsDigest, mintState, verifyState, StateError, type StatePayload } from '../state.js';
import { fetchCandidates, type Candidate } from '../quote.js';
import { GuardError, type createGuards } from '../guards.js';
import { SettlementError, type AdapterRegistry, type PaymentRequest, type Settlement } from '../settlement/index.js';
import type { Route, RouteQuote } from '../routes/index.js';
import type { Ledger } from '../ledger.js';
import type { Registration } from '../registration.js';

// The MRTR state machine, multirail edition. Cold call: pick a candidate from
// the live index, quote it over the configured routes (direct first — cheaper,
// and the delivery record stays ours), authorize the card hold, ask consent —
// or skip consent entirely under a standing budget the agent granted earlier.
// Execution settles over the selected adapter, redeems patiently, captures,
// and writes the loss ledger twice: at settlement (the cap counts in-flight
// money) and at resolution. Every failure after authorization voids the hold.

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
  registry: AdapterRegistry;
  routes: Route[];
  ledger: Ledger;
  fetchImpl: typeof fetch;
  btcUsd: () => Promise<number>;
  redeemTimeoutMs?: number;
  registration?: Registration;
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

interface JobMaterial {
  serviceId: string;
  upstream: string;
  route: string;
  rail: string;
  network: string;
  quotedSats: number;
  chargedUsd: number;
  btcUsd: number;
  invoiceRaw: string;
  credential: string;
  redeemUrl: string;
  httpMethod: string;
  body: string | null;
  candidatesConsidered: number;
  paymentIntentId: string;
  stageTimings: Record<string, number>;
}

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
// max_tokens sizes the job (llm402.ai: ~100 sats/1000 tokens fable-tier);
// jobs under the 333-sat Boltz floor cannot settle over Lightning at all.
function buildUpstreamRequest(candidate: Candidate, input: string): { url: string; method: string; body?: string } {
  if (candidate.httpMethod.toUpperCase() === 'POST') {
    return {
      url: candidate.url,
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: input }], max_tokens: 4000 })
    };
  }
  const sep = candidate.url.includes('?') ? '&' : '?';
  return { url: `${candidate.url}${sep}prompt=${encodeURIComponent(input)}`, method: 'GET' };
}

function getMandate(db: Database, principal: string): { budgetUsd: number; spentUsd: number } | null {
  const row = db
    .prepare("SELECT budget_usd, spent_usd FROM mandates WHERE principal = ? AND expires_at > datetime('now')")
    .get(principal) as { budget_usd: number; spent_usd: number } | undefined;
  return row ? { budgetUsd: row.budget_usd, spentUsd: row.spent_usd } : null;
}

export function registerInvokeTool(server: McpServer, deps: InvokeDeps): void {
  server.registerTool(
    'invoke',
    {
      description:
        'Acquire a capability by outcome: 402index finds a paid endpoint, quotes a firm USD price, ' +
        'asks your consent (or spends under a standing budget you granted), then pays the provider ' +
        'on its own rail and returns the result. You are charged only when the result is delivered.',
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

// Candidate → route ladder → quote + card hold. Returns everything execution
// needs; consent (or a mandate) decides whether execution happens in this
// round trip or the next.
async function prepareJob(
  deps: InvokeDeps,
  args: InvokeArgs,
  principal: string,
  card: { payment_method: string }
): Promise<{ ok: true; material: Omit<JobMaterial, 'paymentIntentId' | 'chargedUsd'> & { quoteUsd: number; chargedUsd: number } } | { ok: false; error: string }> {
  const stages: Record<string, number> = {};
  let t = Date.now();
  const btcUsd = await deps.btcUsd();
  const realFloors = deps.registry.all().filter((a) => a.movesRealFunds).map((a) => a.minSats);
  const candidates = await fetchCandidates(deps.routerDb, {
    capability: args.capability,
    maxPriceUsd: args.max_price_usd,
    minSats: realFloors.length > 0 ? Math.min(...realFloors) : 0,
    btcUsd,
    fetchImpl: deps.fetchImpl,
    provenFallbacks: deps.config.provenFallbacks
  });
  stages.candidates_ms = Date.now() - t;
  if (candidates.length === 0) {
    return { ok: false, error: `NO_CANDIDATES: no healthy, payable endpoint matches "${args.capability}" under $${args.max_price_usd}` };
  }

  const failures: string[] = [];
  for (const candidate of candidates.slice(0, MAX_DEAD_CANDIDATES)) {
    const upstream = buildUpstreamRequest(candidate, args.input);
    for (const route of deps.routes.filter((r) => r.supports(candidate))) {
      let quote: RouteQuote;
      t = Date.now();
      try {
        quote = await route.quote(candidate, upstream, { fetchImpl: deps.fetchImpl });
      } catch (err) {
        failures.push(`${candidate.url} via ${route.name}: ${(err as Error).message}`);
        continue; // a dead or drifted route is stale data, not a bug — next route
      }
      stages.quote_ms = (stages.quote_ms ?? 0) + (Date.now() - t);

      const pr = quote.paymentRequest;
      const adapter = deps.registry.select(pr);
      if (!adapter) {
        failures.push(`${candidate.url} via ${route.name}: firm quote ${pr.amountSats} sats is under the settlement floor (no adapter can settle it)`);
        continue;
      }
      if (!adapter.movesRealFunds && deps.config.settlementAdapter !== 'mock') {
        failures.push(`${candidate.url} via ${route.name}: rail ${pr.rail} is designed but unfunded`);
        continue;
      }
      const quoteUsd = pr.amountSats !== null ? Math.round((pr.amountSats / 1e8) * btcUsd * 100) / 100 : NaN;
      const chargedUsd = Math.max(quoteUsd, MIN_CHARGE_USD);
      if (!(chargedUsd <= args.max_price_usd)) {
        failures.push(`${candidate.url} via ${route.name}: firm quote $${chargedUsd} exceeds budget $${args.max_price_usd}`);
        continue;
      }
      try {
        deps.guards.checkJob(pr.amountSats ?? 0);
      } catch (err) {
        if (err instanceof GuardError) return { ok: false, error: `${err.code}: ${err.message}` };
        throw err;
      }
      return {
        ok: true,
        material: {
          serviceId: candidate.id,
          upstream: candidate.url,
          route: quote.route,
          rail: pr.rail,
          network: pr.network,
          quotedSats: pr.amountSats ?? 0,
          quoteUsd,
          chargedUsd,
          btcUsd,
          invoiceRaw: pr.raw,
          credential: pr.credential,
          redeemUrl: quote.redeemUrl,
          httpMethod: quote.httpMethod,
          body: quote.body ?? null,
          candidatesConsidered: candidates.length,
          stageTimings: stages
        }
      };
    }
  }
  return { ok: false, error: `ALL_CANDIDATES_FAILED after ${failures.length}: ${failures.join(' | ')}` };
}

async function handleColdCall(deps: InvokeDeps, args: InvokeArgs, principal: string, argsDigest: string) {
  console.log(`[invoke] cold call from "${principal}": ${args.capability} (max $${args.max_price_usd})`);
  const cardStmt = deps.routerDb.prepare('SELECT payment_method FROM cards WHERE principal = ?');
  let card = cardStmt.get(principal) as { payment_method: string } | undefined;
  if (!card && deps.registration) {
    // the agent may be retrying after the human finished the hosted Checkout
    try {
      if (await deps.registration.completeIfRegistered(principal)) {
        card = cardStmt.get(principal) as { payment_method: string } | undefined;
      }
    } catch (err) {
      return errResult(`REGISTRATION_CHECK_FAILED: ${(err as Error).message}`);
    }
  }
  if (!card) {
    if (!deps.registration) {
      return errResult('REGISTRATION_UNAVAILABLE: no card on file and no registration flow configured');
    }
    let url: string;
    try {
      url = await deps.registration.checkoutUrlFor(principal);
    } catch (err) {
      return errResult(`REGISTRATION_UNAVAILABLE: ${(err as Error).message}`);
    }
    return inputRequired({
      inputRequests: {
        register: inputRequired.elicitUrl({
          message:
            'No card on file for this agent. Register a card once at this Stripe Checkout page, then retry — ' +
            'future invocations can run with zero interruptions under a standing budget.',
          url
        })
      }
    });
  }

  const prepared = await prepareJob(deps, args, principal, card);
  if (!prepared.ok) return errResult(prepared.error);
  const m = prepared.material;

  const authStart = Date.now();
  const auth = await deps.billing.authorize(m.quoteUsd, { paymentMethod: card.payment_method });
  m.stageTimings.authorize_ms = Date.now() - authStart;

  // A standing budget the agent granted earlier covers this charge: execute
  // in THIS round trip. No interruption — this is the TTFP kill shot.
  const mandate = getMandate(deps.routerDb, principal);
  if (mandate && mandate.budgetUsd - mandate.spentUsd >= m.chargedUsd) {
    return executeJob(deps, { ...m, paymentIntentId: auth.paymentIntentId }, { principal, mandated: true });
  }

  m.stageTimings.consent_start = Date.now(); // epoch marker; replaced by consent_wait_ms on retry
  const nonce = randomBytes(16).toString('hex');
  const payload: StatePayload = {
    principal,
    upstream: m.upstream,
    serviceId: m.serviceId,
    argsDigest,
    quotedSats: m.quotedSats,
    quotedUsd: m.chargedUsd,
    paymentIntentId: auth.paymentIntentId,
    issuedAt: Math.floor(Date.now() / 1000),
    ttlSeconds: deps.config.stateTtlSeconds,
    nonce
  };
  deps.routerDb
    .prepare(
      `INSERT INTO pending_jobs
         (nonce, invoice, token, wrapped_url, http_method, body, candidates_considered,
          route, rail, network, btc_usd, stage_timings)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      nonce, m.invoiceRaw, m.credential, m.redeemUrl, m.httpMethod, m.body,
      m.candidatesConsidered, m.route, m.rail, m.network, m.btcUsd,
      JSON.stringify(m.stageTimings)
    );
  const blob = mintState(deps.config.stateKeyHex, payload);

  const host = new URL(m.upstream).host;
  const via = m.route === 'l402space' ? 'quoted firm by l402.space' : 'quoted directly by the provider';
  return inputRequired({
    inputRequests: {
      consent: inputRequired.elicit({
        message:
          `$${m.chargedUsd.toFixed(2)} — ${host}, ${via}. Approve? ` +
          'Optionally grant a standing budget (standing_budget_usd, standing_budget_days) to skip this question under it.',
        requestedSchema: {
          type: 'object',
          properties: {
            approve: { type: 'boolean' },
            standing_budget_usd: { type: 'number' },
            standing_budget_days: { type: 'number' }
          },
          required: ['approve']
        }
      })
    },
    requestState: blob
  });
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
    | { action?: string; content?: { approve?: unknown; standing_budget_usd?: unknown; standing_budget_days?: unknown } }
    | undefined;
  const approved = consent?.action === 'accept' && consent.content?.approve === true;
  if (!approved) {
    await deps.billing.void(payload.paymentIntentId);
    return errResult('Consent declined — the card hold was voided and you were charged $0.');
  }

  const budgetUsd = Number(consent?.content?.standing_budget_usd);
  if (Number.isFinite(budgetUsd) && budgetUsd > 0) {
    const days = Math.max(1, Number(consent?.content?.standing_budget_days) || 7);
    deps.routerDb
      .prepare(
        `INSERT INTO mandates (principal, budget_usd, spent_usd, expires_at)
         VALUES (?, ?, 0, datetime('now', ?))
         ON CONFLICT(principal) DO UPDATE SET budget_usd = excluded.budget_usd,
           spent_usd = 0, expires_at = excluded.expires_at, created_at = datetime('now')`
      )
      .run(principal, budgetUsd, `+${days} days`);
  }

  const job = deps.routerDb
    .prepare(
      `SELECT invoice, token, wrapped_url, http_method, body, candidates_considered,
              route, rail, network, btc_usd, stage_timings, created_at
       FROM pending_jobs WHERE nonce = ?`
    )
    .get(payload.nonce) as
    | {
        invoice: string; token: string; wrapped_url: string; http_method: string;
        body: string | null; candidates_considered: number; route: string | null;
        rail: string | null; network: string | null; btc_usd: number | null;
        stage_timings: string | null; created_at: string;
      }
    | undefined;
  deps.routerDb.prepare('DELETE FROM pending_jobs WHERE nonce = ?').run(payload.nonce);
  if (!job) {
    await deps.billing.void(payload.paymentIntentId);
    return errResult('JOB_LOST: redemption material is gone (router restarted?) — hold voided, you were charged $0. Invoke again.');
  }

  const stages: Record<string, number> = job.stage_timings ? JSON.parse(job.stage_timings) : {};
  if (typeof stages.consent_start === 'number') {
    stages.consent_wait_ms = Math.max(0, Date.now() - stages.consent_start);
    delete stages.consent_start;
  }

  return executeJob(
    deps,
    {
      serviceId: payload.serviceId,
      upstream: payload.upstream,
      route: job.route ?? 'l402space',
      rail: job.rail ?? 'l402',
      network: job.network ?? 'lightning',
      quotedSats: payload.quotedSats,
      chargedUsd: payload.quotedUsd,
      btcUsd: job.btc_usd ?? 0,
      invoiceRaw: job.invoice,
      credential: job.token,
      redeemUrl: job.wrapped_url,
      httpMethod: job.http_method,
      body: job.body,
      candidatesConsidered: job.candidates_considered,
      paymentIntentId: payload.paymentIntentId,
      stageTimings: stages
    },
    { principal, mandated: false }
  );
}

// Settlement → redemption → capture, with the two-phase ledger write and the
// guarantee: any failure past this point voids the hold and the agent pays $0.
async function executeJob(deps: InvokeDeps, m: JobMaterial, opts: { principal: string; mandated: boolean }) {
  try {
    deps.guards.checkJob(m.quotedSats);
  } catch (err) {
    if (err instanceof GuardError) {
      await deps.billing.void(m.paymentIntentId);
      return errResult(`${err.code}: ${err.message} — hold voided, you were charged $0.`);
    }
    throw err;
  }

  const pr: PaymentRequest = {
    rail: m.rail as PaymentRequest['rail'],
    network: m.network,
    asset: 'BTC',
    amount: String(m.quotedSats),
    amountSats: m.quotedSats,
    payTo: null,
    credential: m.credential,
    raw: m.invoiceRaw,
    expiresAt: null
  };
  const adapter = deps.registry.select(pr);
  if (!adapter) {
    await deps.billing.void(m.paymentIntentId);
    return errResult('NO_ADAPTER: no settlement adapter can pay this job — hold voided, you were charged $0.');
  }

  const started = Date.now();
  let settlement: Settlement;
  let t = Date.now();
  try {
    settlement = await adapter.pay(pr, { maxSats: deps.config.maxSatsPerJob });
  } catch (err) {
    await deps.billing.void(m.paymentIntentId);
    const detail = err instanceof SettlementError ? `${err.code}: ${err.message}` : (err as Error).message;
    return errResult(`SETTLEMENT_FAILED (${detail}) — hold voided, you were charged $0.`);
  }
  m.stageTimings.settle_ms = Date.now() - t;

  // first ledger write: the money has left the wallet, outcome unknown
  let ledgerId: number | null = null;
  if (adapter.movesRealFunds) {
    ledgerId = deps.ledger.recordSettlement({
      serviceId: m.serviceId,
      upstream: m.upstream,
      rail: m.rail,
      network: m.network,
      route: m.route,
      adapter: adapter.name,
      quotedSats: m.quotedSats,
      settledSats: settlement.paidSats,
      feeSats: settlement.feeSats,
      chargedUsd: m.chargedUsd,
      btcUsd: m.btcUsd,
      paymentIntent: m.paymentIntentId,
      jobNonce: null
    });
  }

  const route = deps.routes.find((r) => r.name === m.route) ?? deps.routes[0];
  let upstreamRes: Response | undefined;
  let failure: string | undefined;
  t = Date.now();
  try {
    upstreamRes = await route.redeem(
      { redeem_url: m.redeemUrl, http_method: m.httpMethod, body: m.body, credential: m.credential },
      { proof: settlement.proof },
      { timeoutMs: deps.redeemTimeoutMs ?? DEFAULT_REDEEM_TIMEOUT_MS, fetchImpl: deps.fetchImpl }
    );
    if (!upstreamRes.ok) failure = `upstream returned ${upstreamRes.status}`;
  } catch (err) {
    failure = `upstream unreachable: ${(err as Error).message}`;
  }
  m.stageTimings.redeem_ms = Date.now() - t;

  if (failure || !upstreamRes) {
    await deps.billing.void(m.paymentIntentId);
    deps.routerDb
      .prepare('INSERT OR REPLACE INTO degraded_candidates (service_id, reason) VALUES (?, ?)')
      .run(m.serviceId, failure ?? 'unknown');
    if (ledgerId !== null) {
      deps.ledger.recordDelivery(ledgerId, {
        delivered: false,
        latencyMs: Date.now() - started,
        failureReason: failure,
        stageTimings: m.stageTimings
      });
    }
    return errResult(
      `UPSTREAM_FAILED (${failure}) — card hold ${m.paymentIntentId} was voided and you were charged $0. The candidate was marked degraded.`
    );
  }

  const text = await upstreamRes.text();
  t = Date.now();
  await deps.billing.capture(m.paymentIntentId);
  m.stageTimings.capture_ms = Date.now() - t;
  m.stageTimings.total_ms = Object.entries(m.stageTimings)
    .filter(([k]) => k !== 'consent_wait_ms' && k !== 'total_ms')
    .reduce((sum, [, v]) => sum + v, 0);

  if (opts.mandated || getMandate(deps.routerDb, opts.principal)) {
    deps.routerDb
      .prepare('UPDATE mandates SET spent_usd = spent_usd + ? WHERE principal = ?')
      .run(m.chargedUsd, opts.principal);
  }
  if (ledgerId !== null) {
    deps.ledger.recordDelivery(ledgerId, {
      delivered: true,
      latencyMs: Date.now() - started,
      stageTimings: m.stageTimings
    });
  }

  return {
    content: [{ type: 'text' as const, text }],
    _meta: {
      'io.402index/receipt': {
        upstream: m.upstream,
        rail: m.rail,
        route: m.route,
        paid_sats: settlement.paidSats,
        charged_usd: m.chargedUsd,
        payment_intent: m.paymentIntentId,
        latency_ms: Date.now() - started,
        candidates_considered: m.candidatesConsidered,
        mandated: opts.mandated,
        stage_timings: m.stageTimings
      }
    }
  };
}
