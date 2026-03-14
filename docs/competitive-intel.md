# 402 Index — Competitive Intelligence

**Last updated:** March 14, 2026

---

## x402 Ecosystem Overview

The x402 ecosystem is large but the headline numbers are misleading. As of March 2026:

- **161M+ cumulative transactions** since May 2025 launch (up from 100M at Feb 26)
- **Real API commerce volume: ~$1.6M/30 days** (~$28K/day) per a16z analysis (Mar 11). Bloomberg's $24M figure and x402.org's $600M figure are inflated by DeFi bots, test transactions, and gamified activity. ~50% of observed transactions are artificial.
- **Stabilized at ~250K transactions/day** (down from 3M/day peak). Baseline forecast: ~87M cumulative by end of 2026.
- **22+ facilitators** operating independently
- **x402 Foundation** co-founded by Coinbase + Cloudflare governs the spec
- **Stripe launched x402 support** in February 2026
- **Algorand joined** the ecosystem Feb 23, 2026
- **Google added x402** to Agent Payments Protocol
- **Base migrating off OP Stack** to proprietary chain (announced Feb 18). Three hard forks planned. Platform risk for x402 providers on Base.
- **Ramp launched Agent Cards** (Mar 11, 738K views) — corporate card rails for agent spending. Validates "agents need to spend money" entering mainstream corporate consciousness. Solves spending only, not receiving.
- Protocol covers Base, Ethereum, Solana, BNB Smart Chain, and growing

### x402 Protocol Details (V2, Dec 2025)

- Headers: `PAYMENT-SIGNATURE` (was `X-PAYMENT`), `PAYMENT-REQUIRED` (base64-encoded, was response body)
- Only production-ready payment scheme is `exact` (fixed price per request)
- `upto` scheme (variable/metered pricing) is theoretical only — not in stable spec
- Cloudflare proposed "deferred payment scheme" for session-level pricing — not shipped
- SDKs: TypeScript, Python, Go. Middleware: Express, Hono, Next.js. Wrappers: axios, fetch

### CDP Facilitator Risk

The Coinbase Developer Platform facilitator is a **single point of failure** for most x402 services. If CDP goes down, most x402 endpoints stop working. The spec supports local verification as fallback, but few production deployments implement it. This is a centralization risk we surface in our health checks. Our verification data confirms this: only ~5.7% of x402 Bazaar endpoints return valid payment headers (761 of ~13,300).

### L402 Spec Evolution (bLIP-0026)

As of March 2026, the L402 spec is going token-agnostic: `token` replaces `macaroon`, `version="0"` field added, new `agent-spec.md` designed for AI integration. 402index is adding nullable schema columns (token_format, l402_version, invoice_type, pricing_model) to track these fields as the ecosystem adopts them. Lightning Labs' litpages L402 directory expected to announce at Mar 18 community call — we plan to aggregate it.

---

## Direct Competitors

### Merit Systems — PRIMARY THREAT

**Added March 10, 2026.** Full teardown in `journals/2026-03-10-merit-systems-teardown.md`.

- **Founded by:** Sam Ragsdale (CEO, ex-a16z, ex-Google SWE) + Ryan Sproule (CTO, ex-Blockchain Capital)
- **Funding:** $10M seed (Jan 2025), co-led by a16z crypto + Blockchain Capital. $55.5M post-money.
- **Headcount:** ~5-15 (seed-stage, multiple active repos)
- **Twitter:** @merit_systems — 11.6K followers
- **Mission:** "Infrastructure for open agentic commerce"

**Three-product stack:**

1. **AgentCash** (agentcash.dev) — MCP server wallet for AI agents. Single USDC balance pays for any x402 API. 12,450+ installations, 269K+ API calls (subsidized with $100K in VC-funded credits). Claude Desktop, Cursor, Gemini plugins. Custodial hot wallet (private key on disk, no seed phrase). Competes with Golem agent wallet, not 402Index.

2. **x402scan** (x402scan.com) — Ecosystem explorer + directory + embedded wallet. Self-registration (submit URL, auto-validated). MCP server (x402scan-mcp). 299 GH stars, 190 forks. No health monitoring, no quality scoring. Competes directly with 402Index on discovery.

3. **Echo** (echo.merit.systems) — AI model router with billing. 100+ models, 2.5% fee. Creates flywheel: developers use Echo → discover x402 APIs via x402scan → pay via AgentCash.

**Where Merit is ahead:** Funding ($10M vs bootstrapped), ecosystem positioning (a16z/Coinbase orbit), developer distribution (12K+ AgentCash installs), integrated product stack shipping together, speed of execution (28 repos).

**Where Merit is behind:** Zero L402 coverage (entirely x402/USDC), no health monitoring or quality curation, custodial-only wallet, single-chain dependency (Base), no exclusive supply creation, $100K credit subsidy creates artificial metrics.

**Where they're making mistakes:** $100K subsidy is vanity metrics that collapse when credits end. Three products at seed stage = spread thin. Composer no-code agent builder is premature. Telemetry package has 2 GH stars. No L402 hedge.

**Our response:** Don't compete head-to-head. Own the cross-protocol position they're conceding (L402 + x402). Own quality/trust signals they're not building (health checks, verification). Ship Golem integration they cannot replicate. Move fast on MCP distribution.

### x402 Bazaar (Coinbase)

