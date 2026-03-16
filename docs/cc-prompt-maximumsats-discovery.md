# CC Prompt: MaximumSats — L402 Endpoint Discovery & Registration (49 Endpoints)

## Context

402index.io is a registry of L402/x402 paid API endpoints. MaximumSats (maximumsats.com) is a large L402 provider with 49 individual endpoints listed in their `/api/catalog` JSON. They also have an MCP server at `maximumsats.com/mcp` and a Lightning node at `klabo.world`.

These are **individual endpoint URLs** (like Sats4AI/Lightning Faucet), NOT a single-endpoint model (like Ark AI). Each tool has its own URL path.

Some MaximumSats endpoints may already exist in our database via Satring or L402Apps aggregation. The script must handle upserts via `ON CONFLICT(url, protocol) DO UPDATE`.

We successfully registered Sats4AI (10 endpoints, commit with `register-sats4ai.mjs`) and The Ark AI (1 endpoint, commit e040b2f with `register-arkai.mjs`) using the same pattern.

## The Catalog (Source of Truth)

MaximumSats exposes a full catalog at `GET https://maximumsats.com/api/catalog`. Here is the complete list of 49 endpoints from that response:

### AI & ML (5 endpoints)
| Name | URL | Price (sats) | Description |
|------|-----|-------------|-------------|
| AI DVM | /api/ai-dvm | 100 | Submit AI inference tasks via a Nostr DVM-compatible API |
| Web of Trust Report | /api/wot-report | 50 | Generate a Web of Trust analysis report for a Nostr pubkey |
| Nostr Note Summarizer | /api/nostr-summary | 25 | Summarize a Nostr note or thread |
| Lightning Network Analysis | /api/ln-analysis | 50 | Analyze a Lightning Network node's connectivity and routing |
| Generate Image | /api/generate-image | 100 | Generate an image from a text prompt |

### BOLT11 Invoice Tools (16 endpoints)
| Name | URL | Price (sats) | Description |
|------|-----|-------------|-------------|
| Decode BOLT11 Invoice | /api/decode-bolt11 | 4 | Decode a BOLT11 Lightning invoice |
| Get Invoice Amount | /api/invoice-amount | 4 | Extract payment amount from invoice |
| Get Invoice Expiry | /api/invoice-expiry | 4 | Get expiration time of invoice |
| Get Invoice Destination | /api/invoice-destination | 4 | Extract destination node pubkey |
| Get Payment Hash | /api/payment-hash | 4 | Extract payment hash from invoice |
| Get Invoice Description | /api/invoice-description | 4 | Extract description/memo from invoice |
| Get Invoice Timestamp | /api/invoice-timestamp | 4 | Get creation timestamp of invoice |
| Get Invoice Route Hints | /api/invoice-route-hints | 4 | Extract routing hints from invoice |
| Get Invoice Features | /api/invoice-features | 4 | Extract feature bits from invoice |
| Get Invoice Min Final CLTV | /api/invoice-min-cltv | 4 | Get minimum final CLTV expiry delta |
| Get Invoice Network | /api/invoice-network | 4 | Determine the network (mainnet/testnet) |
| Validate BOLT11 Signature | /api/validate-bolt11 | 4 | Validate the cryptographic signature |
| Compare BOLT11 Invoices | /api/compare-bolt11 | 8 | Compare two BOLT11 invoices |
| Estimate BOLT11 Route Cost | /api/estimate-route-cost | 8 | Estimate routing cost for paying an invoice |
| Create BOLT11 Summary | /api/bolt11-summary | 8 | Create a human-readable invoice summary |
| Bulk Decode BOLT11 | /api/bulk-decode-bolt11 | 21 | Decode multiple BOLT11 invoices at once |

### Nostr Encoding/Decoding (7 endpoints)
| Name | URL | Price (sats) | Description |
|------|-----|-------------|-------------|
| Decode npub | /api/decode-npub | 4 | Decode a Nostr npub to hex pubkey |
| Decode nprofile | /api/decode-nprofile | 4 | Decode a Nostr nprofile |
| Decode nevent | /api/decode-nevent | 4 | Decode a Nostr nevent |
| Decode naddr | /api/decode-naddr | 4 | Decode a Nostr naddr |
| Decode nrelay | /api/decode-nrelay | 4 | Decode a Nostr nrelay URL |
| Decode note | /api/decode-note | 4 | Decode a Nostr note ID to hex |
| Encode to npub | /api/encode-npub | 4 | Encode a hex pubkey to npub format |

### Lightning Utilities (3 endpoints)
| Name | URL | Price (sats) | Description |
|------|-----|-------------|-------------|
| Decode LNURL | /api/decode-lnurl | 4 | Decode a bech32-encoded LNURL |
| Resolve Lightning Address | /api/resolve-ln-address | 8 | Resolve a Lightning Address to LNURL pay endpoint |
| Validate Lightning Address | /api/validate-ln-address | 4 | Validate a Lightning Address format |

