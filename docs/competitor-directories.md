# Competitor Directories — x402 Ecosystem

Last updated: 2026-03-16

Directories and tools that index, discover, or analyze x402/L402 services. Tracked for competitive awareness and potential aggregator integration.

## Active Directories

| Directory | URL | Description | Has API? | Services Listed | Priority |
|-----------|-----|-------------|----------|-----------------|----------|
| x402scan (Merit Systems) | x402scan.com | x402 ecosystem explorer. Rich UI, transaction analytics. Our primary competitor. | Yes (REST) | ~13K+ | Known — tracked in competitive-intel.md |
| Rencom | x402.rencom.ai | Search x402 resources with historical outcome ranking. AI-powered discovery. | TBD — needs deeper investigation | Unknown | Medium |
| EntRoute | entroute.dev (TBD) | Machine-first API discovery with "semantic intent resolution." Agents describe what they need, EntRoute finds matching APIs. | Likely — agent-native by design | Unknown | **High** — agent-relevant, potential aggregator source |
| x402list.fun | x402list.fun | Community-maintained list of x402 services. Simple catalog UI. | Unlikely (static site) | Unknown | Low |
| x402station | TBD | Analytics platform for monitoring x402 service health and usage. | TBD | N/A (analytics, not directory) | Low |
| Slinky Layer | TBD | Open market for APIs as on-chain x402 resources. Marketplace focus. | TBD | Unknown | Medium |
| x402-watch | GitHub | Open-source health monitoring tool for x402 endpoints. | N/A (tool, not service) | N/A | Medium — health data could supplement our checker |
| Fluora | fluora.xyz (TBD) | MonetizedMCP marketplace — MCP servers with x402 payment. | Likely — marketplace with listings | Unknown | **High** — MCP-relevant, potential aggregator source |
| x402 Registry (USDC.org) | usdc.org/x402 | Official USDC.org x402 registry. Lists sites accepting x402 USDC payments. | TBD | Unknown | Medium — official source |
| x402 Bazaar (Coinbase) | api.cdp.coinbase.com | Our primary aggregator source. ~13,990 resources. | Yes (REST, paginated) | ~13,990 | Already integrated |

## Potential Aggregator Sources

### EntRoute (High Priority)

If EntRoute has a public API, it could become an aggregator source like Bazaar. Key questions:
- Does it expose a resource listing endpoint?
- What's the data format? (likely JSON)
- Does it have pagination?
- What metadata per service? (URL, pricing, description, category)

**Hypothetical aggregator spec:**
```
// GET https://api.entroute.dev/v1/resources?page=1&limit=100
// Response: { resources: [...], pagination: { total, page, limit } }
// Each resource: { url, name, description, price, payment_chain, category, intent_tags }
```

### Fluora (High Priority)

MonetizedMCP marketplace could feed us MCP-specific x402 services. Key questions:
- Does it expose a catalog API?
- What's the MCP server listing format?
- How does pricing work for MCP tools vs endpoints?

**Hypothetical aggregator spec:**
```
// GET https://api.fluora.xyz/v1/servers?page=1&limit=100
// Response: { servers: [...], pagination: { total, page, limit } }
// Each server: { url, name, tools: [...], price_per_tool, payment_chain }
```

## Differentiation

402index differentiates from all of the above by:
1. **Protocol-agnostic** — we index both L402 (Lightning) and x402 (stablecoin) services
2. **Verified health data** — active health monitoring every 15 min, not just a static catalog
3. **API-first** — our own API is L402-gated, dog-fooding the protocol
4. **Distribution layer** — RSS, webhooks, Nostr publishing, not just a web UI
5. **Multiple aggregator sources** — Bazaar + Satring + L402Apps + Sponge + self-registration + well-known discovery

## Action Items

- [ ] Investigate EntRoute API — if public, draft aggregator
- [ ] Investigate Fluora API — if public, draft aggregator
- [ ] Check Rencom for API access
- [ ] Monitor x402-watch GitHub for useful health check patterns
- [ ] Periodically re-check x402list.fun and x402station for growth
