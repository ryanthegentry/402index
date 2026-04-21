# 402 Index

Protocol-agnostic directory of paid APIs (L402, x402, MPP) for AI agents.

## Search

The `GET /api/v1/services?q=` endpoint uses hybrid semantic search. When embeddings are available (via the backfill script), queries are matched using both LIKE substring matching and cosine similarity against service embeddings. Results are re-ranked using a 5-tier composite sort: exact name match, LIKE on name, LIKE on description, cosine similarity, then default ordering. If the embedding service is unavailable, search falls back to LIKE-only and returns an `X-402index-Search-Degraded` response header with the reason code.

## Quick Start

```bash
npm install
npm run dev        # Start dev server with nodemon
npm test           # Run tests
npm run poll       # Run Bazaar + Satring poll
npm run healthcheck
```

## Deployment

Pushes to `master` auto-deploy to Railway.
