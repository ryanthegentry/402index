# Router PoC — working notes

One lesson per entry, summary line first. Sessions 2026-07-28/29 (PoC) and
2026-07-29/30 (multirail + TTFP).

## Railway Golem and Atlas Golem differ in exposed routes, not capability

Checked 2026-07-29. `sendLightningPayment` lives in the SHARED `lightning/`
module, and `sweep/auto-sweep.js` — a non-CLI caller — already invokes it
directly. The hosted server simply never exposed a route for it; adding one
wires an existing function rather than building a capability. Two blockers the
PoC PRD recorded are also stale: the Railway wallet's public `/l402/status`
now reads `spendableSats: 34882, pendingRecoverySats: 0` (was 0 / 34,882 — the
ASP sweep completed), and `boltzReachable`/`aspReachable` are both true, so the
historical "Railway egress breaks Boltz" story does not reproduce. The
authenticated endpoints correctly refuse without a token, so this rests on the
one public endpoint; confirm with a token before making funding decisions on
it. What genuinely differs is custody posture, not technology: Atlas's wallet
sits behind a home network with no inbound path, Railway's would be spendable
over HTTP from a service accepting internet traffic.

## Today's Claude Code CAN pay through the router — but only the mandated path

Legacy-shim spike, 2026-07-29. Setting `legacy: 'stateless'` (env
ROUTER_LEGACY_MODE) makes the router accept a 2025-era handshake, and real
Claude Code 2.1.220 then completed a full paid invoke end to end: quote →
card hold → settle → redeem → capture, mandate debited $0.50, credential
retained and marked redeemed. No protocol code was written; it is one config
value.

What does NOT work on that path, and why: stateless legacy serving is
per-REQUEST, so it can never carry a server→client request. The SDK's legacy
shim fulfils `input_required` by sending a real `elicitation/create`, so the
consent and registration rounds fail with "per-request legacy serving cannot
receive server-to-client requests". Making those work needs a SESSIONFUL
legacy transport wired in user land behind `isLegacyRequest` — that is a real
integration, and it IS the work that Claude Code shipping 2026-07-28 would
obsolete. Do not build it.

Two consequences that outlive the protocol question:
- **Identity must come from auth, not the protocol.** On a 2025-era stateless
  connection there is no per-request `_meta` envelope, so `principalOf` sees
  no clientInfo and every caller is `unknown-client`. Anything internet-facing
  needs bearer auth to name the principal anyway; the protocol was never going
  to be the identity source.
- **The receipt does not reach a 2025-era client.** `_meta` on the tool result
  did not surface to Claude Code — it reported the upstream body and correctly
  complained it could not see what it had been charged. If the receipt is the
  product's trust surface, it belongs in the result CONTENT for legacy clients,
  not only in `_meta`.

Product read: consent and registration are one-time, out-of-band setup (a URL
a human visits); the per-call path is mandated and needs no interactivity.
That ordering works on every client that exists today.

## llm402.ai fails PER ENDPOINT, not per provider and not per route

Final shape after three paid tests. `claude-fable-5` DELIVERS over direct
L402 — 344 sats, 17.8s, real completion returned. `claude-opus-4.7-fast`
502s after payment on BOTH routes (gateway 1,205 sats, direct 1,024).
`claude-fable-5:batch` 502'd via gateway at 402 sats. So llm402.ai's L402
rail, macaroon minting and preimage verification all work; specific
model endpoints take valid payment and then fail to deliver. Degrade per
ENDPOINT, never per host — the family-wide exclusion was blinding us to a
provider that mostly works. Provider evidence for a bug report: payment hash
e99b94a921a4f5905cc6c116ddf54514b56f9288b5e9d0094bcebe256d92f85e paid 1,026
sats to claude-opus-4.7-fast and got a 502.

## CORRECTION: the 502s are provider-side, not the gateway's fault

The 2026-07-29 direct-route test overturns the entry below it. Pinned to
direct-only (no gateway rescue), the router paid 1,024 real sats straight to
llm402.ai/claude-opus-4.7-fast and got the SAME 502 after settlement. Free
probes then isolated the layer: their quote leg answers 402 in 135ms with a
valid macaroon; their host serves 200; a deliberately wrong preimage is
rejected in 125ms with `invalid_l402 / "Preimage does not match payment
hash"`. So payment verification works and the failure is downstream of it —
llm402.ai takes valid payment and then its own inference backend 502s.
l402.space was the messenger both nights. Method lesson: two failures over
one route prove nothing about that route; only a second INDEPENDENT route
isolates the layer, and that test is worth its cost. Cost of the correction:
1,024 sats. Cost of shipping the wrong belief: an Alby conversation built on
a false premise.

