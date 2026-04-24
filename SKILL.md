---
name: 402index
version: 0.1.0
description: Discover paid APIs and execute payments using 402 Index. Use when an agent needs to find a capability it lacks (image generation, specialized inference, data feeds, etc.), pay for it with Lightning or stablecoins, and consume the result. Triggers on phrases like "find a paid API", "buy this capability", "search 402index", "pay with Lightning", "L402", "MPP", or when the agent hits an architectural limitation it cannot reason past.
---

# 402 Index — Discover and Pay for APIs

402 Index is a protocol-agnostic directory of thousands of paid API endpoints across three payment protocols: L402 (Lightning Network), x402 (Coinbase/EVM stablecoins), and MPP (Stripe/Tempo machine payments). This skill teaches you to discover APIs you need, select a payment method, and execute the payment — no API keys, no signups, just pay-per-request.

**Live directory:** https://402index.io
**API docs:** https://402index.io/api-docs
**OpenAPI spec:** https://402index.io/api/v1/openapi.json

## When to Use This Skill

Use this skill when:
- You need a capability you don't have (image generation, specialized models, real-time data)
- The user asks you to find or use a paid API
- You encounter an HTTP 402 Payment Required response
- The user mentions 402index, L402, x402, MPP, or Lightning payments

## Agent Behavior Notes

- **Run payment commands synchronously.** Do NOT background lnget or mppx calls. Image generation takes 60-90s — wait for the result inline.
- **`--no-pay` only works for L402 endpoints, NOT for MPP.** To preview MPP costs, check the price in the 402index listing before paying. Do not use `--no-pay` with `--prefer-scheme payment`.
- **If search returns errors, skip to the known-good endpoints below.** Do not retry with different query variations — use the Quick Start or category-based search instead.

## Quick Start

```
1. Discover  →  Search 402 Index for what you need (MCP or REST)
2. Evaluate  →  Check health, price, protocol
3. Detect    →  What payment tools are installed?
4. Pay       →  Execute payment with the right tool
5. Consume   →  Parse and use the response
```

### Known-good endpoints (fallback)

If `search_services` returns errors, use one of these verified endpoints instead. **Last verified: 2026-04-24.** For current status, check each listing on 402index.io.

Table order: one endpoint per protocol, plus one dual-rail example (llm402 Kimi-K2.6) showing an endpoint that accepts both L402 and x402 payments against the same URL — a pattern 402 Index tracks natively.

| Service | Protocol(s) | Price | URL | Example payment command |
|---------|-------------|-------|-----|------------------------|
| Mutinynet Faucet | L402 | 50 sats | `https://faucet.mutinynet.com/api/l402` | `lnget --max-cost 100 -q "https://faucet.mutinynet.com/api/l402"` |
| Nansen: Recent buyers and sellers | x402 | see 402 response (~$0.01 USDC on Base) | `https://api.nansen.ai/api/v1/tgm/who-bought-sold` | Use `@x402/fetch` with a Base USDC signer (see Step 4, x402 section). Requires POST. |
| AgentMail: Create inbox | MPP | $2 USDC | `https://mpp.api.agentmail.to/v0/inboxes` | `npx mppx -X POST -H "Content-Type: application/json" -d '{}' "https://mpp.api.agentmail.to/v0/inboxes"` |
| llm402 Kimi-K2.6 *(dual-rail example)* | **L402 + x402** | 21 sats (L402) or ~$0.0079 / 42 sats (x402) | `https://llm402.ai/v1/chat/completions/Kimi-K2.6` | Either rail works against the same URL. L402: `lnget --max-cost 50 -X POST -H "Content-Type: application/json" -d '{"model":"Kimi-K2.6","messages":[...]}' "https://llm402.ai/v1/chat/completions/Kimi-K2.6"` · x402: use `@x402/fetch` with a Base USDC signer. Both rails are indexed separately on 402index.io. |

