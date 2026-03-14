# Opportunities Feed Spec

## Overview
JSON API + HTML page showing ecosystem gaps — categories with low/zero healthy endpoints, missing protocol coverage, single-provider dependencies, and failing services. Developer recruitment tool: "here's where to build."

## Endpoints

### GET /api/v1/opportunities — JSON
- **Auth:** None (public)
- **Query params:** `?protocol=L402|x402` (optional filter)
- **Response:** `{ opportunities: [...], total: N }`

### GET /opportunities — HTML page
- **Layout:** Uses `layout()` wrapper
- **Filter:** Protocol dropdown at top
- **Content:** Cards/table grouped by opportunity type

## Opportunity Types

### 1. Category Gaps (`type: "gap"`)
Categories with <=2 healthy endpoints. High total but few healthy = market demand with poor supply.

### 2. Protocol Gaps (`type: "protocol_gap"`)
Categories with only one protocol represented. E.g., "has 10 x402 endpoints but 0 L402" — opportunity for L402 provider.

### 3. Single Provider (`type: "single_provider"`)
Categories where all endpoints belong to a single provider (hostname). Diversity opportunity.

### 4. Failing Services (`type: "failing"`)
Categories with >=2 down endpoints. Registered but broken = someone wanted it to exist. Replacement opportunity.

## Opportunity Object
```json
{
  "type": "gap|protocol_gap|single_provider|failing",
  "category": "data/weather",
  "total_endpoints": 10,
  "healthy_endpoints": 1,
  "protocol_coverage": { "L402": 3, "x402": 7 },
  "provider_count": 1,
  "providers": ["example.com"],
  "suggestion": "Only 1 of 10 endpoints are healthy in data/weather. Opportunity for a reliable provider."
}
```

## SQL Queries
All queries use `WHERE (status = 'active' OR status IS NULL) AND category IS NOT NULL`.

## Implementation
- Service: `src/services/opportunities.js` — `findOpportunities(db, { protocol })`
- View: `src/views/opportunities.js` — `opportunitiesPage({ opportunities, protocol })`
- Tests: `test/opportunities.test.js`