### Bitcoin Utilities (4 endpoints)
| Name | URL | Price (sats) | Description |
|------|-----|-------------|-------------|
| Parse BIP21 URI | /api/parse-bip21 | 4 | Parse a BIP21 Bitcoin payment URI |
| Create BIP21 URI | /api/create-bip21 | 4 | Create a BIP21 Bitcoin payment URI |
| Validate Bitcoin Address | /api/validate-btc-address | 4 | Validate a Bitcoin address |
| Estimate Bitcoin Fees | /api/estimate-fees | 8 | Get current Bitcoin network fee estimates |

### L402 Debugging (6 endpoints)
| Name | URL | Price (sats) | Description |
|------|-----|-------------|-------------|
| Parse L402 Challenge | /api/parse-l402-challenge | 4 | Parse a WWW-Authenticate L402 challenge header |
| Verify L402 Preimage Hash | /api/verify-l402-hash | 4 | Verify a preimage matches a payment hash |
| Build L402 Auth Header | /api/build-l402-auth | 4 | Build an L402 Authorization header |
| Diagnose L402 Auth | /api/diagnose-l402-auth | 8 | Diagnose issues with an L402 Authorization header |
| Extract L402 Macaroon | /api/extract-l402-macaroon | 4 | Extract and decode the macaroon from L402 auth |
| L402 Proof Replay Check | /api/l402-proof-replay | 8 | Check if an L402 proof can be replayed |

### Content & Metadata (8 endpoints)
| Name | URL | Price (sats) | Description |
|------|-----|-------------|-------------|
| Nostr Metadata Lookup | /api/nostr-metadata | 8 | Look up metadata for a Nostr pubkey |
| Lightning Node Info | /api/ln-node-info | 8 | Get information about a Lightning Network node |
| Validate Nostr Event | /api/validate-nostr-event | 4 | Validate a Nostr event's structure and signature |
| Extract Nostr Tags | /api/extract-nostr-tags | 4 | Extract and categorize tags from a Nostr event |
| Format Nostr Event | /api/format-nostr-event | 4 | Format a Nostr event for human-readable display |
| Check Nostr Relay | /api/check-nostr-relay | 8 | Check the status and capabilities of a Nostr relay |
| Nostr Event Search | /api/nostr-event-search | 8 | Search for Nostr events matching criteria |
| Nostr Profile Summary | /api/nostr-profile-summary | 21 | Generate a summary of a Nostr profile |

## Research Phase (Do This First)

### Step 1: Verify the catalog

```bash
# Fetch the live catalog
curl -s https://maximumsats.com/api/catalog | node -e "
  const chunks = [];
  process.stdin.on('data', c => chunks.push(c));
  process.stdin.on('end', () => {
    const data = JSON.parse(Buffer.concat(chunks).toString());
    console.log('Total endpoints:', data.endpoints?.length || 'unknown');
    console.log('Sample:', JSON.stringify(data.endpoints?.[0], null, 2));
  });
"
```

### Step 2: Check .well-known

```bash
curl -s https://maximumsats.com/.well-known/l402-services | head -200
```

### Step 3: Probe a sample of endpoints (cheapest first)

All endpoints are POST and use the base URL `https://maximumsats.com`. Probe a representative sample across categories to confirm the L402 pattern is consistent:

```bash
# BOLT11 tool (4 sats) — needs a BOLT11 invoice string
curl -s -D - -X POST -H "Content-Type: application/json" \
  -d '{"invoice":"lnbc1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq8rkx3yf5tcsyz3d73gafnh3cax9rn449d9p5uxz9ezhhypd0elx87sjle52x86fux2ypatgddc6k63n7erqz25le42c4u4ecky03ylcqca784w"}' \
  https://maximumsats.com/api/decode-bolt11 2>&1 | head -30

# Nostr decode (4 sats) — needs an npub
curl -s -D - -X POST -H "Content-Type: application/json" \
  -d '{"npub":"npub1placeholder000000000000000000000000000000000000000000000000"}' \
  https://maximumsats.com/api/decode-npub 2>&1 | head -30

# Bitcoin utility (4 sats) — needs a Bitcoin address
curl -s -D - -X POST -H "Content-Type: application/json" \
  -d '{"address":"bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"}' \
  https://maximumsats.com/api/validate-btc-address 2>&1 | head -30

# L402 debugging (4 sats)
curl -s -D - -X POST -H "Content-Type: application/json" \
  -d '{"challenge":"L402 macaroon=test invoice=lnbc1test"}' \
  https://maximumsats.com/api/parse-l402-challenge 2>&1 | head -30

# AI endpoint (100 sats)
curl -s -D - -X POST -H "Content-Type: application/json" \
  -d '{"prompt":"test"}' \
  https://maximumsats.com/api/generate-image 2>&1 | head -30

# Fee estimation (8 sats) — might not need a body
curl -s -D - -X POST -H "Content-Type: application/json" \
  -d '{}' \
  https://maximumsats.com/api/estimate-fees 2>&1 | head -30
```

