# Domain Verification & Provider Listing Edits

## Problem

Providers want to edit metadata (category, description, price) on their listings. Currently no way to prove domain ownership or edit listings.

## Solution

HTTP file verification (same pattern as Google Search Console, ACME HTTP-01, Cloudflare DCV):

1. Provider claims a domain → gets a random token
2. Provider places token at `https://domain/.well-known/402index-verify.txt`
3. We fetch the file, confirm token matches → domain verified
4. Verified providers can PATCH any listing under their domain

## Data Model

```sql
CREATE TABLE IF NOT EXISTS domain_claims (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,
  verification_token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'verified', 'expired')),
  claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
  verified_at TEXT,
  expires_at TEXT NOT NULL,
  last_check_at TEXT,
  contact_email TEXT
);
```

## API Endpoints

### POST /api/v1/claim

Initiate a domain claim. Returns verification token and instructions.

- Input: `{ domain, contact_email? }`
- Domain must be hostname only (no protocol, path, port, IP)
- Pending claims get token regenerated (idempotent retry)
- Verified domains return 409

### POST /api/v1/claim/verify

Verify a pending claim by fetching the well-known file.

- Input: `{ domain }`
- Fetches `https://{domain}/.well-known/402index-verify.txt`
- SSRF protection via `resolveAndCheck()`
- No redirect following (`redirect: 'manual'`)
- HTTPS only, 5s timeout, 1KB max response
- Token comparison (trimmed whitespace)

### PATCH /api/v1/services/:id

Edit a listing by verified domain owner.

- Input: `{ domain, verification_token, ...fields }`
- Token is the ongoing credential (no sessions)
- Service URL hostname must match claimed domain
- Partial updates supported

## Security

1. **Token entropy**: `crypto.randomBytes(32).toString('hex')` — 256 bits
2. **SSRF protection**: Reuses `resolveAndCheck()` from health checker
3. **No redirect following**: Prevents cross-domain verification attacks
4. **HTTPS only**: Verification file always fetched over HTTPS
5. **72-hour expiration**: Pending claims auto-expire
6. **1KB response limit**: Prevents memory bombs
7. **Domain-scoped edits**: PATCH only works for matching hostnames