- **Docs:** docs.cdp.coinbase.com/x402/bazaar
- **Launched:** Sep 10, 2025
- **Size:** ~13,300 endpoints indexed in our DB. Heavily crypto/DeFi skewed.
- **Registration:** Auto-registration via CDP facilitator with `discoverable: true` + bazaar extension
- **Quality:** Low curation. Many listings have minimal descriptions, no schemas. Only ~5.7% return valid payment headers.
- **Self-assessment:** Coinbase docs call it "more like Yahoo search than Google — functional but evolving"
- **Protocol:** x402 only. No L402 support. No plans for L402 announced.
- **MCP:** Docs show Bazaar → MCP server as supported pattern. Client SDK includes `withBazaar()` helper.

**Our edge:** L402 coverage, active health monitoring, quality curation via verification tiers, exclusive supply.

**Their edge:** Scale, brand (Coinbase), near-zero registration friction.

### Satring (L402)

- **Operator:** Landon (one-person project, day job, hobbyist). Call completed Feb 28.
- **Size:** 100+ L402 endpoints
- **Access:** Tor-accessible, itself L402-paywalled
- **Services:** KV storage, Lightning stats, text summarization, keyword extraction, sentiment analysis, GPT-4o-mini access
- **Reliability:** Intermittent. We poll with resilience (skip if down, preserve existing data).
- **Protocol:** L402 only.
- **Relationship:** Supportive. Full node/channel barrier to running Satring services validates Golem's keyless receive thesis.

**Our edge:** We aggregate Satring's listings plus 5 other sources plus exclusive supply.

### Other Indexers

**x402 Service Discovery / Ouroboros** — Posted to HN Feb 25. Claims "Yellow Pages for the agent economy." Very early, independent x402 indexer on Render.

**SentEdge AI** (sentedge.ai/bazaar.html) — Third-party Bazaar explorer with trending/top endpoints and analytics layer. Better UI than raw Bazaar.

**x402bazaar.xyz** — Simple third-party Bazaar viewer.

**QuickNode x402 Testing Tool** — Interactive testing environment for x402 protocol. Not a competitor but shows tooling ecosystem growing.

---

## Our Verified Supply (Production, Mar 14)

| Metric | Value |
|--------|-------|
| Total endpoints indexed | ~13,700 |
| Payment-verified endpoints | 767+ |
| x402 payment_valid=1 | 761 |
| L402 healthy | 41 (+50 pending MaximumSats node recovery) |
| Sources | Bazaar, Satring, L402Apps, Sponge, self-registered, well-known, discovery |
| Distinct providers (filtered) | 295+ |
| L402 providers | 24 |
| Tests passing | 534 |

**First third-party L402 registration:** Ben Carman's mutinynet Lightning faucet — registered, verified, live, and [publicly tweeted](https://x.com/benthecarman/status/2031108604720300042). Strongest external validation to date.

**Active provider relationships:** Jordi/Fewsats (done), Satring/Landon (done, supportive), Ben Carman (live), Brian Murray/Ganamos (featured), Marty Bent/TFTC (active outreach), LightningEnable (DM pending — claims 5K MCP downloads + "shipping L402 from day one," contradicts our finding of API-key-only endpoints), Michael Levin/litpages (outreach planned).

---

## MCP Landscape

Our MCP server is built, deployed, and integrated with Golem CLI (`golem directory search/list`). The differentiation holds: the only MCP server that returns services you can pay for programmatically without human signup. Every result is a direct L402/x402 endpoint.

Key MCP marketplaces: LobeHub, mcpmarket.com, mcpservers.org, Cline, Cursor, Databricks MCP Catalog, AWS Marketplace MCP, Google Cloud MCP servers.

Merit's x402scan-mcp (4 stars) is the closest competitor — combines discovery + payment. But x402-only.

**Distribution is the battleground.** MCP pre-configuration in agent frameworks (OpenClaw, Claude Code, etc.) matters more than the MCP server itself.

---

## Non-Obvious Competitive Dynamics

1. **Coinbase is playing open-standard, not lock-in.** They co-founded x402 Foundation with Cloudflare, open-sourced everything. They want the protocol to win, which means more directories is good for them. However: long track record of under-executing on dev tools.

2. **Pure aggregation is not defensible.** SentEdge, x402bazaar.xyz, Ouroboros, and now x402scan all aggregate Bazaar. Our exclusive supply creation (helping providers add L402 gating) and cross-protocol coverage are the differentiators.

3. **The x402 headline numbers are noise.** Real commerce volume is ~$1.6M/30 days. Half of transaction activity is artificial. The market is real but 100x smaller than the hype suggests. This favors quality curation over raw scale.

4. **L402 is tiny but may grow disproportionately.** Lightning is censorship-resistant, doesn't have the single-facilitator failure mode of x402/CDP, and Base's migration off OP Stack adds platform risk. The L402 spec going token-agnostic (bLIP-0026) signals maturation. Long-term thesis, not short-term fact.

5. **Agent spending is going mainstream.** Ramp Agent Cards (738K views in days) proves corporate buyers want agent payment infrastructure. But Ramp solves spending, not receiving. L402/x402 solve receiving. These are complementary, not competing.

6. **Merit's subsidy play has a shelf life.** $100K in free credits creates impressive installation numbers. When credits expire, retention reveals real demand. Monitor AgentCash installs monthly — 12K→25K = real growth, 12K→13K = paper tiger.
