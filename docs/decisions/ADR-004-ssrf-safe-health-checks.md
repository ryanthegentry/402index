# ADR-004: Make Health Checks SSRF-Safe by Default

## Status

Accepted

## Context

402 Index probes third-party URLs submitted by users and imported from external directories. A naive health checker could be abused to reach localhost, private networks, cloud metadata endpoints, or non-HTTP schemes.

## Decision

Resolve and validate probe targets before fetching them. Block private and loopback IP ranges, cloud metadata addresses, and non-HTTP schemes. Handle redirects manually rather than following them automatically.

## Consequences

- The health checker can safely process untrusted submitted URLs.
- Some unusual but legitimate private or internal endpoints cannot be listed as publicly healthy.
- SSRF protections must be maintained as URL parsing, DNS resolution, and probe behavior evolve.
