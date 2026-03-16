# CC Prompt: .well-known Auto-Discovery in Registration Endpoint

## Context

402index.io has a self-registration endpoint (`POST /api/v1/register`) where providers submit their L402 endpoints. The endpoint probes the URL with `verifyL402()` to confirm it returns 402 + valid L402 challenge before accepting the registration.

**Problem:** Many L402 providers validate the request body before issuing an L402 challenge. If you POST with `{}` to an endpoint that requires `{"prompt": "..."}`, you get 400 or 406 — not 402. The registration fails with "L402 verification failed" and the provider gets a confusing error message.

We've solved this manually for Sats4AI and Lightning Faucet by adding a `probe_body` column and hardcoding per-endpoint probe payloads. But this doesn't scale — every new body-validating provider needs manual intervention.

**Solution:** An emerging convention — `.well-known/l402-services` — solves this. Sats4AI already publishes one at `https://sats4ai.com/.well-known/l402-services`. It's a JSON document listing every endpoint with its method, content type, required request schema, and pricing. We can use this to auto-discover the correct probe configuration when a naive probe fails.

## What .well-known/l402-services Looks Like

Real example from Sats4AI (the only known implementation so far):

```json
{
  "version": "0.1.0",
  "services": [
    {
      "endpoint": "/api/l402/text-generation",
      "method": "POST",
      "content_type": "application/json",
      "description": "Generate text responses...",
      "pricing": { "base_cost_sats": 21 },
      "request_schema": {
        "input": { "type": "array", "description": "Chat messages...", "required": true },
        "model": { "type": "string", "description": "Model tier...", "required": true }
      }
    },
    ...
  ]
}
```

Key fields we care about:
- `endpoint` — relative path (e.g., `/api/l402/text-generation`)
- `method` — HTTP method (`POST`, `GET`)
- `content_type` — usually `application/json`
- `request_schema` — field names, types, and whether they're required

## Goal

When a provider registers an endpoint and the initial verification probe returns 400 or 406, automatically check `https://{host}/.well-known/l402-services` for probe configuration. If found, construct a minimal probe body from the schema, retry verification, and auto-populate `http_method` and `probe_body` on success.

This should be **transparent to the registering provider** — they just submit their URL and it works, even if their endpoint validates bodies.

## Architecture

The change is entirely in the registration flow. The health checker already supports `probe_body` and `http_method` — no changes needed there.

### Flow (modified registration endpoint)

```
Provider submits POST /api/v1/register with { url, name, protocol }
  │
  ├─ verifyL402(url, httpMethod, probeBody)
  │   └─ Returns 402? → SUCCESS (existing flow, no change)
  │
  ├─ Returns 400 or 406? → NEW: try .well-known discovery
  │   │
  │   ├─ Fetch https://{host}/.well-known/l402-services
  │   │   └─ Timeout after 5 seconds. 404/error → fall through to normal failure
  │   │
  │   ├─ Parse JSON, find service entry matching the registered URL path
  │   │
  │   ├─ Extract method + build minimal probe body from request_schema
  │   │
  │   ├─ Retry verifyL402(url, discoveredMethod, constructedProbeBody)
  │   │   └─ Returns 402? → SUCCESS with auto-discovered config
  │   │
  │   └─ Still fails? → Return normal verification failure
  │
  └─ Any other status? → Return normal verification failure (existing flow)
```

## Implementation

### New file: `src/services/wellknown-discovery.js`

This module does three things:
1. Fetches and parses a host's `.well-known/l402-services`
2. Finds the service entry matching a given URL
3. Constructs a minimal probe body from the schema

