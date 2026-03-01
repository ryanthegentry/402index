# L402 vs x402 Slider — Design Document

**Date:** 2026-03-01
**Author:** Ryan Gentry / BIXI
**Status:** Draft — for review with Jordi/Fewsats on March 3

---

## Concept

A horizontal "tug-of-war" bar at the top of the 402index.io homepage showing the ratio of L402 (Bitcoin/Lightning) services vs x402 (EVM/stablecoin) services. The slider gamifies the ecosystem — Bitcoiners see L402 underrepresented and are motivated to register their L402 APIs to "move the slider."

## Visual Design

```
┌──────────────────────────────────────────────────────────────────────┐
│  ⚡ L402 (23%)  ██████████░░░░░░░░░░░░░░░░░░░░░░░░░░░  x402 (77%)  │
│                          ┊                                          │
│                     slider position                                 │
└──────────────────────────────────────────────────────────────────────┘
```

- **Left side:** L402 — orange/amber (#F7931A Bitcoin orange), Lightning bolt icon
- **Right side:** x402 — blue (#0052FF Coinbase blue), chain/link icon
- **Slider fill:** Gradient from orange (left) to blue (right), split at the ratio point
- **Height:** ~40px, full-width within the container
- **Position:** Directly below the nav bar, above the stats bar

### The Lightning Reveal

As L402's share approaches 50%, a Lightning bolt graphic in the center progressively illuminates:

| L402 Share | Lightning State |
|-----------|----------------|
| 0-25% | Dim outline only (ghost bolt) |
| 25-40% | Partially lit (bottom half glowing) |
| 40-49% | Mostly lit, pulsing animation |
| 50%+ | Fully illuminated, brief celebration animation |

The bolt is positioned at the exact center of the bar. It serves as the visual "goal" — the community is trying to light up the bolt.

## Metric: What Powers the Slider?

**Use distinct providers, NOT raw endpoint count and NOT distinct services.**

Rationale:
- **Not endpoints (13K+ x402 vs ~100 L402):** Bazaar lists every chain×endpoint permutation. One API on 10 chains = 10 endpoints. This would make L402 look artificially tiny (~0.8%) and is misleading.
- **Not services (~508 x402 hosts vs ~23 L402 hosts):** Better, but still skewed by Bazaar's permutation model. One provider with many endpoints on many chains inflates the x402 count.
- **Providers (~439 x402 vs ~24 L402):** The most honest metric. Each organization counts once regardless of how many endpoints or chains they support. Currently L402 is ~5% by providers — a realistic starting point that can move meaningfully with each new L402 provider.

The slider reads from the `/api/v1/health` endpoint which now returns:
```json
{
  "distinct_providers": 463,
  "by_protocol": {
    "L402": { "endpoints": 118, "services": 23, "providers": 24 },
    "x402": { "endpoints": 13004, "services": 485, "providers": 439 }
  }
}
```

Slider position = `L402.providers / (L402.providers + x402.providers)`

## Call to Action

Below the slider bar:

```
"Bitcoin is underrepresented. Add your L402 API → "
```

Links to `github.com/ryanthegentry/402index/blob/main/CONTRIBUTING.md` — a guide for submitting new L402 listings via YAML PR.

When L402 reaches specific milestones, the CTA changes:
- < 10%: "Bitcoin is underrepresented. Add your L402 API →"
- 10-25%: "Lightning is growing. Add your API to the movement →"
- 25-40%: "The gap is closing. Will Lightning reach parity? →"
- 40-49%: "Almost there! Light up the bolt ⚡ →"
- 50%+: "Lightning has reached parity! Keep building →"

## Anti-Gaming

Fake listings inflating the count would undermine the slider's integrity. Defense layers:

1. **Health checks (primary):** Every listed service gets periodic HTTP probes. A service that doesn't return 402 on probe gets marked unhealthy. **Only healthy services count toward the slider metric.** This means you can't just register a YAML listing — the URL must actually respond with a 402 status code.

2. **Provider dedup:** Multiple endpoints from the same provider (same hostname) count as 1 provider. Registering 50 subdomains all pointing to the same service won't inflate the provider count.

3. **Manual review:** YAML PR submissions go through GitHub review. Obvious spam gets rejected before merge.

4. **Cool-down:** New listings enter an "unknown" health state and don't count toward the slider until the first successful health check confirms they return 402.

## Technical Implementation Notes

### Frontend
- **No framework needed.** Inline SVG for the bar, CSS for the gradient fill, CSS animation for the lightning bolt reveal.
- **Data fetching:** Single `fetch('/api/v1/health')` on page load. Cache the response for 5 minutes client-side (the data changes slowly).
- **SVG structure:**
  ```html
  <div class="slider-bar">
    <div class="slider-fill-l402" style="width: ${l402Pct}%"></div>
    <div class="slider-fill-x402" style="width: ${x402Pct}%"></div>
    <div class="slider-bolt ${boltClass}">⚡</div>
    <span class="slider-label-left">⚡ L402 (${l402Pct}%)</span>
    <span class="slider-label-right">x402 (${x402Pct}%)</span>
  </div>
  ```
- **Bolt animation:** CSS `@keyframes` glow effect. Opacity transitions based on L402 percentage thresholds.

### Backend
- The `/api/v1/health` endpoint already returns `distinct_providers` and `by_protocol` with provider counts. No new endpoint needed.
- To count only **healthy** providers for the slider, add a filtered query:
  ```sql
  SELECT protocol, COUNT(DISTINCT provider) as providers
  FROM services
  WHERE health_status = 'healthy'
  GROUP BY protocol
  ```
  This could be a new field in the health response: `healthy_providers_by_protocol`.

### Performance
- The distinct counting queries `SELECT url, protocol, provider FROM services` (all rows). For 13K rows this is ~5ms on SQLite. If it grows to 100K+, consider a materialized count table updated on each poll.

## Open Questions

1. **Real-time vs cached?** The slider should update at most once per hour (after polls complete). No need for WebSocket or real-time updates. The cached health endpoint is sufficient.

2. **Show exact numbers or just the visual?** Show both — the percentage labels plus a tooltip or subtitle like "24 L402 providers vs 439 x402 providers."

3. **Leaderboard?** A "Top L402 Providers" sidebar or section could add social proof. Show provider names, number of endpoints, and health status. This would complement the slider by showing WHO is contributing.

4. **What counts as a "provider" for anti-gaming?** Currently extracted from hostname. Should we allow self-declared provider names via YAML? The hostname approach is more tamper-resistant.

5. **Should the slider be on every page or just the homepage?** Homepage only to start. It's the hook — we don't want to clutter the service detail or API docs pages.

---

## Implementation Priority

This is a Phase 2 feature — design now, build after the Jordi meeting based on feedback. Estimated effort: 1-2 days for the frontend bar + CTA + bolt animation. The backend is already done.