## A failed redemption throws away a credential we already paid for

The 1,024 sats bought a macaroon that is still valid — L402 credentials
survive a failed delivery, and the 502 may well be transient. The router
deletes the pending_jobs row BEFORE redeeming, so on failure the macaroon
and preimage are unrecoverable and the paid credential can never be retried.
Every absorbed loss in the ledger is potentially a retry we discarded. Fix:
keep the credential + preimage on the ledger row when delivered=0, and add a
retry path (a paid credential is an asset, not a receipt). This is the
cheapest available reduction in the loss rate.

## The gateway costs 16% and was slower, but its delivery record is per-provider

SUPERSEDED IN PART by the correction above — read that first. What still
stands: two l402.space redemptions to lightningfaucet 502'd (1,162 sats
absorbed) while the DIRECT route to the same host delivered 2/2, at 500 sats
vs 580 and in 1-2s vs 39s. So direct is cheaper, faster, and keeps the data.
What does NOT stand: the inference that l402.space's settlement leg is
therefore broken in general — llm402.ai fails identically without it. Read
the gateway's per-provider rows as evidence about the PAIR, never about the
gateway alone.

## Degradation is per-service but failures are per-route — a design gap

The gateway 502s degraded lightningfaucet in degraded_candidates even though
the direct route delivers to it flawlessly. One shared row blinds the router to
the working route; next iteration should key degradation on (service, route).
Tonight the row was deleted by hand after each gateway failure.

## Our own index API 502s under health-sweep load, and the router treats it as fatal

An invoke died with "live index API returned 502" before any payment — that
was 402index.io, not an upstream. Immediately after, the same query returned
200 in 5.8s cold then 0.3s warm, so it is an edge timeout while the health
checker sweeps 86k services. Two consequences: the router should retry a
failed candidate fetch rather than abandoning the job, and the production
slow-query work (the 5.9s vec scan) has a second symptom now.

## demo.sh must source ~/.402index-router.env — long shells carry stale exports

The demo inherited ROUTER_MAX_SATS_PER_JOB=200 from a shell exported before
Ryan's edit and hit JOB_CAP. The env file is the operational source of truth;
demo.sh now sources it with set -a before applying defaults.

## Challenge shapes drift within a day — capture fixtures at build time, expect decay

governance.taskhawktech.com served both-present L402 (macaroon= AND token=) when
the multirail PRD probed it; 24 hours later it serves an MPP `Payment` scheme.
The both-present fixture is now a composite of two real captures, and the MPP
header became a negative fixture. Related: parsebit double-sends the challenge
as BOTH `LSAT` and `L402` headers — fetch() comma-joins multi-value headers, so
the parser must survive a joined header, not just a clean one. And
lightningfaucet's catalog URL (llm-prompt) 301s to the real endpoint
(llm_prompt) — the direct route must quote AND redeem at the post-redirect URL.

## The mock adapter is registry-reachable only when pinned

First registry cut let sub-floor and x402 requests silently fall through to the
mock (canSettle everything, minSats 0) — a real job would have "settled"
synthetically. Rule: the mock registers with onlyWhenPinned and is selectable
solely via SETTLEMENT_ADAPTER=mock; the x402 stub IS selectable because its job
is to throw RAIL_UNAVAILABLE naming what a payer needs. Real-money accounting
keys off movesRealFunds now, never off adapter names.

## stage_timings is one JSON column, not eight INTEGER columns

Deviation from the multirail PRD's columns-only schema: TTFP stage
instrumentation (candidates/quote/authorize/consent-wait/settle/redeem/capture)
lands in a single stage_timings TEXT column as JSON, queryable via
json_extract. One write path for the loss ledger and the TTFP KPI.

## Product constraint: card-in agentic payments have a hard ~$0.50 floor per job

Stripe's minimum PaymentIntent is $0.50 USD — every sub-$0.50 charge 400s with
amount_too_small. Combined with Boltz's 333-sat outbound floor, the router's real
per-job economics are: minimum ~$0.50 inbound (Stripe, hard), minimum 333 sats
outbound (Boltz). Stripe is the binding constraint. Billing floors the card charge
at $0.50 and the difference over the quote is margin, not a bug; the consent
message must show the floored charge, and nothing below 50 cents may ever be sent
to Stripe. The PRD's ~19% margin model is wrong at the floor — minimum viable
markup is 40%+ once both floors are respected. This shapes the whole product, not
just the PoC: micro-priced jobs need batching or credit, not per-job cards.

## Candidate selection reads the LIVE 402index.io API, never the local DB copy

