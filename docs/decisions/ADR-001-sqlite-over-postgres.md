# ADR-001: Use SQLite Instead of Postgres

## Status

Accepted

## Context

402 Index is operated as a small public registry with a single application process, modest write volume, and read-heavy API traffic. The project needs low operational overhead more than horizontal database scaling.

## Decision

Use SQLite via `better-sqlite3` as the primary datastore.

## Consequences

- The app can run with a single persistent volume and no separate database service.
- Local development, tests, and backup workflows stay simple.
- Query performance is sufficient at current registry scale.
- Future multi-writer or high-volume ingestion needs may require a migration to Postgres or another networked database.