**About the dual-rail row:** the llm402 Kimi-K2.6 URL is registered twice on 402index.io — once as L402 (21 sats) and once as x402 ($0.0079). 402 Index's probe detects both rails automatically from a single provider registration. When `search_services` returns this URL, an agent sees two entries it can choose between based on which payment capability it has (Lightning vs. EVM stablecoins). This is the intended shape of dual-rail coverage across the directory and a useful reference when building agents that prefer one rail over another.

All four are probed healthy on 402index.io at the last-verified date. If any returns an error when tried, fall back to `search_services({ category: "<category>", health: "healthy" })` or open the live directory at 402index.io.

## Step 1: Discover — Find the Right Endpoint

### Option A: MCP Server (preferred — structured data, token-efficient)

If the 402 Index MCP server is registered (`@402index/mcp-server`), use these tools:

```
search_services({
  q: "image generation",
  protocol: "MPP",
  health: "healthy",
  sort: "price",
  limit: 10
})
```

**Available filters:** `protocol` (L402, x402, MPP), `category`, `health` (healthy, degraded, down), `q` (text search), `max_price_usd`, `sort` (name, price, latency, uptime, reliability), `featured`, `payment_asset`, `lnget_compatible`.

Then inspect a specific endpoint:

```
get_service_detail({ id: "<service-id>" })
```

This returns full metadata including URL, pricing, health history, probe body format, and protocol details.

### Option B: REST API (no setup required)

```bash
curl -s "https://402index.io/api/v1/services?q=image+generation&health=healthy&protocol=MPP&sort=price&limit=5" | jq '.services[] | {name, url, protocol, price_usd, health_status}'
```

### Option C: llms.txt (quick orientation)

```bash
curl -s https://402index.io/llms.txt
```

Returns a machine-readable summary of the directory — useful for initial orientation.

### If search returns errors

If text search (`q=`) returns 500 errors, use category-based search instead:

```
search_services({ category: "ai/image-generation", health: "healthy" })
```

Or skip discovery entirely and use a known-good endpoint from the Quick Start section above.

## Step 2: Evaluate the Endpoint

Before paying, verify:

1. **Health status** — only use `healthy` endpoints. `degraded` means the paywall works but the challenge may be malformed. `down` means don't bother.
2. **Price** — check `price_sats` (Bitcoin) or `price_usd`. Convert: 1 USD ≈ 1,100 sats (varies).
3. **Protocol** — determines which payment tool you need:
   - `L402` → Lightning Network (Bitcoin). Use `lnget`.
   - `MPP` → Machine Payments Protocol (Tempo stablecoins, Stripe, Lightning). Use `lnget --prefer-scheme payment` for Lightning-settled MPP, or `mppx` for Tempo-settled MPP.
   - `x402` → EVM stablecoins (Base USDC, Solana). Use `@x402/fetch` or `pay402`. *(v1 stub — see x402 section below)*
4. **HTTP method** — check `http_method`. Most are GET, but image generation and inference endpoints are POST. The `probe_body` field shows the expected request format.

## Step 3: Detect Payment Tools

Before executing payment, detect what's available on this machine. Run these checks:

### lnget (L402 + MPP via Lightning)

```bash
which lnget && lnget --version && lnget ln status
```

If installed and connected, `lnget` handles both L402 and MPP (with `--prefer-scheme payment`). This is the most versatile single tool — covers two of three protocols.

**If not installed:** lnget requires Go and a Lightning node (local lnd or remote via LNC). Install: `go install github.com/lightninglabs/lnget/cmd/lnget@latest`. For full setup including Lightning node configuration, see the lnget skill from Lightning Labs' lightning-agent-tools: https://github.com/lightninglabs/lightning-agent-tools/blob/main/skills/lnget/SKILL.md (reference commit: `6f3017a`). If a newer version is available at that URL, prefer its instructions over the embedded patterns below.

### mppx (MPP via Tempo / stablecoins)

```bash
which mppx || npx mppx --help 2>/dev/null
```

If available, `mppx` handles MPP endpoints natively. Works with Tempo wallet (stablecoins), Stripe, and other MPP payment methods.

