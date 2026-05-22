# ADR-002: Use DELETE Journal Mode on Railway

## Status

Accepted

## Context

SQLite WAL mode is attractive for read/write concurrency, but this project previously hit reliability issues with WAL files on the deployed persistent-volume topology.

## Decision

Use SQLite DELETE journal mode for production.

## Consequences

- The deployment avoids WAL-specific failure modes on the current storage layer.
- Database behavior is easier to reason about during backup and restore.
- Write concurrency is lower than WAL mode, which is acceptable for current ingestion and admin workloads.
- If deployment topology changes, journal mode should be revisited with production-like load tests.
