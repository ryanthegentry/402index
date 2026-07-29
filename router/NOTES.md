# Router PoC — working notes

One lesson per entry, summary line first. Sessions 2026-07-28/29 (PoC) and
2026-07-29/30 (multirail + TTFP).

## The gateway's paid delivery leg fails across providers while quoting normally

Two consecutive l402.space redemptions to lightningfaucet 502'd tonight AFTER
settlement (1,162 sats absorbed), while the DIRECT route to the same host
delivered 2/2 — at 500 sats vs the gateway's 580, and in 1-2s vs last night's
39s. Combined with llm402.ai's gateway-leg 502s last night: the failure lives
in l402.space's upstream-settlement leg, not in the providers. The ledger now
shows it with real money: direct 2 jobs 0 lost; gateway 7 jobs 5 lost. This is
simultaneously the strongest argument for the direct route and the dataset the
business sells.

## Degradation is per-service but failures are per-route — a design gap

The gateway 502s degraded lightningfaucet in degraded_candidates even though
the direct route delivers to it flawlessly. One shared row blinds the router to
the working route; next iteration should key degradation on (service, route).
Tonight the row was deleted by hand after each gateway failure.

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
