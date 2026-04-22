# Contributing to 402index

402index.io is a protocol-agnostic directory of paid APIs for AI agents. We aggregate services from multiple sources and welcome new listings — especially L402 (Lightning) APIs.

## Submitting a New Listing

### Option 1: YAML Pull Request (preferred)

1. Fork this repo
2. Create a new YAML file in `listings/` named after your service (e.g., `listings/my-api.yaml`)
3. Use this template:

```yaml
name: "My Lightning API"
description: "One-line description of what this API does"
url: "https://api.example.com/v1/resource"
protocol: "L402"          # L402 or x402
price_sats: 100           # Price per request in satoshis (for L402)
# price_usd: 0.001        # Price per request in USD (for x402)
payment_asset: "BTC/Lightning"
payment_network: "lightning"
category: "ai/ml"         # See categories below
provider: "Your Org Name"
```

4. Open a PR with the title: `Add listing: [Your Service Name]`

### Option 2: Submit via l402apps.com

Visit [l402apps.com](https://www.l402apps.com) and use the Submit button. Your listing will be automatically ingested into 402index on the next sync.

## Requirements

- **The URL must be a real, working endpoint.** We run automated health checks every 15 minutes.
- **L402 services must return HTTP 402** when accessed without a valid L402 token. This is how we verify the paywall is working.
- **x402 services must return HTTP 402** with a valid x402 payment challenge.
- **No duplicate URLs.** We dedup by URL + protocol. If your service is already listed (e.g., via Bazaar or Satring), your PR will update the existing entry.

## Categories

Use one of these categories (or propose a new one):

| Category | Description |
|----------|-------------|
| `ai/ml` | AI inference, LLMs, embeddings |
| `bitcoin` | Bitcoin, Lightning, on-chain data |
| `crypto/defi` | DeFi protocols, swaps, liquidity |
| `crypto/nft` | NFTs, ordinals, inscriptions |
| `crypto/prices` | Token prices, market data |
| `crypto/wallet` | Wallet services, balances |
| `crypto/payments` | Payment infrastructure |
| `identity` | Trust scores, reputation, verification |
| `real-time-data` | News, weather, market feeds |
| `social` | Messaging, social networks |
| `storage` | File storage, key-value stores |
| `tools` | General utilities, search, compute |
| `tools/moderation` | Content moderation, filtering |
| `tools/marketplace` | Job boards, task markets |

## What Happens After You Submit

1. Your PR is reviewed (usually within 24 hours)
2. Once merged, the listing appears on [402index.io](https://402index.io) immediately
3. Health checks begin within 15 minutes
4. If the endpoint responds with 402, it's marked **healthy**
5. If it doesn't respond correctly, it's marked **degraded** or **down**

## Featured Listings

Want your service featured (pinned to the top)? Open an issue or mention it in your PR. Featured listings must be healthy and actively maintained.

## Assertion Guardrail

This project has a structural check (`scripts/check-assertion-flips.sh`) that detects when an existing test assertion is modified — specifically, when an assertion is removed and a new one is added within the same diff hunk. This prevents accidental regression-cementing, where a test is silently changed to match buggy behavior instead of catching it.

### When you modify an existing test assertion

Add one of these keywords to your **commit message body** (not the subject line):

**`BEHAVIOR-CHANGE: <summary>`** — Use when the user-facing behavior is intentionally changing.

```
fix: add auth gate to admin dashboard

The admin page now requires authentication instead of being publicly
accessible.

BEHAVIOR-CHANGE: admin page now requires server-side auth gate
```

**`ASSERTION-REFACTOR: <summary>`** — Use for cosmetic changes that don't alter behavioral contracts (variable renames, switching assertion methods, reformatting).

```
refactor: use strictEqual in admin tests

ASSERTION-REFACTOR: switch assert.equal to assert.strictEqual for consistency
```

### What triggers the check

- A diff hunk in `test/**/*.test.js` that contains both a removed (`-`) and added (`+`) line matching common assertion methods (`assert.equal`, `assert.ok`, `assert.deepEqual`, `assert.strictEqual`, etc.)

### What does NOT trigger the check

- Adding new assertions (no removals in the same hunk)
- Deleting assertions without replacement
- Changes to non-test files (`src/`, `scripts/`, etc.)
- Modifications in separate hunks (a deletion in one hunk and an addition in a different hunk)

### If the check fires

The error message will show the exact file, hunk, and assertion pair that triggered the detection, along with instructions for adding the appropriate keyword.

## Dispatch Recovery

If a wrapper subshell gets stuck, the dispatch loop will auto-kill it via `check_timeouts()` (per-stage thresholds in `MAX_SESSION_MINUTES_*` env vars). No manual action required.

If the dispatch loop itself becomes unresponsive (rare):

1. Find the loop PID: `pgrep -f 'cc-dispatch.sh --watch'`
2. Send SIGTERM to trigger the global shutdown trap: `kill <pid>`
3. The global trap kills all background wrappers via `kill $(jobs -rp)`. Each wrapper's EXIT trap then kills its `claude` child and cleans state.
4. If wrappers don't exit within ~15s: `pkill -9 -f 'cc-dispatch.sh'` and `pkill -9 -f 'claude --print'` as a last resort, then manually `gh issue edit --remove-label in-progress` on any issues left in-progress.

A standalone `scripts/cc-dispatch-killstuck.sh` operator script is **deferred** as a follow-up. Defects 1+2 should make manual intervention rare; the script is justified only if production observation shows it's needed.

## Questions?

Open an issue on this repo or email hello@402index.io.