```javascript
import { isBlockedScheme, resolveAndCheck } from '../health/checker.js'

const WELLKNOWN_TIMEOUT_MS = 5000

/**
 * Attempt to discover probe configuration for a URL from its host's
 * .well-known/l402-services document.
 *
 * @param {string} url - The endpoint URL to look up
 * @returns {Promise<{ method: string, probeBody: string } | null>}
 *   Returns discovered config, or null if not available.
 */
export async function discoverProbeConfig(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  const wellKnownUrl = `${parsed.protocol}//${parsed.host}/.well-known/l402-services`

  // SSRF protection — same checks as verifyL402
  if (isBlockedScheme(wellKnownUrl)) return null
  const blockReason = await resolveAndCheck(wellKnownUrl)
  if (blockReason) return null

  let doc
  try {
    const res = await fetch(wellKnownUrl, {
      signal: AbortSignal.timeout(WELLKNOWN_TIMEOUT_MS),
      headers: { 'Accept': 'application/json' },
    })
    if (!res.ok) return null // 404, 500, etc. — host doesn't publish .well-known
    doc = await res.json()
  } catch {
    return null // timeout, parse error, network error — all non-fatal
  }

  if (!doc || !Array.isArray(doc.services)) return null

  // Match by path — the .well-known lists relative paths, the registered URL is absolute
  const targetPath = parsed.pathname
  const entry = doc.services.find(svc => {
    if (!svc.endpoint) return false
    // Normalize: ensure both have leading slash, strip trailing slash
    const entryPath = svc.endpoint.startsWith('/') ? svc.endpoint : '/' + svc.endpoint
    return entryPath.replace(/\/$/, '') === targetPath.replace(/\/$/, '')
  })

  if (!entry) return null

  const method = (entry.method || 'GET').toUpperCase()
  const probeBody = buildMinimalProbeBody(entry.request_schema)

  return { method, probeBody }
}

/**
 * Construct a minimal JSON body from a .well-known request_schema.
 * Uses dummy values that satisfy type constraints without triggering
 * real processing (keeping probe costs at zero).
 *
 * @param {object|null} schema - The request_schema from .well-known
 * @returns {string} JSON string for probe body. Returns '{}' if no schema.
 */
export function buildMinimalProbeBody(schema) {
  if (!schema || typeof schema !== 'object') return '{}'

  const body = {}
  for (const [field, spec] of Object.entries(schema)) {
    // Only include required fields — optional fields might trigger unwanted behavior
    if (spec.required !== true) continue

    // Generate minimal dummy value based on type
    switch (spec.type) {
      case 'string':
        body[field] = 'test'
        break
      case 'number':
      case 'integer':
        body[field] = 1
        break
      case 'boolean':
        body[field] = true
        break
      case 'array':
        // For chat-style arrays, provide a minimal message
        if (field === 'input' || field === 'messages') {
          body[field] = [{ role: 'user', content: 'test' }]
        } else {
          body[field] = ['test']
        }
        break
      case 'object':
        body[field] = {}
        break
      default:
        body[field] = 'test'
    }
  }

  return JSON.stringify(body)
}
```

**Important design decisions:**

1. **Only required fields.** Including optional fields risks triggering real work (image generation, API calls to third parties). Required fields are the minimum to get past body validation to the L402 challenge.

2. **Dummy values, not real data.** `"test"` strings, `1` numbers. The goal is to trigger 402, not to get a real response. Most providers validate body structure first, then check payment, then process. We only need to pass step 1.

3. **Graceful degradation everywhere.** If `.well-known` doesn't exist, returns malformed JSON, doesn't list the endpoint, or the constructed body still doesn't work — we fall through to the normal verification failure. Zero risk of breaking existing behavior.

4. **SSRF protection.** The `.well-known` fetch goes through the same `resolveAndCheck` as the verification probe itself. No new attack surface.

### Modify: `src/routes/api.js` — registration endpoint

**Current code reference (commit ba56f52):**
- Line 266: `const httpMethod = ...` — change to `let` so discovery can override it
- Line 274: `let probeBody = '{}'` — already `let`, can be overridden
- Line 288: `const probe = await verifyL402(url, httpMethod, probeBody)` — change to `let`
- Line 289-300: Existing failure response block — replace with retry logic
- Line 318: `probe_body: probeBody !== '{}' ? probeBody : null` — already uses the local `probeBody` variable, so overriding it above will flow through automatically

Add the import at the top of the file (with the other service imports):

```javascript
import { discoverProbeConfig } from '../services/wellknown-discovery.js'
```

Replace the existing verification + failure block (lines 287-301) with:

```javascript
    // Run L402 verification probe
    let probe = await verifyL402(url, httpMethod, probeBody)

    // If probe failed with 400 or 406, try .well-known auto-discovery
    let discoveredConfig = null
    if (!probe.valid && [400, 406].includes(probe.httpStatus)) {
      discoveredConfig = await discoverProbeConfig(url)
      if (discoveredConfig) {
        console.log(`[register] .well-known discovery found config for ${url}: method=${discoveredConfig.method}, body=${discoveredConfig.probeBody.substring(0, 100)}`)
        probe = await verifyL402(url, discoveredConfig.method, discoveredConfig.probeBody)
      }
    }

    if (!probe.valid) {
      const response = {
        error: 'L402 verification failed',
        detail: probe.error,
        probe: {
          httpStatus: probe.httpStatus,
          hasWwwAuthenticate: probe.hasWwwAuthenticate,
          scheme: probe.scheme,
          hasMacaroon: probe.hasMacaroon,
          hasInvoice: probe.hasInvoice,
        },
      }
      // If we tried .well-known and it still failed, tell the provider
      if (discoveredConfig) {
        response.wellknown_attempted = true
        response.detail += ' (Also attempted .well-known auto-discovery — the constructed probe body did not trigger an L402 challenge. Try providing an explicit probe_body parameter.)'
      }
      return res.status(422).json(response)
    }

    // If discovery succeeded, use the discovered config for the stored record
    // (only if the user didn't explicitly provide them)
    if (discoveredConfig && probe.valid) {
      if (!body.http_method) {
        httpMethod = discoveredConfig.method
      }
      if (!body.probe_body) {
        probeBody = discoveredConfig.probeBody
      }
    }