**If not installed:** `npm install -g mppx` or use `npx mppx` for one-off calls. Requires a Tempo wallet — create one with `npx mppx account create`. Fund with `npx mppx account fund` (testnet) or transfer USDC (mainnet). See https://mpp.dev/sdk/typescript/cli for full CLI reference.

### @x402/fetch (x402 — EVM stablecoins)

```bash
npm list @x402/fetch 2>/dev/null || npm list -g @x402/fetch 2>/dev/null
```

**If not installed:** `npm install @x402/fetch @x402/evm`. Requires an EVM wallet (private key) with USDC on Base or Solana. See https://docs.cdp.coinbase.com/x402/quickstart-for-buyers

### pay402 (L402 + x402 bridge)

```bash
npm list pay402 2>/dev/null || npm list -g pay402 2>/dev/null
```

Universal bridge that auto-detects protocol and selects the right payment rail. Supports L402 (Lightning) and x402 (EVM). See https://github.com/RDMoutlaw/pay402

### No payment tools found

If none of the above are detected, inform the user:

> "I found the endpoint you need on 402 Index, but no payment tools are installed. To pay for this service, you'll need one of:
> - **lnget** (for L402/Lightning endpoints): `go install github.com/lightninglabs/lnget/cmd/lnget@latest` + a Lightning node
> - **mppx** (for MPP/Tempo endpoints): `npm install -g mppx` + `npx mppx account create`
> - **@x402/fetch** (for x402/USDC endpoints): `npm install @x402/fetch @x402/evm` + an EVM wallet with USDC
>
> The easiest path for small payments is lnget with Lightning or mppx with Tempo."

## Step 4: Execute Payment

### L402 Endpoints (lnget)

```bash
# GET request
lnget --max-cost 1000 -q "https://api.example.com/data"

# POST request (e.g., LLM inference)
lnget -X POST \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-r1","prompt":"Analyze this contract..."}' \
  --max-cost 500 -q \
  "https://llm402.ai/api/generate/deepseek-r1"
```

**How it works under the hood:**
1. lnget sends the request
2. Server returns HTTP 402 with `WWW-Authenticate: L402 macaroon="...", invoice="..."`
3. lnget checks invoice amount against `--max-cost`
4. lnget pays the Lightning invoice via configured backend
5. lnget retries with `Authorization: L402 <macaroon>:<preimage>`
6. Server validates and returns the resource

**Key flags:**
- `--max-cost <sats>` — hard spending limit per request (default: 1000)
- `--no-pay` — preview the 402 challenge without paying (L402 only — does NOT work for MPP)
- `--payment-timeout <duration>` — extend for slow endpoints (default: 60s)
- `-q` — quiet mode, outputs only the response body (ideal for piping)
- `--json` — structured output including payment metadata

### MPP Endpoints via Lightning (lnget)

```bash
lnget -X POST \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-1","prompt":"a logo for my project","size":"1024x1024"}' \
  --prefer-scheme payment \
  --max-cost 500 \
  --payment-timeout 180s \
  -q \
  "https://api.ppq.ai/v1/images/generations/gpt-image-1"
```

**Critical:** Use `--prefer-scheme payment` for MPP endpoints. Without it, lnget defaults to L402 scheme negotiation and will fail against MPP-only servers.

**Critical:** For image generation endpoints, use `--payment-timeout 180s`. Image generation takes 60-90 seconds — the default 60s timeout will expire before the image is ready.

### MPP Endpoints via Tempo (mppx)

```bash
npx mppx -X POST \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-1","prompt":"a logo","size":"1024x1024"}' \
  "https://api.ppq.ai/v1/images/generations/gpt-image-1"
```

mppx automatically handles the `WWW-Authenticate: Payment` challenge, pays via the configured Tempo wallet, and retries with the payment credential.

### x402 Endpoints (stub — limited support in v1)

x402 payment execution requires an EVM wallet with USDC. If `@x402/fetch` or `pay402` is detected, the flow is:

```javascript
// Using @x402/fetch (Node.js)
import { wrapFetchWithPayment } from "@x402/fetch"
import { registerExactEvmScheme } from "@x402/evm/exact/client"

const client = new x402Client()
registerExactEvmScheme(client, { signer: walletAccount })
const fetchWithPayment = wrapFetchWithPayment(fetch, client)
const response = await fetchWithPayment("https://api.example.com/endpoint")
```