For each probe, verify:
- HTTP 402 response
- `WWW-Authenticate` header present
- Scheme is `L402` or `LSAT`
- `macaroon=` field present
- `invoice=` field present with `lnbc` prefix

**Critical questions to answer from probing:**
1. Do all 49 endpoints return standard L402 challenges? Or do some return 200/400/other?
2. Do they validate the request body BEFORE issuing the 402 challenge? (i.e., does `{}` work, or do you need the correct fields?)
3. If body validation happens first, what's the minimal probe body per endpoint?

### Step 4: Determine probe bodies

If `{}` triggers 402 for all endpoints → no probe_body needed (health checker sends `{}` by default for POST).

If some endpoints return 400 with `{}` → determine the minimal body per endpoint. The catalog may include request schema info. Group endpoints by pattern:

**Likely probe body patterns (derive from endpoint names):**
- BOLT11 tools: `{"invoice":"lnbc1test"}` or similar
- Nostr decode: `{"npub":"test"}`, `{"nevent":"test"}`, etc.
- Bitcoin: `{"address":"test"}`, `{"uri":"test"}`
- L402 debug: `{"challenge":"test"}`, `{"header":"test"}`
- AI: `{"prompt":"test"}`
- Nostr metadata: `{"pubkey":"test"}`

If body validation occurs, probe each endpoint individually with the likely field name. If the field name isn't obvious, try `{}` first, then check the error message for hints about required fields.

### Step 5: Check for existing records

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || '/data/402index.db');
db.prepare(\"SELECT id, url, name, health_status, http_method, probe_body, source FROM services WHERE url LIKE '%maximumsats%' OR provider LIKE '%maximum%'\").all().forEach(r => console.log(JSON.stringify(r)));
db.close();
"
```

## Implementation

### Create `scripts/register-maximumsats.mjs`

Follow the same pattern as `scripts/register-sats4ai.mjs`:

1. Connect to SQLite (`process.env.DB_PATH || '/data/402index.db'`)
2. Define endpoint array based on CONFIRMED probing results:
   - Only include endpoints that returned valid 402 + L402 challenge
   - Include `probe_body` for any endpoint that needs a specific body to trigger 402
   - Set `probe_body: null` for endpoints where `{}` triggers 402
3. For each endpoint:
   - Upsert using `ON CONFLICT(url, protocol) DO UPDATE`
   - Preserve existing IDs (check for existing record first)
   - Fields:
     - `name`: "MaximumSats: {Tool Name}" (from catalog)
     - `description`: from catalog
     - `url`: `https://maximumsats.com{path}` (full URL)
     - `protocol`: 'L402'
     - `price_sats`: from catalog
     - `price_usd`: convert using `BTC_USD = 90000`
     - `payment_asset`: 'BTC'
     - `payment_network`: 'Lightning'
     - `category`: map from catalog category → our categories:
       - "AI & ML" → 'ai'
       - "BOLT11 Invoice Tools" → 'utility'
       - "Nostr Encoding/Decoding" → 'utility'
       - "Lightning Utilities" → 'utility'
       - "Bitcoin Utilities" → 'utility'
       - "L402 Debugging" → 'utility'
       - "Content & Metadata" → 'utility'
     - `provider`: 'MaximumSats'
     - `source`: 'discovery'
     - `http_method`: 'POST'
     - `probe_body`: per-endpoint if needed, null otherwise
     - `health_status`: 'unknown'
4. Print summary per category: inserted vs updated count
5. Print total MaximumSats services after registration

### Test locally

```bash
node scripts/register-maximumsats.mjs
```

Verify output shows correct upserts and no errors.

## Commit

```bash
git add scripts/register-maximumsats.mjs
git commit -m "Add MaximumSats registration script (49 L402 endpoints from /api/catalog)"
git push origin master
```

## Do NOT do these things

- Do not modify the health checker, aggregators, or web UI
- Do not run the script against production — Ryan will do that via `railway ssh`
- Do not guess probe bodies — probe endpoints first and only register confirmed L402-compliant ones
- Do not register endpoints that don't return valid L402 challenges (402 + WWW-Authenticate with L402/LSAT scheme + macaroon + invoice)
- Do not register any endpoints from the catalog that are actually free (200 response) — all 49 should be L402-gated based on the catalog, but verify

## Self-Landing

When finished, self-land per ~/agent-state/CLAUDE.md:
- Journal with descriptor (e.g., `journals/2026-03-06-maximumsats-discovery.md`)
- Update continuation.md with pending manual action
- Append to status.md Recent Log
- `git add . && git commit && git push` the agent-state repo
- Never use bare `YYYY-MM-DD.md` for journal filenames. Never modify status.md top-level fields.

## Definition of Done

- Representative sample of endpoints probed (at least 6 across different categories)
- L402 compliance confirmed or documented per endpoint
- Probe body requirements documented (does `{}` work, or are specific fields needed?)
- Registration script written for all confirmed L402 endpoints
- Tested locally
- Committed and pushed to master
- Agent-state landed
