# 402 Index — Provider Outreach Playbook

**Last updated:** February 26, 2026

---

## Strategy

Exclusive supply is the primary moat. Every provider we personally onboard creates a listing that exists nowhere else. Aggregated Bazaar data is table stakes — anyone can do that. Providers we helped monetize are defensible.

**Target profile:** Operators running useful APIs that are currently free, donation-funded, or under-monetized. They have a "donate" button, a Patreon link, or a GitHub Sponsors badge. They'd benefit from per-request micropayments but haven't set it up because the friction was too high.

---

## Priority Provider Targets

### Tier 1 — Warm / High Signal

1. **Jordi at Fewsats** ✅ Reached out
   - Fellow L402 builder, years at this intersection
   - Ask: What services would he list? Who else should we talk to? What's missing from the ecosystem?
   - He may have Fewsats services to list or can intro us to providers

### Tier 2 — Cold Outbound, High Fit

2. **Pirate Weather** (pirateweather.net)
   - Open-source Dark Sky replacement, NOAA-sourced
   - Currently donation-funded
   - Perfect candidate: useful API, established userbase, would benefit from micropayments
   - Pitch: "Monetize your API with per-request payments. We'll help you add L402 gating and list you in the 402 Index."

3. **PurpleAir community API wrappers**
   - Air quality data from PurpleAir sensor network
   - Community-built wrapper APIs
   - Find operators via PurpleAir developer forums / GitHub

4. **SearXNG instance operators**
   - Privacy-focused metasearch engine
   - Many public instances run at a loss
   - Natural fit for pay-per-search micropayments
   - Find operators via searx.space instance list

5. **r/LocalLLaMA self-hosters**
   - People running Ollama, vLLM, llama.cpp serving inference
   - n8n already has x402+Ollama template — proves the pattern works
   - Find operators via Reddit, HuggingFace community
   - Pitch: "Monetize your GPU. We list your inference endpoint, agents pay per request."

6. **Firecrawl** (firecrawl.dev)
   - YC-backed web scraping API, already has MCP server
   - Currently charges credits, could add L402/x402 as alternative
   - Higher bar — funded startup, may not prioritize this

7. **Whisper API self-hosters**
   - Speech-to-text inference, natural per-request pricing
   - Find via HuggingFace, GitHub whisper-api projects

8. **ComfyUI / Automatic1111 operators**
   - Image generation endpoints
   - Many hobby operators would appreciate revenue
   - Find via r/StableDiffusion, CivitAI community

### Tier 3 — Aspirational / Longer-Term

9. **Open-Meteo** — Open weather API, may not want to add payment gating
10. **Jina AI Reader** — Web content extraction, established product
11. **Tavily** — AI search API, already monetized via API keys
12. **Mullvad VPN** — Privacy service, structural fit for L402 but complex integration

---

## Outbound Email Template

**Subject:** List your API in the 402 Index (free)

```
Hi [name],

I'm building 402index.io — the first directory that indexes both L402 and x402 
paid APIs for AI agents and developers.

I'd love to list [service name] as one of our first featured services. Here's 
what that means for you:

- Free listing with description, pricing, schema, and usage examples
- Health monitoring and uptime tracking (we check every 15 min)
- Exposure to AI agents via our MCP server (coming in March)
- A dedicated page optimized for "[service name] API" search queries

If you're not already gated with L402 or x402, I can help you set it up in 
~10 minutes. I built the Golem gateway — it's a one-command reverse proxy 
that adds L402 payment gating to any API.

Would you be interested? Happy to jump on a quick call or just trade 
a few emails.

— [Ryan]
402index.io | @[handle]
```

**Customize per recipient:** Reference their specific service, mention their donation/funding model, explain why per-request payments suit their use case.

---

## Onboarding Flow (For Providers Who Say Yes)

1. **If they already have L402/x402:** Just need their endpoint details. Create YAML listing, submit PR, they're live in minutes.

2. **If they need help adding payment gating:**
   - L402 via Golem gateway: `golem gateway --upstream localhost:3000 --price 0.002 --currency USD`
   - x402 via Coinbase SDK: Point them to `npm install @x402/express` and the 5-line middleware setup
   - Offer a 15-minute pairing session to get them set up

3. **After onboarding:** Create their YAML listing, run health check to verify, push to index. Send them the live listing link. Ask them to share it.

---

## Tracking

Track outbound efforts in a simple table:

| Provider | Status | Date Contacted | Response | Listed? | Notes |
|----------|--------|---------------|----------|---------|-------|
| Jordi/Fewsats | ✅ Contacted | 2026-02-26 | Pending | No | First call, warm lead |
| Pirate Weather | Not yet | — | — | No | Donation-funded, perfect fit |
| ... | ... | ... | ... | ... | ... |

Update this as outreach progresses.