For detailed x402 payment instructions, see: https://docs.cdp.coinbase.com/x402/quickstart-for-buyers

## Step 5: Consume the Response

Parse the response based on the endpoint type:

**JSON data (most endpoints):**
```bash
lnget --max-cost 100 -q "https://api.example.com/data" | jq '.result'
```

**Image generation (URL in response):**
```bash
# 1. Get image URL from response
response=$(lnget -X POST ... -q "https://api.ppq.ai/v1/images/generations/gpt-image-1")
image_url=$(echo "$response" | jq -r '.data[0].url')

# 2. Download the image
curl -sL "$image_url" -o /tmp/generated-image.png

# 3. Resize if needed (macOS)
sips -z 400 400 /tmp/generated-image.png --out /tmp/final.png
```

**LLM inference:**
```bash
response=$(lnget -X POST ... -q "https://llm402.ai/api/generate/model-name")
echo "$response" | jq -r '.choices[0].message.content // .response // .text'
```

## Budget Controls

**Always enforce spending limits.** The default behavior should be safe:

1. **Preview before paying (L402 only)** — Use `--no-pay` to see what it costs before committing. **Warning:** `--no-pay` only works for L402 endpoints. It does NOT prevent payment on MPP endpoints — lnget will still pay. For MPP, check the price in the 402index listing instead.
   ```bash
   # L402 endpoints only:
   lnget --no-pay --json "https://api.example.com/data" | jq '.invoice_amount_sat'
   ```

2. **Hard cap per request** — Always pass `--max-cost`:
   ```bash
   lnget --max-cost 500 ...   # Never pay more than 500 sats (~$0.50)
   ```

3. **Ask the user if cost exceeds $1** — If the endpoint price is above $1.00 USD (or ~1,100 sats), pause and ask the user for explicit approval before paying. Show them: the endpoint name, URL, price, and what you'll get for it.

4. **Track cumulative spend** — If making multiple paid requests in one session, keep a running total and inform the user periodically.

## Decision Tree

```
User needs a capability
  │
  ├─ Can I do this myself? → Yes → Do it (no payment needed)
  │
  └─ No (architectural gap, quality gap, data gap)
      │
      ├─ Search 402 Index (MCP preferred, REST fallback)
      │   └─ Filter: health=healthy, protocol, category, max_price
      │
      ├─ Evaluate top results (price, health, latency)
      │
      ├─ Detect payment tools
      │   ├─ lnget found? → L402 and MPP/Lightning endpoints ✓
      │   ├─ mppx found?  → MPP/Tempo endpoints ✓
      │   ├─ @x402/fetch? → x402 endpoints ✓
      │   ├─ pay402?      → L402 + x402 bridge ✓
      │   └─ None found   → Advise user on installation
      │
      ├─ Price check
      │   ├─ ≤ $1.00  → Pay automatically (within --max-cost)
      │   └─ > $1.00  → Ask user for approval first
      │
      ├─ Execute payment → Parse response → Use result
      │
      └─ Report to user: what was bought, cost, result
```

## Concrete Example: Buy Image Generation

This is a complete, tested workflow. An agent cannot generate images on its own — it must buy the capability.

**1. Discover**
```
search_services({ q: "image generation", protocol: "MPP", health: "healthy" })
```
Returns PayPerQ endpoints: GPT Image 1 ($0.024), Flux 2 Pro ($0.029), etc.

**2. Evaluate**
```
get_service_detail({ id: "<gpt-image-1-service-id>" })
```
Confirms: healthy, MPP protocol, OpenAI-compatible API, probe body format.

**3. Detect** — `which lnget` → found, `lnget ln status` → connected.