```

**Required variable changes (earlier in the function):**
- Line 266: `const httpMethod` → `let httpMethod`
- Line 288: `const probe` → `let probe`

The existing `probeBody` on line 274 is already `let`. The existing `probe_body` storage on line 318 (`probe_body: probeBody !== '{}' ? probeBody : null`) already uses the local variable, so overriding `probeBody` above flows through to the INSERT automatically. Same for `httpMethod` on line 317.

### `src/services/l402-verify.js` — NO CHANGES NEEDED

The `probeBody` third parameter is already implemented (commit ba56f52). `verifyL402(url, httpMethod, probeBody)` already works. Do not modify this file.

### Modify: `src/views/api-docs.js`

Update the register endpoint documentation to mention auto-discovery:

After the `probe_body` row in the params table, add an info callout:

```html
<div class="info-callout" style="margin-top:16px">
  <h3>.well-known Auto-Discovery</h3>
  <p>If your endpoint returns 400 or 406 during verification and you haven't provided a
  <code>probe_body</code>, we'll check <code>https://your-host/.well-known/l402-services</code>
  for probe configuration. If your discovery document lists the endpoint with a
  <code>request_schema</code>, we'll construct a minimal probe body automatically.
  <a href="/about#wellknown">Learn more about .well-known discovery.</a></p>
