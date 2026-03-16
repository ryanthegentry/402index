# CC Prompt: L402 Provider Discovery Batch — 5 Providers

## Context

402index.io is a registry of L402/x402 paid API endpoints. We've been finding degraded L402 services in our Satring-sourced listings that are actually legitimate providers with working endpoints — they just need proper probe configuration.

We successfully did this for The Ark AI (commit e040b2f) — discovered it's a single endpoint at `arknode.ai/l402/task` with a task selector, registered it with the right probe body, and it came back healthy.

Now we have 5 more providers from Satring that appear to have working L402 endpoints but are showing degraded. Each needs investigation, probing, and correct registration.

## Providers to Investigate

### 1. AiProx — Agent Delegation (aiprox.dev)

**What we know from their Satring listing:**
- URL: `aiprox.dev/api/delegate`
- 120 sats/call
- "Agent-to-agent delegation. Accepts complex multi-part tasks, decomposes with AI, routes each to the best specialist agent, synthesizes results."
- Status: VERIFIED on Satring

**Research steps:**
```bash
# Check .well-known
curl -s https://aiprox.dev/.well-known/l402-services | head -100

# Probe the delegate endpoint (GET first, then POST)
curl -s -D - https://aiprox.dev/api/delegate 2>&1 | head -20
curl -s -D - -X POST -H "Content-Type: application/json" -d '{}' https://aiprox.dev/api/delegate 2>&1 | head -20
curl -s -D - -X POST -H "Content-Type: application/json" -d '{"task":"test"}' https://aiprox.dev/api/delegate 2>&1 | head -20

# Check their docs for API spec
curl -s https://aiprox.dev/docs.html | head -200
```

### 2. CertVera — Blockchain Document Timestamping (certvera.com)

**What we know from their docs (screenshots):**
- Single endpoint: `POST https://certvera.com/api/l402`
- Uses an `action` field to select the operation
- Actions:
  - `l402_timestamp` — Timestamp a SHA-256 hash on Bitcoin (25,000+ sats)
  - `l402_timestamp` + `file_data` — Upload & timestamp a file (30,000+ sats)
  - `l402_timestamp_verify` — Verify a hash exists on blockchain (Free)
  - `l402_timestamp_status` — Check timestamp status (Free)
  - `l402_timestamp_update` — Update webhook URL or email (10 sats)
- Request body for timestamp: `{"action": "l402_timestamp", "hash": "e3b0c44298fc1c149afbf4c8996fb924..."}`
- L402 flow documented: 402 → pay invoice → retry with `Authorization: L402 <macaroon>:<preimage>`

**Research steps:**
```bash
# Check .well-known
curl -s https://certvera.com/.well-known/l402-services | head -100

# Probe the single endpoint with the timestamp action (most likely to be L402-gated)
curl -s -D - -X POST -H "Content-Type: application/json" \
  -d '{"action":"l402_timestamp","hash":"e3b0c44298fc1c149afbf4c8996fb924e3b0c44298fc1c149afbf4c8996fb924"}' \
  https://certvera.com/api/l402 2>&1 | head -30

# Try the update action (cheapest paid one at 10 sats)
curl -s -D - -X POST -H "Content-Type: application/json" \
  -d '{"action":"l402_timestamp_update"}' \
  https://certvera.com/api/l402 2>&1 | head -30

# Try with empty body (might get 400)
curl -s -D - -X POST -H "Content-Type: application/json" -d '{}' \
  https://certvera.com/api/l402 2>&1 | head -30

# Try the free endpoints — these might NOT be L402-gated
curl -s -D - -X POST -H "Content-Type: application/json" \
  -d '{"action":"l402_timestamp_verify","hash":"e3b0c44298fc1c149afbf4c8996fb924e3b0c44298fc1c149afbf4c8996fb924"}' \
  https://certvera.com/api/l402 2>&1 | head -30
```

**This is likely a single-endpoint model (like Ark AI) where the `action` field determines the operation.** Some actions are free (verify, status) and some are L402-gated (timestamp, update). Register as one service if it's one URL.

### 3. IsItARug — Solana Token Safety Scanner (isitarug.com)

