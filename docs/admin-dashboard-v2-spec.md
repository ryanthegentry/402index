# Admin Dashboard v2 — Spec

## Overview

Extend the 402index admin dashboard (`/admin`) with two new panels alongside the existing "Pending Review" panel:

1. **Recent Registrations** — all recently registered services, sorted newest-first, with delete
2. **Search & Delete** — search across all services (any status), results with delete

Auth is unchanged: all `/api/v1/admin/*` routes go through `adminAuth` middleware (Bearer token checked against `ADMIN_SECRET` env var).

---

## New API Endpoints

### `GET /api/v1/admin/recent`

Returns the N most recently registered services regardless of status.

**Query params:**
- `limit` — integer, default 20, max 100

**Response:**
```json
{
  "services": [
    {
      "id": "uuid",
      "name": "Ryan's Ollama",
      "url": "https://...",
      "status": "active",
      "protocol": "L402",
      "provider": "golem-gateway",
      "category": "ai/inference",
      "price_sats": 500,
      "payment_asset": "BTC",
      "payment_network": "Lightning",
      "contact_email": "...",
      "health_status": "healthy",
      "verified": 1,
      "registered_at": "2026-03-17T12:00:00"
    }
  ],
  "total": 20
}
```

**SQL:**
```sql
SELECT id, name, url, status, protocol, provider, category,
       price_sats, payment_asset, payment_network, contact_email,
       health_status, verified, registered_at
FROM services
ORDER BY registered_at DESC
LIMIT @limit
```

---

### `GET /api/v1/admin/search`

Search across all services (any status) by URL, name, provider, or category.

**Query params:**
- `q` — search string (required, min 1 char)
- `limit` — integer, default 20, max 100

**Response:** same shape as `/admin/recent`

**SQL:**
```sql
SELECT id, name, url, status, protocol, provider, category,
       price_sats, payment_asset, payment_network, contact_email,
       health_status, verified, registered_at
FROM services
WHERE name LIKE @q OR url LIKE @q OR provider LIKE @q OR category LIKE @q
ORDER BY registered_at DESC
LIMIT @limit
```

Where `@q = '%' + q + '%'`

---

### `DELETE /api/v1/admin/services/:id`

Hard-deletes a service record (any status).

**Auth:** `Authorization: Bearer <ADMIN_SECRET>` (enforced by `adminAuth` middleware upstream)

**Response 200:**
```json
{ "deleted": true, "id": "uuid" }
```

**Response 404:**
```json
{ "error": "No service with that ID" }
```

---

## UI Changes (admin.js view)

### Tab layout

Replace the current single-panel layout with a 3-tab layout inside `#dashboard`:

```
[ Pending (N) ]  [ Recent ]  [ Search ]
─────────────────────────────────────────
<panel content>
```

Tabs switch the visible panel; active tab has accent underline. Tab counts:
- "Pending (N)" — live count from `/admin/pending`
- "Recent" — no count in tab label
- "Search" — no count in tab label

### Pending panel (existing, unchanged behavior)

Cards show Approve / Reject buttons. Same as today.

### Recent panel

- Loads automatically when tab is selected (or on first load after auth)
- Calls `GET /api/v1/admin/recent?limit=50`
- Cards use `renderManageCard(s)` (see below) — status badge + Delete button
- Shows newest at top

### Search panel

- Input field + Search button
- On submit: `GET /api/v1/admin/search?q=<term>&limit=50`
- Same `renderManageCard(s)` cards
- Empty state: "No results for '…'"
- If `q` is empty: show prompt "Enter a URL, name, provider, or category to search"

### Card renderer for Recent + Search: `renderManageCard(s)`

Same layout as `renderCard(s)` but:
1. Adds a status badge to the header: pill showing `active` (green), `pending` (yellow), `rejected` (red/muted)
2. Replaces Approve/Reject with a single **Delete** button (red, confirmation dialog)

```
┌──────────────────────────────────────────┐
│ Ryan's Ollama                  [active ●]│
│ https://xxx.ngrok-free.dev               │
│                                          │
│ Protocol: L402    Provider: golem-gateway│
│ Price: 500 sats   Category: ai/inference │
│ Registered: Mar 17, 2026                 │
│                                          │
│ [verified: yes]                          │
│                                          │
│                            [Delete]      │
└──────────────────────────────────────────┘
```

### Delete flow

1. Click Delete → `confirm('Delete "ServiceName"? This cannot be undone.')`
2. On confirm → `DELETE /api/v1/admin/services/:id`
3. On success → remove card from DOM, show green toast "Deleted"
4. On error → show red toast with error message, re-enable button

---

## Files to Change

| File | Change |
|------|--------|
| `src/routes/api.js` | Add `GET /admin/recent`, `GET /admin/search`, `DELETE /admin/services/:id` |
| `src/views/admin.js` | Tab layout, Recent panel, Search panel, `renderManageCard`, delete flow |

---

## Files to Add

| File | Purpose |
|------|---------|
| `tests/admin-dashboard.test.js` | API tests for new endpoints |

---

## Out of Scope

- Bulk delete
- Pagination (limit=50 is sufficient for admin use)
- Editing service fields
- Any change to existing Pending panel behavior

---

## Test Plan

See `tests/admin-dashboard.test.js`.

Coverage required:
- `GET /admin/recent` — returns services newest-first, respects limit, requires auth
- `GET /admin/search` — matches by name/url/provider/category, requires auth, empty q returns 400
- `DELETE /admin/services/:id` — deletes any-status service, 404 on missing, requires auth
- Existing endpoints untouched: `GET /admin/pending`, `POST /admin/approve/:id`, `POST /admin/reject/:id`
