# Stacker News Post Draft

> **Title:** I built a directory of every paid API on the internet that AI agents can use

---

AI agents are getting good at writing code, browsing the web, and reasoning through problems. But they still can't pay for things.

That's changing with two protocols — **L402** (Lightning-native paywalls) and **x402** (Coinbase's chain-agnostic micropayments). Both use HTTP 402 ("Payment Required") to let APIs charge per-request, no API keys or accounts needed. An agent hits an endpoint, gets a payment challenge, pays a Lightning invoice or on-chain transaction, and gets access. Fully autonomous commerce.

The problem: there's no way for agents to *discover* these endpoints. They're scattered across dozens of providers with no central index. An agent that wants to buy web search results, AI inference, or market data has to already know where to look.

**[402 Index](https://402index.io)** is that missing discovery layer. It aggregates every L402 and x402 endpoint we can find into a single searchable directory with:

- **~13,800 endpoints indexed** across both protocols (~125 L402, ~13,700 x402)
- **767+ payment-verified** — we actually hit the endpoint and confirm the paywall works correctly
- **Real-time health monitoring** — every endpoint probed every 15 minutes
- **REST API + MCP server** — so your agent can query the directory programmatically
- **RSS feed, webhooks, and Nostr** — subscribe to new endpoints as they appear

### Why this matters for Bitcoin

x402 has 100x more endpoints right now because Coinbase auto-registers everything on Base. But L402 endpoints are *higher quality* — real services with real paywalls, not auto-generated stubs. The L402 ecosystem has providers like Fewsats, Sulu, Flash, and a growing number of indie developers building Lightning-native APIs.

402 Index tracks the full picture but we're particularly focused on growing the L402 side. Every verified L402 endpoint is a node in the agent commerce graph that runs on Lightning.

### Try it

- **Browse:** [402index.io](https://402index.io)
- **Live demo:** [402index.io/demo](https://402index.io/demo) — interactive dashboard with live endpoint probing
- **API:** [402index.io/api-docs](https://402index.io/api-docs)
- **MCP Server:** `npm install @402index/mcp-server` — plug the directory into any MCP-compatible agent
- **RSS:** [402index.io/feed.xml](https://402index.io/feed.xml)
- **Machine-readable:** [402index.io/llms.txt](https://402index.io/llms.txt)

If you're building an L402 service and want to be listed, check our [registration API](https://402index.io/api-docs) or submit a listing.

Happy to answer questions about the L402 vs x402 landscape, agent commerce patterns, or the technical details of how we verify endpoints.