**What we know from their Satring listing + website:**
- URL from Satring: `isitarug.com/api/analyze`
- 50 sats/call (Satring listing says 50, website says ~12 sats per scan)
- "Solana token safety scanner. AI-powered rug pull detection, liquidity lock analysis, holder distribution, and contract risk scoring."
- Website shows: paste a token contract address, pay via Lightning, get AI risk report
- Status: PENDING on Satring but listed as ACTIVE

**Research steps:**
```bash
# Check .well-known
curl -s https://isitarug.com/.well-known/l402-services | head -100

# Probe the analyze endpoint
curl -s -D - -X POST -H "Content-Type: application/json" -d '{}' https://isitarug.com/api/analyze 2>&1 | head -30
curl -s -D - -X POST -H "Content-Type: application/json" \
  -d '{"address":"So11111111111111111111111111111111111111112"}' \
  https://isitarug.com/api/analyze 2>&1 | head -30
curl -s -D - https://isitarug.com/api/analyze 2>&1 | head -30

# Try with a GET
curl -s -D - "https://isitarug.com/api/analyze?address=So11111111111111111111111111111111111111112" 2>&1 | head -30
```

### 4. LightningProx — Pay-per-use AI Inference (lightningprox.com)

**What we know from their Satring listing + docs:**
- URL from Satring: `lightningprox.com/v1/messages` (truncated in listing)
- 30 sats/call
- "Pay-per-use AI inference via Bitcoin Lightning. Any Lightning wallet. Pay in sats per request."
- Status: VERIFIED on Satring
- Docs show an Anthropic-compatible API:
  - `POST https://lightningprox.com/v1/messages` with body `{"model":"claude-sonnet-4-20250514","max_tokens":100,"messages":[{"role":"user","content":"test"}]}`
  - Returns 402 with `payment_required` error and Lightning invoice in body
  - **This might NOT be standard L402 (WWW-Authenticate header).** Their flow uses a top-up model with spend tokens, not a per-request L402 challenge. Need to verify.
- Also has a top-up endpoint: `POST /v1/topup` with `{"amount_sats":500,"duration_hours":72}`

**Research steps:**
```bash
# Check .well-known
curl -s https://lightningprox.com/.well-known/l402-services | head -100

# Probe the messages endpoint
curl -s -D - -X POST -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":100,"messages":[{"role":"user","content":"test"}]}' \
  https://lightningprox.com/v1/messages 2>&1 | head -30

# Check if it returns WWW-Authenticate header (standard L402) or just JSON body with invoice
curl -s -D - -X POST -H "Content-Type: application/json" -d '{}' \
  https://lightningprox.com/v1/messages 2>&1 | head -30

# Probe the topup endpoint (this is the payment entry point)
curl -s -D - -X POST -H "Content-Type: application/json" \
  -d '{"amount_sats":500,"duration_hours":72}' \
  https://lightningprox.com/v1/topup 2>&1 | head -30
```

**Critical question:** Does LightningProx use standard L402 (`WWW-Authenticate: L402 macaroon="...", invoice="..."`) or a custom payment flow (JSON body with invoice)? If it's custom, it may show as 402 but without the L402 header, and our health checker would classify it as degraded. Document exactly what headers come back.

### 5. 1pxpoly / lpxpoly — Polymarket Intelligence (lpxpoly.com / trader.lpxpoly.com)

**What we know from Satring listing + website:**
- URL from Satring: `trader.lpxpoly.com/v1/signals` (truncated)
- 30 sats/call
- "Autonomous Polymarket trading bot. Paid AI signal feed + skip feed API."
- Status: PENDING on Satring but ACTIVE
- Website shows "Prediction Market Intelligence" with analysis tiers:
  - Quick Scan (~10 sats)
  - Deep Analysis (~25 sats)
  - GPT-4o (~20 sats)
- "Powered by LightningProx" — likely same payment infrastructure as #4