</div>
```

### Modify: `src/views/about.js`

Add a brief section about `.well-known` auto-discovery in the methodology area (after the L402 methodology paragraph). Add an anchor for deep-linking:

```html
<h3 id="wellknown">.well-known Discovery</h3>
<p>Some L402 providers publish a discovery document at
<code>/.well-known/l402-services</code> that describes their endpoints, required
request schemas, and pricing. When a self-registration probe fails because the endpoint
validates request bodies, we check this document automatically and retry with the
correct configuration. This is an emerging convention — providers can publish one to
make their endpoints instantly discoverable and self-registrable.</p>
```

## Testing

### Unit tests for `wellknown-discovery.js`

**File:** `tests/wellknown-discovery.test.js`

1. **`buildMinimalProbeBody` — basic types:**
   - String field → `"test"`
   - Number field → `1`
   - Boolean field → `true`
   - Array field → `["test"]`
   - Chat-style array field (field named `input`) → `[{"role":"user","content":"test"}]`
   - No schema → `'{}'`
   - Empty schema → `'{}'`
   - Only required fields included, optional fields skipped

2. **`buildMinimalProbeBody` — Sats4AI schema:**
   Pass the actual Sats4AI text-generation schema:
   ```javascript
   {
     input: { type: 'array', required: true, description: 'Chat messages' },
     model: { type: 'string', required: true, description: 'Model tier' }
   }
   ```
   Verify output: `{"input":[{"role":"user","content":"test"}],"model":"test"}`

3. **`discoverProbeConfig` — happy path (mock fetch):**
   Mock `fetch` to return a valid `.well-known` document with two services.
   Call `discoverProbeConfig('https://example.com/api/l402/text')`.
   Verify it returns `{ method: 'POST', probeBody: '...' }` matching the entry for `/api/l402/text`.

4. **`discoverProbeConfig` — endpoint not in document:**
   Mock fetch to return a valid doc that doesn't list the target endpoint.
   Verify it returns `null`.

5. **`discoverProbeConfig` — .well-known returns 404:**
   Mock fetch to return 404. Verify returns `null` (graceful degradation).

6. **`discoverProbeConfig` — .well-known returns malformed JSON:**
   Mock fetch to return `{garbage`. Verify returns `null`.

7. **`discoverProbeConfig` — .well-known times out:**
   Mock fetch to throw a timeout error. Verify returns `null`.

8. **`discoverProbeConfig` — SSRF blocked (private IP):**
   Mock `resolveAndCheck` to return a block reason for private IPs.
   Call with `https://192.168.1.1/api/l402/text`. Verify returns `null`.

### Integration tests for register endpoint

**File:** Add to `tests/api.test.js` or `tests/register.test.js`

9. **Auto-discovery success flow:**
   - Mock `verifyL402` to return `{ valid: false, httpStatus: 400, ... }` on first call
   - Mock `discoverProbeConfig` to return `{ method: 'POST', probeBody: '{"prompt":"test"}' }`
   - Mock `verifyL402` to return `{ valid: true, ... }` on second call
   - POST to `/api/v1/register` with just `{ url, name, protocol }`
   - Verify 201 response
   - Verify the stored service has `http_method: 'POST'` and `probe_body: '{"prompt":"test"}'`

10. **Auto-discovery failure (still returns 422):**
    - Mock `verifyL402` to return 400 on both calls
    - Mock `discoverProbeConfig` to return a config
    - Verify 422 response includes `wellknown_attempted: true`

11. **No auto-discovery on non-400/406 status:**
    - Mock `verifyL402` to return 500
    - Verify `discoverProbeConfig` is NOT called

12. **User-provided probe_body preserved in stored record even when discovery fires:**
    - POST with explicit `{ probe_body: '{"custom":"body"}', http_method: 'POST' }`
    - Mock `verifyL402` to return 400 on first call (user's body was wrong)
    - Mock `discoverProbeConfig` to return `{ method: 'POST', probeBody: '{"discovered":"body"}' }`
    - Mock `verifyL402` to return valid on second call (discovery body works)
    - Verify 201 response
    - Verify stored record has user's original `http_method: 'POST'` (since `body.http_method` was provided)
    - Verify stored record has *discovered* `probe_body` (since the `!body.probe_body` check fails, but actually — the user DID provide `probe_body`). So the stored `probeBody` variable should NOT be overridden. Verify stored record has the user's original `probe_body: '{"custom":"body"}'`
    - This tests the "user knows what they want but it's wrong" edge case — discovery fixes the probe but the stored body preserves user intent

Run full test suite after all changes: `npm test`

## Commit

Single commit:

```
git add -A
git commit -m "Auto-discover probe config from .well-known/l402-services on registration 400/406"
git push origin master
```

## Do NOT do these things

- Do not build a `.well-known` aggregator or crawler — this is registration-time only
- Do not modify the health checker to use `.well-known` — it already has `probe_body` per service
- Do not change the Sats4AI or Lightning Faucet registration scripts
- Do not modify existing test fixtures or mock data for other tests
- Do not add `.well-known` fetching to the Satring or Bazaar aggregators
- Do not cache `.well-known` documents — each registration is a one-time lookup
- Do not follow redirects on the `.well-known` fetch — if it's not at the canonical URL, skip it
- Do not make this blocking on the existing probe_body parameter — if the user provides `probe_body` explicitly, it should still work exactly as before

## Self-Landing

When finished, self-land per ~/agent-state/CLAUDE.md:
- Journal with descriptor (e.g., `journals/2026-03-XX-wellknown-autodiscovery.md`)
- Update continuation.md
- Append to status.md Recent Log
- `git add . && git commit && git push` the agent-state repo
- Never use bare `YYYY-MM-DD.md` for journal filenames. Never modify status.md top-level fields.

## Definition of Done

- New `src/services/wellknown-discovery.js` module with `discoverProbeConfig()` and `buildMinimalProbeBody()`
- Registration endpoint retries with discovered config on 400/406
- `verifyL402` accepts `probeBody` parameter (if not already applied from polish prompt)
- Discovered `http_method` and `probe_body` auto-populated in stored service record
- API docs and About page mention .well-known auto-discovery
- 422 error response includes `wellknown_attempted` flag when discovery was tried
- All new unit and integration tests pass
- Full test suite passes (`npm test`)
- Committed and pushed to master
