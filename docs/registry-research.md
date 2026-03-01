# 402index Registry Research

**Date:** 2026-02-28
**Purpose:** Comprehensive survey of all known L402 and x402 registries, directories, and listing sources for potential integration into 402index.io.

---

## Summary Table

| # | Source | Protocol | ~Listings | Has API? | Integration Difficulty | Priority | Status |
|---|--------|----------|-----------|----------|----------------------|----------|--------|
| 1 | x402 Bazaar (Coinbase) | x402 | ~13,000 | Yes (REST) | Easy | -- | **Integrated** |
| 2 | Satring | L402 | ~94 | Yes (REST) | Easy | -- | **Integrated** |
| 3 | l402apps.com | L402 | ~48 | Semi (embedded JSON) | Easy | High | In progress |
| 4 | x402list.fun | x402 | ~13,373 | MCP only ($0.001/query) | Medium | Medium | New |
| 5 | Ouroboros / x402 Discovery API | x402 | ~70 | Yes (REST, free /catalog) | Easy | High | New |
| 6 | Fewsats Gateway | L402 | Unknown (dynamic) | Yes (REST, was 404) | Medium | Medium | New |
| 7 | awesome-x402 (xpaysh) | x402 | ~40 curated | No (GitHub markdown) | Medium | Low | New |
| 8 | awesome-x402 (Merit-Systems) | x402 | ~60+ curated | No (GitHub markdown) | Medium | Low | New |
| 9 | awesome-L402 (Fewsats) | L402 | ~28 curated | No (GitHub markdown) | Medium | Low | New |
| 10 | x402.org/ecosystem | x402 | ~200+ | No (HTML page) | Hard | Low | New |
| 11 | x402.eco | x402 | ~167 indexed | MCP skill only | Hard | Low | New |
| 12 | x402index.com | x402 | ~4 | Yes (REST, x402-gated) | Medium | Low | New |
| 13 | x402scan.com | x402 | Unknown | Unknown (JS SPA) | Hard | Low | New |
| 14 | x402station.com | x402 | 0 (early) | npm package | Hard | Low | New |
| 15 | httpay.xyz (Alfred's Bazaar) | x402 | ~170 | Likely (has /api catalog) | Medium | Medium | New |
| 16 | BlockRun | x402 | ~42 models | No public listing API | Hard | Low | New |
| 17 | Agent Arena | x402 | Unknown | Yes (x402-gated, $0.001) | Medium | Medium | New |
| 18 | Sats4AI | L402 | ~3 | No | Easy (manual) | Low | New |
| 19 | alittlebitofmoney.com | L402 | ~3 providers | Has /catalog page | Easy (manual) | Low | New |
| 20 | LightningProx | L402 | ~2 | No | Easy (manual) | Low | New |
| 21 | Aperture (Lightning Labs) | L402 | 2 known | No | N/A | N/A | Reference impl only |
| 22 | x402 API Network | x402 | 16 | Via Bazaar | Easy (already in Bazaar) | N/A | Already in Bazaar |
| 23 | Apexti Toolbelt | x402 | ~1,500+ | No public listing API | Hard | Medium | New |

---

## Detailed Source Analysis

### 1. x402 Bazaar (Coinbase CDP) -- INTEGRATED

- **URL:** `https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources`
- **Protocol:** x402
- **Listings:** ~12,999 (as of 2026-03-01)
- **API:** Yes, paginated REST. `?limit=100&offset=0` returns items with pagination.total
- **Data fields:** resource URL, description, accepts (payment options), maxAmountRequired, network, payTo, outputSchema, inputSchema
- **Rate limits:** Aggressive 429s from Coinbase -- caps at ~3,000-4,500 per run. Offset persistence solves this over multiple polls.
- **Notes:** This is the canonical x402 service registry. Services opt in when using the CDP facilitator with bazaar extension enabled. Our primary x402 data source.

### 2. Satring -- INTEGRATED

- **URL:** `https://satring.com/api/v1/services`
- **Protocol:** L402
- **Listings:** 94 (as of 2026-03-01)
- **API:** Yes, paginated REST. `?page=1&page_size=20` returns `{services: [...], total: 94, page: 1}`
- **Data fields:** id, name, slug, url, description, pricing_sats, pricing_model, protocol, categories, avg_rating, domain_verified
- **Notes:** Currently disabled by default (requires SATRING_ENABLED=true). Our primary L402 data source. Some services have null pricing_sats.

### 3. l402apps.com -- IN PROGRESS

- **URL:** `https://www.l402apps.com`
- **Protocol:** L402
- **Listings:** 48 total (13 apps + 35 API endpoints)
- **API:** Semi -- data is embedded as `window.__APPS__` and `window.__APIS__` JSON arrays in the HTML response. The site also has L402-gated endpoints:
  - `GET /api/apps` -- 10 sats, returns apps JSON
  - `GET /api/apis` -- 10 sats, returns APIs JSON
  - `POST /api/submissions` -- 100 sats, submit an app
  - `POST /api/api-submissions` -- 10 sats (pays you), submit an API
- **Data fields for APIs:** id, provider, name, method, endpoint, cost (sats), costType, direction, icon, verified, featured, boost
- **Data fields for Apps:** id, name, url, description, image, icon, boost
- **Providers represented:** L402 Apps (self), Lightning Faucet, WoT Scoring API, Ganamos, Satring
- **Integration approach:** Scrape the embedded JSON from the HTML page (free, no L402 payment needed). The `window.__APIS__` array has all the structured data.
- **Unique value:** ~20-25 unique L402 endpoints not in Satring (Lightning Faucet APIs, WoT scoring APIs). High signal, hand-curated.
- **Priority:** HIGH -- small but unique L402 services, easy to parse, good quality data.

### 4. x402list.fun

- **URL:** `https://x402list.fun`
- **Protocol:** x402
- **Listings:** 13,373 services across 749 providers
- **API:** MCP integration only at $0.001/query for semantic search. No free REST API documented.
- **Data shown:** Service name, provider, pricing tiers, reliability metrics, transaction volume, network distribution
- **Categories:** Data Analytics, Developer Tools, AI/ML, DeFi Trading, Storage, Identity/Auth, NFTs, Gaming
- **Notes:** Claims to source data "directly from x402 facilitators." This likely means they also poll the Bazaar API, so the ~13,373 figure probably overlaps heavily with our Bazaar data. The additional value would be their reliability/transaction metrics, which we already generate via our own health checks.
- **Integration approach:** Would need to reverse-engineer their MCP or find their data source. Not worth it if it's just Bazaar data repackaged.
- **Priority:** MEDIUM -- investigate overlap with Bazaar before committing. If they have unique services not in Bazaar, worth exploring.

### 5. Ouroboros / x402 Discovery API

- **URL:** `https://x402-discovery-api.onrender.com/`
- **Protocol:** x402
- **Listings:** ~70+ services in catalog
- **API:** Yes, REST with multiple endpoints:
  - `GET /catalog` -- FREE, returns all services with quality metrics
  - `GET /discover?keyword=&category=&max_price=` -- $0.005/query (x402-gated)
  - `POST /register` -- FREE, register a new service
  - `POST /report` -- FREE, report outcomes
  - `GET /health/{endpoint_id}` -- FREE, health check data
  - `GET /.well-known/x402-discovery` -- FREE, well-known catalog
  - `GET /mcp` -- FREE, MCP interface
- **Data fields:** id, name, description, url, category, price_usd, network, asset_address, tags, uptime_pct, avg_latency_ms, health_status, capability_tags, agent_callable, sdk_snippet_python
- **Notes:** Built by the Ouroboros autonomous agent. Rich quality signals (uptime, latency, health). The `/catalog` endpoint is free and returns everything. Hosted on Render (free tier -- may be slow/cold-start). Contains services that self-registered, so may have unique entries not in Bazaar.
- **Integration approach:** Poll `GET /catalog` periodically. Free, no auth needed. Rich metadata.
- **Priority:** HIGH -- free API, rich quality data, likely has unique self-registered services not in Bazaar.

### 6. Fewsats Gateway (tools.l402.org)

- **URL:** `https://api.fewsats.com/v0/gateway/search` (was tools.l402.org, now DNS dead)
- **Protocol:** L402
- **Listings:** Unknown (API returned 404 when tested)
- **API:** Was REST at `/v0/gateway/search`, returning items with name, description, external_id, price_in_cents, status fields. L402 URIs formatted as `l402://api.fewsats.com/v0/gateway/{id}/info`
- **Notes:** tools.l402.org DNS is dead. The API endpoint returned 404. Fewsats may have deprecated this in favor of their MCP server approach. Their GitHub org has 31 repos but the gateway search endpoint appears defunct.
- **Integration approach:** Monitor for revival. Try alternative endpoints on api.fewsats.com.
- **Priority:** MEDIUM -- would be valuable if it comes back. Fewsats is a major L402 infrastructure company. Worth periodic checks.

### 7. awesome-x402 (xpaysh)

- **URL:** `https://github.com/xpaysh/awesome-x402`
- **Protocol:** x402
- **Listings:** ~40 projects/services curated (not all are API services)
- **API:** No (GitHub markdown README)
- **Notable entries mentioned:**
  - **Apollo Intelligence MCP Server** -- 26 tools (intelligence, crypto, OSINT, DeFi)
  - **Pylon MCP Server** -- 20 tools (web extraction, search, translation, code execution)
  - **Scout MCP** -- 10 tools (HN, GitHub, npm, PyPI, Product Hunt, Twitter intelligence)
  - **Intelligence Aeternum** -- First monetized MCP marketplace, 2M+ museum artworks
  - **Alfred's Digital Bazaar (httpay.xyz)** -- ~170 x402 endpoints
  - **zeroreader x402 AI API** -- 29 Cloudflare Workers AI models via x402
  - **MoonMaker API** -- 11 crypto data endpoints
  - **Gotobi Calendar API** -- Japanese FX settlement dates
  - **Weather/Mailcheck APIs** -- Utility endpoints
- **Integration approach:** Parse the GitHub README periodically to discover new services. Cross-reference URLs against our DB to find gaps. Most of these individual services would be in the Bazaar if they use CDP facilitator.
- **Priority:** LOW -- useful as a discovery source for manual curation, not for automated polling.

### 8. awesome-x402 (Merit-Systems)

- **URL:** `https://github.com/Merit-Systems/awesome-x402`
- **Protocol:** x402
- **Listings:** ~60+ projects across categories (facilitators, SDKs, services, tools)
- **API:** No (GitHub markdown README)
- **Notable unique entries:**
  - **x402Scan** (`x402scan.com`) -- ecosystem explorer
  - **x402station** (`x402station.com`) -- analytics platform
  - **PayAI** facilitator
  - **thirdweb** facilitator
  - **Corbits Faremeter** facilitator
  - **x402-dotnet** (C# implementation)
  - **x402-rails** (Ruby implementation)
  - Links to x402.org/ecosystem (200+ entries)
- **Integration approach:** Same as xpaysh -- manual discovery aid. The facilitator list is useful for understanding which networks/chains have x402 services.
- **Priority:** LOW -- reference material, not a data source.

### 9. awesome-L402 (Fewsats)

- **URL:** `https://github.com/Fewsats/awesome-L402`
- **Protocol:** L402
- **Listings:** 28 distinct projects (8 libraries, 9 projects, 5 tools, 6 companies)
- **API:** No (GitHub markdown README)
- **Notable entries for our purposes:**
  - **l402.directory** -- "Health-checked service registry" (not currently live/accessible)
  - **Satring** -- already integrated
  - **Hyperdope** -- L402-gated video streaming
  - **Maximum Sats** -- AI API on Cloudflare Workers
  - **L402 Shield** -- blockchain data API
  - **matador** -- API reverse proxy using L402
- **Integration approach:** Manual discovery. Cross-reference with Satring/l402apps for unique L402 services.
- **Priority:** LOW -- most active services from here would be on Satring or l402apps already.

### 10. x402.org/ecosystem

- **URL:** `https://www.x402.org/ecosystem`
- **Protocol:** x402
- **Listings:** 200+ projects (but most are SDKs, facilitators, tools -- not API services)
- **API:** No (HTML page, likely React/Next.js rendered)
- **Categories:** Client-Side Integrations, Services/Endpoints (~31), Infrastructure/Tooling, Learning, Facilitators
- **Notes:** This is the official Coinbase-maintained ecosystem page. The ~31 "Services/Endpoints" entries are the most relevant. However, any service listed here that uses CDP facilitator would already be in the Bazaar.
- **Integration approach:** Could scrape the Services/Endpoints section periodically. Not worth automated polling -- the Bazaar is the machine-readable version of this.
- **Priority:** LOW -- Bazaar already covers this.

### 11. x402.eco

- **URL:** `https://www.x402.eco/`
- **Protocol:** x402
- **Listings:** ~167 indexed (49 people, 31 services/endpoints, 19 facilitators, 38 infrastructure tools, etc.)
- **API:** No REST API. Provides an "installable ecosystem skill" for MCP agents: `npx skills add x402eco/x402eco`
- **Notes:** Functions as a "curated, machine-readable registry" optimized for agent-native access. Syncs on every run. The 31 service/endpoint entries are the relevant ones for us.
- **Integration approach:** Would need to install and invoke their MCP skill programmatically, or reverse-engineer the skill's data source. Not practical for periodic polling.
- **Priority:** LOW -- overlap with Bazaar and x402.org/ecosystem.

### 12. x402index.com

- **URL:** `https://www.x402index.com/`
- **Protocol:** x402
- **Listings:** 4 (very early stage)
- **API:** Yes, `GET /api/all` -- but x402-gated (requires payment). Returns: id, name, description, url, x402_facilitator, submitter_wallet, submitted_at
- **Notes:** A competing x402 directory with only 4 entries (X402 Index itself, Neynar, X402 Echo Merchant, thx40to). Very early. Community-submitted.
- **Integration approach:** Would need to pay x402 to access API. Not worth it for 4 entries.
- **Priority:** LOW -- too small, and we'd need to pay to poll.

### 13. x402scan.com

- **URL:** `https://www.x402scan.com/`
- **Protocol:** x402
- **Listings:** Unknown (JS SPA, content not accessible via fetch)
- **API:** Unknown
- **Notes:** Described as "x402 Ecosystem Explorer" for viewing transactions, sellers, origins, and resources. Built by Merit-Systems. May have unique on-chain transaction data. Needs browser-based investigation.
- **Integration approach:** Would need to reverse-engineer their API (if any) or scrape the SPA.
- **Priority:** LOW -- analytics tool, not a registry.

### 14. x402station.com

- **URL:** `https://x402station.com/`
- **Protocol:** x402
- **Listings:** 0 (showed "0 x402 Services Available")
- **API:** npm package `x402-analytics` for programmatic access
- **Notes:** Analytics/monitoring platform, not a registry. Currently shows zero data. May be in pre-launch.
- **Integration approach:** N/A
- **Priority:** LOW -- not a data source.

### 15. httpay.xyz (Alfred's Digital Bazaar)

- **URL:** `https://httpay.xyz`
- **Protocol:** x402
- **Listings:** 170+ endpoints across 9 categories
- **API:** References an "API Catalog" at `/api`. MCP server integration available.
- **Categories:** AI models, web scraping, crypto data, image generation, utilities
- **Pricing:** $0.001 to $0.05 per call in USDC on Base
- **Notes:** This is a substantial x402 API marketplace. The 170+ endpoints would be registered with the Bazaar if they use the CDP facilitator, but they might use their own facilitator. Worth investigating whether these are already in our Bazaar data.
- **Integration approach:** Check if httpay.xyz endpoints appear in Bazaar data. If not, try to access their `/api` catalog.
- **Priority:** MEDIUM -- large endpoint count, but likely overlaps with Bazaar.

### 16. BlockRun

- **URL:** `https://blockrun.ai`
- **Protocol:** x402
- **Listings:** 42+ LLM models from 12 providers (OpenAI, Anthropic, Google, xAI, DeepSeek, Meta, Mistral, Alibaba, Cohere, Together, Fireworks, Groq)
- **API:** No public listing API for available models. Uses OpenAI-compatible format for inference.
- **Notes:** BlockRun is an AI Gateway, not a registry. It proxies to multiple LLM providers via x402 pay-per-request. Their endpoints may appear in the Bazaar if they register there. The "600+ x402 services" claim from awesome-x402 may refer to individual model+endpoint combinations.
- **Integration approach:** Check Bazaar for BlockRun endpoints. Otherwise, would need to scrape their docs for model list.
- **Priority:** LOW -- gateway, not a registry. Their endpoints likely in Bazaar already.

### 17. Agent Arena

- **URL:** `https://agentarena.site`
- **Protocol:** x402 (also A2A, MCP, OASF)
- **Listings:** Unknown count of registered agents
- **API:** Yes, x402-gated at $0.001 USDC per search query. Endpoints for searching agents, retrieving profiles, and registration.
- **Notes:** On-chain ERC-8004 agent registry, not an API service directory per se. Registers autonomous agents (identities), not API endpoints. Operates across 16 blockchains. Interesting for cross-referencing agent capabilities with x402 services.
- **Integration approach:** Would need to pay $0.001 per search. Could do periodic bulk queries. But this is an agent registry, not a service registry -- different use case.
- **Priority:** MEDIUM -- unique data source for agent-as-service entries. Worth exploring what "services" agents offer.

### 18. Sats4AI

- **URL:** `https://sats4ai.com/l402`
- **Protocol:** L402
- **Listings:** 3 (Image Generation, Text Generation, SMS)
- **API:** No listing endpoint
- **Notes:** Small L402 provider. Privacy-focused, no accounts. Three services only.
- **Integration approach:** Manual YAML listing
- **Priority:** LOW -- only 3 services, can add manually.

### 19. alittlebitofmoney.com

- **URL:** `https://alittlebitofmoney.com`
- **Protocol:** L402
- **Listings:** 3 providers (OpenAI, Anthropic, OpenRouter proxied via L402)
- **API:** Has a `/catalog` page, unclear if machine-readable
- **Notes:** Lightning API Gateway for AI models. Pay-per-request, no signup. Similar to BlockRun but for L402.
- **Integration approach:** Check `/catalog` for machine-readable data. Otherwise manual listing.
- **Priority:** LOW -- gateway, not a directory. 3 provider proxies.

### 20. LightningProx

- **URL:** `https://lightningprox.com`
- **Protocol:** L402
- **Listings:** 2 live ecosystem products (Is It A Rug, LPX Poly) + AI model proxying
- **API:** No listing endpoint
- **Notes:** Payment infrastructure, not a directory. Provides L402-gated access to Claude and GPT-4o. Very early stage.
- **Integration approach:** Manual YAML listing if desired
- **Priority:** LOW -- infrastructure, not a registry.

### 21. Aperture (Lightning Labs)

- **URL:** `https://github.com/lightninglabs/aperture`
- **Protocol:** L402
- **Listings:** 2 known (Lightning Loop, Pool -- both Lightning Labs products)
- **Notes:** Aperture is the reference L402 reverse proxy implementation. It does NOT maintain a directory of services using it. Any service using Aperture is essentially self-hosted and not discoverable through a central registry. The lack of a discovery layer is exactly what Satring and l402apps are trying to solve for the L402 ecosystem.
- **Integration approach:** N/A -- no directory exists
- **Priority:** N/A -- reference implementation, not a data source.

### 22. x402 API Network

- **URL:** `https://x402.fatihai.app`
- **Protocol:** x402
- **Listings:** 16 utility endpoints (email verification, DNS lookup, WHOIS, web scraping, AI content gen, etc.)
- **Notes:** Already registered in the Bazaar with input/output schemas. These endpoints are already in our Bazaar poll data.
- **Integration approach:** Already covered via Bazaar
- **Priority:** N/A -- already in Bazaar.

### 23. Apexti Toolbelt

- **URL:** `https://apexti.com/toolbelt`
- **Protocol:** x402 (claimed, but not confirmed on their site)
- **Listings:** Claims 1,500+ (or 2,000+ "hosted tools") -- these are MCP tool wrappers around third-party APIs
- **API:** No public listing endpoint documented. Requires signup/demo.
- **Notes:** Apexti is an MCP hosting platform that wraps existing APIs as MCP tools. The "1,500+" figure likely refers to MCP tool definitions, not unique x402-payable endpoints. Their x402 support may be opt-in per tool. Without a public API to query available tools and their x402 status, integration is not feasible.
- **Integration approach:** Would need API access or partnership. Not practical for automated polling.
- **Priority:** MEDIUM conceptually (large catalog) but LOW practically (no public API, unclear x402 coverage).

---

## Additional Sources Discovered During Research

### 24. Coinbase x402 Roadmap

- **URL:** `https://github.com/coinbase/x402/blob/main/ROADMAP.md`
- **Status:** Placeholder only -- "(update coming soon)"
- **Notes:** No registry features announced yet. The Bazaar IS their discovery layer.

### 25. Analytix402

- **URL:** `https://analytix402.com`
- **Protocol:** x402
- **Notes:** Monitoring/security tool for x402 APIs, not a registry. Express.js middleware SDK. Could be useful for our health check system but not as a data source.

### 26. g402.ai

- **URL:** `https://www.g402.ai/` / `https://docs.g402.ai/`
- **Protocol:** x402
- **Notes:** Managed payment gateway for x402. Not a registry. Acts as a facilitator (payment proxy). Services using g402 may or may not appear in the Coinbase Bazaar depending on facilitator registration.

### 27. Zuplo x402

- **URL:** `https://zuplo.com/blog/mcp-api-payments-with-x402`
- **Notes:** API management platform with x402 integration capability. Does not maintain a service directory. Enables developers to add x402 to their APIs.

### 28. docs.l402.org

- **URL:** `https://docs.l402.org/`
- **Notes:** L402 protocol documentation site. No service directory or registry. Payment-agnostic (supports Lightning, Stripe, Coinbase Commerce, on-chain).

### 29. marketx402.app

- **URL:** `https://marketx402.app/`
- **Status:** DNS not found (dead)
- **Notes:** Was listed in search results as "X402 MARKET PLACE - Access any third party API instantly with no API key needed!" but appears to be defunct.

---

## Priority Ranking for Integration

### Tier 1: Integrate Now (High unique value, easy API)

| Source | Unique listings | Effort | Why |
|--------|----------------|--------|-----|
| **l402apps.com** | ~20-25 L402 endpoints | 1-2 hours | Embedded JSON, no auth needed, unique Lightning Faucet/WoT APIs |
| **Ouroboros Discovery API** | ~70 x402 services | 2-3 hours | Free /catalog endpoint, rich quality metrics, self-registered services |

### Tier 2: Investigate Then Integrate (Potential value, needs validation)

| Source | Potential listings | Effort | Why |
|--------|-------------------|--------|-----|
| **x402list.fun** | ~13,373 (likely Bazaar overlap) | 4-6 hours | Need to determine overlap with Bazaar data first |
| **httpay.xyz** | ~170 endpoints | 2-4 hours | Check /api catalog, verify Bazaar overlap |
| **Agent Arena** | Unknown | 3-5 hours | Unique agent-as-service data, needs x402 payment to query |
| **Fewsats Gateway** | Unknown | 1-2 hours | Monitor for API revival; major L402 infra company |

### Tier 3: Manual Curation (Small but unique)

| Source | Listings | Effort | Why |
|--------|----------|--------|-----|
| **Sats4AI** | 3 | 30 min | Manual YAML entries |
| **alittlebitofmoney.com** | 3 | 30 min | Manual YAML entries |
| **LightningProx** | 2 | 15 min | Manual YAML entries |

### Tier 4: Reference Only (No actionable data)

- awesome-x402 lists (both) -- discovery aids, not data sources
- awesome-L402 -- discovery aid
- x402.org/ecosystem -- covered by Bazaar
- x402.eco -- MCP skill only, overlaps with Bazaar
- x402index.com -- 4 entries, x402-gated
- x402scan.com -- analytics, not registry
- x402station.com -- empty/pre-launch
- BlockRun -- gateway, in Bazaar
- Aperture -- reference impl, no directory
- Apexti -- no public API
- Coinbase Roadmap -- placeholder

---

## Key Insights

1. **The x402 ecosystem has near-complete centralization around the Coinbase Bazaar.** Almost all x402 services that use the CDP facilitator auto-register there. The ~13K figure is the ceiling for x402 services. Other x402 directories (x402list.fun, x402.org/ecosystem) are largely repackaging Bazaar data.

2. **The L402 ecosystem is fragmented.** There is no equivalent to the Bazaar for L402. Satring (94 services), l402apps.com (48 services), and Fewsats are the main aggregation points, but many L402 services exist in isolation (behind Aperture proxies with no discovery mechanism).

3. **Ouroboros Discovery API is the most interesting new source.** It has self-registered services that may not be in the Bazaar, plus rich quality metrics. Free to poll.

4. **l402apps.com is the highest-ROI integration.** Small but unique L402 services, structured data already embedded in HTML, no auth needed.

5. **The ecosystem is splitting between MCP-native discovery (x402.eco, Apexti) and REST API discovery (Bazaar, Satring, Ouroboros).** 402index should support both paradigms eventually -- REST for polling, MCP for agent-native access.

6. **Competing directories exist but are tiny.** x402index.com (4 entries), x402list.fun (Bazaar mirror), x402scan.com (analytics). None pose a real competitive threat to a well-executed aggregator.

7. **The total addressable catalog across all unique sources is roughly:**
   - ~13,000 x402 services (Bazaar) + ~70 unique Ouroboros entries + ~170 httpay.xyz (overlap TBD)
   - ~94 L402 services (Satring) + ~25 unique l402apps entries + ~8 manual listings
   - **Estimated total: ~13,200-13,400 unique services**