**Research steps:**
```bash
# Check .well-known
curl -s https://lpxpoly.com/.well-known/l402-services | head -100
curl -s https://trader.lpxpoly.com/.well-known/l402-services | head -100

# Probe the signals endpoint
curl -s -D - -X POST -H "Content-Type: application/json" -d '{}' \
  https://trader.lpxpoly.com/v1/signals 2>&1 | head -30
curl -s -D - https://trader.lpxpoly.com/v1/signals 2>&1 | head -30

# Try the analysis endpoint (website suggests /v1/analyze or similar)
curl -s -D - -X POST -H "Content-Type: application/json" \
  -d '{"slug":"will-trump-nominate-kevin-warsh-as-the-next-fed-chair","depth":"quick"}' \
  https://trader.lpxpoly.com/v1/signals 2>&1 | head -30
```

**Note:** Since this is "powered by LightningProx", it likely has the same payment flow. If LightningProx doesn't use standard L402 headers, this probably won't either.

### Also investigate: satsforai (satsforai.com)

**From the Satring listing:**
- URL: `satsforai.com/v1/messages`
- 10 sats/call
- "AI inference via Bitcoin Lightning micropayments. Pay per message in sats."
- Status: PENDING on Satring but ACTIVE
- **Note:** This is NOT the same as Sats4AI (sats4ai.com) — different provider.

```bash
curl -s -D - -X POST -H "Content-Type: application/json" \
  -d '{"model":"test","messages":[{"role":"user","content":"test"}]}' \
  https://satsforai.com/v1/messages 2>&1 | head -30
```

## Implementation

### Create `scripts/register-provider-batch.mjs`

Similar pattern to `register-arkai.mjs` and `register-sats4ai.mjs`:

1. Connect to SQLite (`process.env.DB_PATH || '/data/402index.db'`)
2. For each provider where research confirms valid L402 (402 + WWW-Authenticate with L402/LSAT scheme + macaroon + invoice):
   - Upsert into services table
   - Use correct `http_method`, `probe_body`, `provider`, `source: 'discovery'`
   - Match/update existing Satring entries by URL (they may already exist with wrong config)
3. For providers that return 402 but WITHOUT standard L402 headers (e.g., LightningProx-style custom payment):
   - Document the finding but DO NOT register — our health checker will classify them as degraded since they lack `WWW-Authenticate: L402`
   - Log a note about what they return instead
4. Print summary per provider: found endpoints, registered, skipped, errors

### Existing record handling

These providers likely already exist via Satring import. Check for existing records:

```javascript
const existing = db.prepare(
  "SELECT id, url, name, http_method, probe_body, health_status FROM services WHERE url LIKE ? AND protocol = 'L402'"
).all(`%${domain}%`)
```

If they exist, UPDATE them with correct `http_method` and `probe_body` rather than inserting duplicates. The `ON CONFLICT(url, protocol) DO UPDATE` handles this automatically.

## Commit

```bash
git add scripts/register-provider-batch.mjs
git commit -m "Add batch provider discovery for AiProx, CertVera, IsItARug, LightningProx, lpxpoly, satsforai"
git push origin master
```

## Do NOT do these things

- Do not modify the health checker, aggregators, or web UI
- Do not run the script against production — Ryan will do that via `railway ssh`
- Do not guess endpoints — probe them first and only register confirmed L402-compliant ones
- Do not register endpoints that return 402 without a valid `WWW-Authenticate: L402` header — these use custom payment flows, not L402
- Do not register free endpoints that return 200 (CertVera's verify and status actions)

## Self-Landing

When finished, self-land per ~/agent-state/CLAUDE.md:
- Journal with descriptor (e.g., `journals/2026-03-06-provider-batch-discovery.md`)
- Update continuation.md with pending manual action
- Append to status.md Recent Log
- `git add . && git commit && git push` the agent-state repo
- Never use bare `YYYY-MM-DD.md` for journal filenames. Never modify status.md top-level fields.

## Definition of Done

- All 6 providers (AiProx, CertVera, IsItARug, LightningProx, lpxpoly, satsforai) probed and documented
- Clear documentation of which are standard L402 vs custom payment flows
- Registration script written for confirmed L402 endpoints
- Tested locally
- Committed and pushed to master
- Agent-state landed
