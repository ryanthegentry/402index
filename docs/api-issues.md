# API Issues — Found via Integration Testing

**Date:** 2026-02-27
**Test script:** `test/api-integration.test.js` (57 tests, all pass against production)

---

## Fixed

### ~~1. `sort` param documented but not implemented~~ → FIXED
### ~~2. `order` param documented but not implemented~~ → FIXED
- Implemented in `src/routes/api.js`. Supports `sort=name|price|latency|uptime` with `order=asc|desc`.
- Featured services always sort first. Invalid sort values fall back to default order.

---

## Medium — Undocumented Behavior

### 3. `payment_asset` filter works but is undocumented
- **Reality:** `?payment_asset=USDC` returns 683 services, works perfectly.
- **Docs:** Not listed in the parameter table at `/api-docs`.
- **Impact:** Agents don't know this useful filter exists.
- **Fix:** Add one row to the params table in `src/views/api-docs.js`.

### 4. `limit=0` silently becomes 50 instead of clamping to 1
- **Code:** `parseInt('0') || 50` → 0 is falsy → defaults to 50
- **Expected:** Should clamp to 1 (minimum) like `limit=-1` does
- **Impact:** Minor. A consumer requesting `limit=0` gets 50 results instead of 0 or 1.
- **Fix:** Change to `parseInt(rawLimit) ?? 50` or explicit check: `const parsed = parseInt(rawLimit); const limit = Math.min(Math.max(Number.isNaN(parsed) ? 50 : parsed, 1), 200)`

### 5. `max_price_usd=abc` returns 0 results (NaN comparison)
- **Code:** `parseFloat('abc')` → `NaN`, passed to SQLite as `price_usd <= NaN`
- **Reality:** SQLite treats `NaN` comparison as always false → 0 results, no crash
- **Impact:** Not a crash, but returns empty results instead of ignoring the invalid param
- **Fix:** Guard with `if (max_price_usd && !isNaN(parseFloat(max_price_usd)))` before adding the condition

### 6. Protocol docs say lowercase `l402` but DB stores uppercase `L402`
- **Docs example:** `?protocol=l402`
- **DB stores:** `L402`
- **Reality:** Works fine because SQL uses `COLLATE NOCASE` — both return 94 results
- **Impact:** No functional issue, but docs should match canonical casing for consistency
- **Fix:** Change docs example to `L402` to match DB values, or document case-insensitivity

---

## Low — Minor Inconsistencies

### 7. `featured=1` works on API but not on page route
- **API (`api.js` line 57):** `featured === 'true' || featured === '1'` — accepts both
- **Pages (`pages.js` line 52):** `featured === 'true'` — only accepts `true`
- **Impact:** Very minor. Page route is for browsers, not agents.
- **Fix:** Add `|| featured === '1'` to `pages.js` for consistency.

### 8. `/api/v1/categories` `total` field is misleading
- **Response:** `{ categories: {...}, total: 17 }`
- **Reality:** `total` is the number of unique category *strings* (including subcategory paths), not the number of top-level categories (9).
- **Impact:** Consumers may misinterpret `total` as "number of categories in the tree".
- **Fix:** Rename to `unique_paths` or add `top_level_count` field.

---

## Confirmed Working (No Issues)

- All health filters (`healthy`, `degraded`, `down`, `unknown`) ✅
- All source filters (`bazaar`, `exclusive`) ✅
- Category prefix matching ✅
- Pagination (limit/offset, no overlap between pages) ✅
- Limit clamping: `limit=-1` → 1, `limit=999` → 200, `limit=abc` → 50 ✅
- Offset floor: `offset=-10` → 0, `offset=abc` → 0 ✅
- Bogus filter values return 0 results (no crash) ✅
- XSS in query params: no crash, no injection in JSON ✅
- Large offset returns empty array with correct total ✅
- Service detail endpoint with health_checks ✅
- 404 handling for missing services (API and page) ✅
- Health endpoint: all breakdowns sum to total ✅
- Sync timestamps are valid ISO or null ✅
- All page routes return expected status codes ✅

---

## Recommended Priority

1. **Implement `sort` + `order`** — these are documented, agents will try to use them
2. **Document `payment_asset`** — one-line docs fix for a useful feature
3. **Fix `limit=0` edge case** — minor code fix
4. **Guard `max_price_usd` NaN** — defensive, prevents confusing empty results
5. Rest are nice-to-haves