data/402index.db on Atlas is dated 2026-05-26 — two months stale. The live API is
the product finding its own payable endpoints: GET /api/v1/services?protocol=L402
&health=healthy&limit=200&offset=N. Gotchas verified by Ryan against production:
`health=healthy` is the filter (`health_status=` is silently ignored); `limit`
caps server-side at 200, paginate by offset; `price_usd` is 0.000 on most rows —
filter on price_sats and convert yourself. Router filter: price_sats >= 333 AND
lnget_compatible == 1 (standard L402 challenge shape), prefer low latency_p50_ms.
A timeout is a stale candidate, not a bug — move on; three dead in a row, stop.

## Catalog prices are static probe prices — the dynamic quote can undercut the floor

llm402.ai's catalog row says 357 sats, but the gateway prices the actual request:
our small chat request quoted 103 sats — under the Boltz floor — and the first
happy-path run discovered it only after consent, settling nothing but voiding a
hold it never needed to open. Fix that stuck: check quote.amountSats against
adapter.minSats at quote time and skip the candidate. Job sizing (max_tokens)
is what pushes an LLM request into the settleable band (~100 sats/1000 tokens
fable-tier, ~4x premium).

## llm402.ai quotes fine but delivery 502s through l402.space — family-level failure

Three different llm402.ai endpoints (fable-batch, opus-4.7-fast, and the
non-batch quote leg) failed on the paid leg tonight while quoting normally.
Cost: 403 + 1,532 sats absorbed (holds voided both times — the guarantee ran
for real). Per the 3-dead rule the whole family went into degraded_candidates
and the proven fallback (lightningfaucet.com, lnget=0, via ROUTER_PROVEN_FALLBACKS)
carried the demo. Check whether llm402.ai↔l402.space recovers before trusting it.

## Golem CLI never exits on its own — parse stdout, then kill the child

`node dist/cli/index.js balance` printed complete output then sat past 120s (open
Ark-server connection keeps the event loop alive). Anything that spawns the CLI must
treat stdout as the completion signal and kill the process, not wait for exit.

## Boltz floor: no Lightning payment under 333 sats from this wallet — design constraint

Golem's outbound Lightning path is an Ark→Boltz submarine swap; Boltz rejects swaps
under 333 sats (live error: `"1 is less than minimal of 333"`; Ryan confirmed
ARK->BTC min=333, pct_fee=0.1, miner=0). This is not a one-off: every job the router
settles over Lightning must be quoted ≥333 sats, so ~1-sat pings and micro-priced
endpoints are unpayable on this rail. Caps raised accordingly (per-job 2000,
total 20000, per Ryan mid-session). Sub-333 jobs need batching/credit or another
rail — out of scope tonight.

## An impatient redeem burns the credit — hold the redemption connection open for minutes

l402.space receipts are one-shot per upstream settlement. First T0 run: paid 580 sats,
then redeemed with a 30s curl timeout; the upstream (lightningfaucet LLM) took longer,
the gateway delivered to my dead connection, and the next attempt got 402 "prepaid
credit is spent". Concurrent retries during delivery get 409 "already being delivered"
— do not fire parallel redeems. Router rule: single redemption request, client timeout
≥300s, never abort mid-delivery.

## Golem CLI truncates the preimage — read the full one from boltz-swaps.db

`pay <bolt11>` prints `Preimage: xxxxxxxx...` (8 chars). The full 64-hex preimage is in
`~/.golem/data/boltz-swaps.db`, table `boltz_swaps`, newest row's `data` JSON at
`.preimage`, matched by `.request.invoice`. Verify `sha256(preimage) == paymentHash`
from the invoice before trusting it. GolemSettlement reads it there after the CLI exits.

## Golem cannot parse l402.space's challenge — router parses, Golem pays raw bolt11

`golem pay <l402.space URL>` fails with "could not parse L402 challenge": l402.space
sends `WWW-Authenticate: L402 version="0" token="..." invoice="..."` and Golem's parser
wants `macaroon=`. Golem is out of scope to change. Workaround that is also the better
architecture: the router fetches/parses the 402 itself (it must anyway, to quote), then
uses `golem pay <bolt11>` purely as "pay invoice, return preimage". Deviation from PRD
T6 ("spawns golem pay-l402") recorded in the journal.

## Truncating header credentials is not enough — 402 bodies duplicate them

gitleaks failed PR #317's scan on the direct-l402-token fixture: lightningfaucet's
402 BODY carries token and macaroon fields holding the same credential the header
does, and only the header had been faked. Fixture rule now: truncate every
credential-shaped value wherever it appears (header params AND body fields), keep
invoices/payment hashes (public), and .gitleaksignore the historical fingerprint
with a written justification when the value was never a live secret (an unpaid
challenge's token is unusable without its invoice's preimage).