**4. Pay and consume**
```bash
response=$(lnget -X POST \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-1","prompt":"A minimalist icon: magnifying glass with Lightning bolt, blue on dark navy, flat vector, no text","size":"1024x1024"}' \
  --prefer-scheme payment \
  --max-cost 500 \
  --payment-timeout 180s \
  -q \
  "https://api.ppq.ai/v1/images/generations/gpt-image-1")

image_url=$(echo "$response" | jq -r '.data[0].url')
curl -sL "$image_url" -o /tmp/generated-logo.png
```

**Cost:** 33 sats (~$0.02). **Time:** ~90 seconds (payment <1s, generation ~60-90s). **API keys:** 0.

## Protocol Reference

### L402 (Lightning Network)
- **Challenge:** `WWW-Authenticate: L402 macaroon="<base64>", invoice="<bolt11>"`
- **Auth:** `Authorization: L402 <macaroon>:<preimage>`
- **Settlement:** Lightning Network, instant, Bitcoin
- **Tool:** `lnget`

### MPP (Machine Payments Protocol)
- **Challenge:** `WWW-Authenticate: Payment` with challenge JSON
- **Auth:** `Authorization: Payment <credential>`
- **Settlement:** Lightning (via lnget) or Tempo blockchain (via mppx), Stripe, Visa
- **Tools:** `lnget --prefer-scheme payment` (Lightning-settled) or `mppx` (Tempo-settled)
- **Spec:** https://github.com/tempoxyz/mpp-specs
- **Registry:** https://mpp.dev/services

### x402 (EVM Stablecoins)
- **Challenge:** `PAYMENT-REQUIRED` header with Base64 JSON
- **Auth:** `PAYMENT-SIGNATURE` header with signed payload
- **Settlement:** Base (USDC), Solana, on-chain via facilitator
- **Tools:** `@x402/fetch`, `pay402`
- **Spec:** https://github.com/coinbase/x402
- **Note:** x402 payment execution requires an EVM wallet with USDC. Detect `@x402/fetch` or `pay402` before attempting. If neither is available, inform the user and recommend: `npm install @x402/fetch @x402/evm` + wallet setup via Coinbase Developer Platform.

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| lnget times out on image gen | Default 60s timeout | Use `--payment-timeout 180s` |
| lnget fails on MPP endpoint | Missing scheme flag | Add `--prefer-scheme payment` |
| "exceeds max cost" exit code 2 | Price > --max-cost | Increase `--max-cost` or use `--no-pay` to preview |
| "payment failed" exit code 3 | Insufficient balance or routing failure | Check `lnget ln status` and wallet balance |
| `--no-pay` still paid on MPP | `--no-pay` only suppresses L402 payments | For MPP endpoints, check the 402index listing price instead. Do not use `--no-pay` with `--prefer-scheme payment` |
| 402 Index search returns 500 | Text search (`q=`) intermittently errors | Use category-based search (`category=ai/image-generation`) or skip to Quick Start |
| 402 Index returns no results | Filters too narrow | Broaden search: remove protocol/category filter, try different query terms |
| Endpoint shows "degraded" | Paywall works but challenge may be malformed | Try it anyway — if challenge parses, it may still work |
| mppx "no account" error | Tempo wallet not created | Run `npx mppx account create` then `npx mppx account fund` |

## Token Caching

Both `lnget` and `mppx` cache payment credentials per-domain. After paying once, subsequent requests to the same domain reuse the cached token without additional payment (until the token expires).

```bash
# View cached lnget tokens
lnget tokens list

# Remove a token to force re-payment
lnget tokens remove api.ppq.ai
```

## Further Reading

- **402 Index API docs:** https://402index.io/api-docs
- **402 Index MCP server:** `npx @402index/mcp-server` or `npm install @402index/mcp-server`
- **lnget full skill:** https://github.com/lightninglabs/lightning-agent-tools/blob/main/skills/lnget/SKILL.md
- **mppx CLI reference:** https://mpp.dev/sdk/typescript/cli
- **x402 buyer quickstart:** https://docs.cdp.coinbase.com/x402/quickstart-for-buyers
- **pay402 universal bridge:** https://github.com/RDMoutlaw/pay402
- **Lightning agent tools:** https://github.com/lightninglabs/lightning-agent-tools
