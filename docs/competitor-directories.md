# Competitor Directories — x402 Ecosystem

Last updated: 2026-03-16

Directories and tools that index, discover, or analyze x402/L402 services. Tracked for competitive awareness and potential aggregator integration.

## Active Directories

| Directory | URL | Description | Has API? | Services Listed | Priority |
|-----------|-----|-------------|----------|-----------------|----------|
| x402scan (Merit Systems) | x402scan.com | x402 ecosystem explorer. Rich UI, transaction analytics. Primary competitor. | Yes (REST) | ~13K+ | Known — tracked in competitive-intel.md |
| Rencom | x402.rencom.ai | Paid semantic search for x402 resources. $0.01/query via x402. | Yes — `GET api.rencom.ai/x402/v1/paid/search` | Unknown (indexes Bazaar) | **High** (competitive, not integration target) |
| x402list.fun | x402list.fun | Largest x402 directory. Pulls from facilitators (Coinbase, PayAI, Thirdweb, Questflow). | MCP only ($0.001/search) | **14,646 services, 827 providers** | Medium (same upstream sources we already poll) |
| Fluora | glama.ai/mcp/servers/@fluora-ai/fluora-mcp | MonetizedMCP broker. AI agents discover and pay for services via MCP + x402 USDC. | MCP server (STDIO/SSE) | **76+ monetized services** | Medium (small unique catalog, MCP integration non-trivial) |
| SlinkyLayer | slinkylayer.ai | On-chain API marketplace. Wraps existing APIs with x402. ERC-8004 reputation. | Unknown (JS SPA) | Unknown | Medium (unique angle — wrapped non-native APIs) |
| x402.watch | x402.watch | Facilitator monitoring — real vs gamed txns, latency, uptime, chain distribution. | Docs at docs.x402.watch (may need auth) | 10 verified facilitators | Medium (complementary health data) |
| x402 Registry (USDC.org) | usdc.org/x402 | Official USDC.org x402 registry. | TBD | Unknown | Medium |
| x402station | x402station.com | Analytics platform claiming real-time monitoring. | npm `x402-analytics` | **0 currently (placeholder)** | Low (not operational) |
| x402 Bazaar (Coinbase) | api.cdp.coinbase.com | Our primary aggregator source. | Yes (REST, paginated) | ~13,990 | Already integrated |

**Not found:** EntRoute — searched for entroute.io, entroute.ai, "entroute x402" across web/GitHub/X. No results. Likely misremembered, vaporware, or pre-launch.

## Detailed API Findings

### Rencom (`x402.rencom.ai`)

Paid semantic search engine. You pay $0.01 USDC per query via x402.

```
GET https://api.rencom.ai/x402/v1/paid/search
  ?q=<query>&sort_by=recommended&limit=3&offset=0

Response: {
  "results": [{ "id", "resource" (URL), "description", "max_amount_required", "network", "final_score" }],
  "has_more": boolean, "limit", "offset"
}

Free: GET /health, GET / (metadata)
```

**Not viable as aggregator** — x402 paywall makes bulk polling expensive. Competitive threat to our search, not a data source.

### x402list.fun

14,646 services, 827 providers. Pulls from same upstream facilitators we already poll (Coinbase Bazaar, PayAI, Thirdweb, Questflow). MCP-only access at $0.001/search. Categories: Data, Developer Tools, AI, DeFi, Storage, Identity, NFT, Gaming.

**Not viable as aggregator** — no REST API, MCP-only. We already poll the same upstream sources via Bazaar.

### Fluora (MonetizedMCP)

76+ monetized services. MCP broker for paid services (PDF gen, DeFi data, web scraping, AI research, social scraping).

**MCP tools:**
- `exploreServices` — discover services by category/query
- Service invocation with automatic USDC payment

**Hypothetical aggregator:**
1. Run local MCP client → connect to Fluora server (STDIO/SSE)
2. Call `exploreServices` across category queries ("PDF", "DeFi", "AI", "scraping", etc.)
3. Parse: service name, description, price, category, capabilities
4. ~$0.10 per full catalog sweep (76 services at $0.001/query)
5. Normalize to our schema, run weekly

**Challenge:** Requires MCP client infrastructure (`@modelcontextprotocol/sdk`).

### x402.watch

Facilitator-level monitoring (not service-level). 10 verified facilitators: NetPay, PayAI, OpenFacilitator, Dexter, Ultravioleta DAO, Daydreams, Kobaru, x402jobs, Meridian. Tracks real vs gamed transactions, chain distribution, p50/p95 latencies, fee structures.

**Useful for:** Enriching our facilitator metadata. Not a service directory.

## Differentiation

402index differentiates from all of the above by:
1. **Protocol-agnostic** — we index both L402 (Lightning) and x402 (stablecoin)
2. **Verified health data** — active monitoring every 15 min, not just a static catalog
3. **API-first** — our own API is L402-gated, dog-fooding the protocol
4. **Distribution layer** — RSS, webhooks, Nostr publishing
5. **Multiple aggregator sources** — Bazaar + Satring + L402Apps + Sponge + self-registration + well-known discovery

## Action Items

- [ ] Monitor Rencom for competitive intelligence (search quality, coverage)
- [ ] Investigate SlinkyLayer developer docs for registry API
- [ ] Evaluate Fluora MCP integration cost/benefit (76 services worth the infra?)
- [ ] Check x402.watch facilitator health data for enrichment
- [ ] Periodically re-check x402station for activation
- [ ] ~~Investigate EntRoute~~ — does not appear to exist
