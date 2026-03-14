# 402 Index — Competitive Intelligence

**Last updated:** February 26, 2026

---

## x402 Ecosystem Overview

The x402 ecosystem is much larger than initial estimates. As of Feb 2026:

- **10,000+ paid API endpoints** live in the ecosystem (per Simplescraper)
- **100M+ payments** processed since May 2025 launch
- **22+ facilitators** operating independently
- **163,600 transactions in a single week** (per x402scan)
- **Average transaction size: ~$0.28** (~$41M / 146M transactions)
- **x402 Foundation** co-founded by Coinbase + Cloudflare governs the spec
- **Stripe launched x402 support** in February 2026
- **Algorand joined** the ecosystem Feb 23, 2026
- Protocol covers Base, Ethereum, Solana, BNB Smart Chain, and growing

### x402 Protocol Details (V2, Dec 2025)

- Headers: `PAYMENT-SIGNATURE` (was `X-PAYMENT`), `PAYMENT-REQUIRED` (base64-encoded, was response body)
- Only production-ready payment scheme is `exact` (fixed price per request)
- `upto` scheme (variable/metered pricing) is theoretical only — not in stable spec
- Cloudflare proposed "deferred payment scheme" for session-level pricing — not shipped
- SDKs: TypeScript, Python, Go. Middleware: Express, Hono, Next.js. Wrappers: axios, fetch

### CDP Facilitator Risk

The Coinbase Developer Platform facilitator is a **single point of failure** for most x402 services. If CDP goes down, most x402 endpoints stop working. The spec supports local verification as fallback, but few production deployments implement it. This is a centralization risk worth monitoring and potentially worth surfacing in our health checks.

---

## Direct Competitors

### x402 Bazaar (Coinbase)

- **URL:** Bazaar API at `x402.org/facilitator/discovery/resources`
- **Docs:** docs.cdp.coinbase.com/x402/bazaar
- **Launched:** Sep 10, 2025
- **Size:** 70+ services at launch, growing. Heavily crypto/DeFi skewed.
- **Registration:** Auto-registration via CDP facilitator with `discoverable: true` + bazaar extension
- **Quality:** Low curation. Many listings have minimal descriptions, no schemas.
- **Self-assessment:** Coinbase docs call it "more like Yahoo search than Google — functional but evolving"
- **Protocol:** x402 only. No L402 support. No plans for L402 announced.
- **MCP:** Docs show Bazaar → MCP server as supported pattern. Client SDK includes `withBazaar()` helper.
- **V2 integration:** Discovery extension lets services expose structured metadata that facilitators crawl automatically

**Our edge over Bazaar:** L402 coverage, health monitoring, quality curation, exclusive supply, editorial depth. Bazaar is auto-generated; we're hand-curated + automated.

**Their edge over us:** Scale (10,000+ vs our initial ~50-100), brand (Coinbase), auto-registration friction is near-zero.

### Satring (L402)

- **Claims:** 20+ Lightning-paywalled L402 services
- **Access:** Tor-accessible, itself L402-paywalled (meta)
- **Services include:** KV storage, Lightning stats, text summarization, keyword extraction, sentiment analysis, GPT-4o-mini access
- **Operator:** One-person project. Philosophically aligned with Bitcoin/Lightning ethos.
- **Reliability:** May be intermittent. Build polling resilience.
- **Protocol:** L402 only.

**Our edge:** We aggregate Satring's listings plus Bazaar plus our own exclusive supply. Satring is L402-only.

### x402 Service Discovery / Ouroboros

- **Posted to HN:** Feb 25, 2026
- **Claims:** "Yellow Pages for the agent economy"
- **Built by:** Claims to be built by autonomous agent
- **Deployed:** Render
- **Status:** Very early, independent indexer of x402 services

### SentEdge AI

- **URL:** sentedge.ai/bazaar.html
- **Type:** Third-party Bazaar explorer with human-readable UI
- **Features:** Trending endpoints, top endpoints, top wallets, service browser
- **Differentiation from Bazaar:** Better UI, analytics layer

### x402bazaar.xyz

- **Type:** Another third-party Bazaar viewer
- **Status:** Simple explorer

### x402scan

- **URL:** x402scan.com
- **Type:** Ecosystem analytics platform / indexer
- **Tracks:** Transaction volume, endpoint discovery, facilitator usage, network distribution
- **Not a directory:** More of a block explorer for x402 payments

### QuickNode x402 Testing Tool

- **Type:** Interactive testing environment for x402 protocol
- **Features:** Connect to any x402 endpoint, test paywalls, search Bazaar, explore 402 flows
- **Not a competitor per se** but shows the tooling ecosystem is growing

---

## MCP Marketplace Landscape

Multiple MCP marketplaces now exist. Our MCP server (Phase 2) enters a crowded space:

- **LobeHub** (lobehub.com/mcp) — Large directory of MCP servers
- **mcpmarket.com** — "Top MCP Servers" discovery
- **mcpservers.org** — Open directory
- **Cline marketplace** — Built into Cline IDE
- **Cursor marketplace** — Built into Cursor IDE
- **Databricks MCP Catalog** — Enterprise, Unity Catalog integrated
- **AWS Marketplace MCP** — Amazon Bedrock integration
- **Google Cloud MCP servers** — Maps, BigQuery, Compute Engine, Kubernetes

**Our MCP differentiation:** The only MCP server that returns services you can pay for programmatically without human signup. Every result is a direct L402/x402 endpoint. Other MCP servers connect to services that require API keys and human registration.

---

## Non-Obvious Competitive Dynamics

1. **Coinbase is playing open-standard, not lock-in.** They co-founded x402 Foundation with Cloudflare, open-sourced everything, explicitly support multiple facilitators. Don't assume they want Bazaar to be the only directory — they want the protocol to win, which means more directories is good for them. However, they have a long track record of under-executing on dev tools.

2. **The "aggregators of aggregators" pattern is already happening.** SentEdge, x402bazaar.xyz, Ouroboros are all aggregating Bazaar. Pure aggregation is not defensible. Our exclusive supply and L402 coverage are the differentiators.

3. **MCP is becoming infrastructure, not a differentiator.** Every major cloud provider now offers MCP. The distribution mechanism for our MCP server matters more than the MCP server itself. Distribution = being the default in Golem wallet.

4. **The x402 ecosystem has a quality problem.** Many listings are memecoins, toy services, or minimal-description endpoints. A curated, quality-signaled directory has genuine value for agents making autonomous spending decisions.

5. **L402 is tiny but may grow disproportionately.** Lightning is censorship-resistant and doesn't have the single-facilitator-failure-mode of x402/CDP. As agent volume increases and reliability matters more, L402's decentralization advantage becomes real. This is a long-term thesis, not a short-term fact.
