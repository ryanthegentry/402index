# ADR-003: Avoid a Frontend Framework

## Status

Accepted

## Context

402 Index is primarily a directory, API surface, and machine-readable registry. The browser UI is useful but not the product's core complexity.

## Decision

Render HTML with server-side template literals and keep client-side JavaScript minimal.

## Consequences

- The runtime and build pipeline stay small.
- Pages work without a frontend build step.
- Contributors can inspect behavior directly in `src/views/`.
- Complex interactive features may eventually justify a dedicated frontend layer, but that cost is deferred until the UI needs it.
