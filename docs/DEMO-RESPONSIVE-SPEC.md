# Demo Page Responsive Optimization Spec

## Problem
The demo page has minimal responsive CSS (4 rules). It needs polish for both mobile review and desktop presentation (community call will likely be shared on a large screen).

## Mobile Fixes (max-width: 768px)

### Typography scaling
- `.demo-header h1`: 28px → 20px
- `.demo-subtitle`: 15px → 13px
- `.demo-stat-number`: 28px → 20px
- `.demo-stat-label`: 12px → 11px

### Flow visualization
- `.demo-flow-steps`: padding-left 40px → 36px (tighter but still fits step numbers)
- `.demo-flow-step-number`: width/height 30px → 26px, font-size 13px → 11px, left -40px → -36px
- `.demo-flow-step-content`: padding 16px → 12px
- `.demo-code-block`: font-size 12px → 11px

### Search results
- `.demo-result-meta`: add flex-wrap: wrap for when badges + stats overflow
- `.demo-result-url`: font-size 11px → 10px
- `.demo-result-card`: padding 12px 16px → 10px 12px

### Filter selects
- `.demo-filter-group select`: min-height 36px for touch targets (iOS recommends 44px min tap target)
- `.demo-filter-group`: width 100% when stacked

### MCP query
- `.demo-mcp-query .demo-code-block`: font-size 11px

### Toggle buttons
- `.demo-flow-toggle`: flex-wrap: wrap (in case buttons don't fit on narrow screens)
- `.demo-toggle-btn`: flex: 1 so buttons split evenly

### Health bars
- `.demo-health-label`: width 70px → 60px
- `.demo-health-count`: width 60px → 50px

### Healthcheck button
- `.demo-healthcheck-btn`: width 100%

## Desktop Enhancements (min-width: 1200px)

### Max-width containment
- `.demo-flow-steps`: max-width 800px (prevent too-wide reading on ultrawide)
- `.demo-search-results`: max-width stays at container width (useful to see many results)

### Spacing
- `.demo-page`: padding 48px 0 (more breathing room)
- `.demo-panel`: padding 32px (more internal space)
- `.demo-stat-number`: font-size 32px (slightly bigger for presentation)

## Markup Changes

### Add viewport meta (already present in layout.js ✓)
### Add `meta name="theme-color"` for mobile browser chrome
- Value: `#0f1117` (matches --bg)

## Testable Properties
Tests verify the CSS contains the responsive rules and markup includes responsive-critical attributes. Since we're server-rendered HTML with inline CSS, we test:
1. CSS string contains mobile media query rules for demo elements
2. CSS string contains desktop media query rules for demo elements
3. HTML includes viewport meta tag
4. HTML includes theme-color meta tag
5. Demo page markup includes responsive-friendly attributes (no fixed widths on content elements)
