export const styles = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #0f1117;
      --bg-surface: #181a20;
      --bg-hover: #1e2028;
      --border: #2a2d37;
      --text: #c9cdd6;
      --text-muted: #6b7080;
      --text-bright: #e8ebf0;
      --accent: #7c8aff;
      --green: #34d399;
      --yellow: #fbbf24;
      --red: #f87171;
      --gray: #4b5060;
      --orange: #fb923c;
      --blue: #60a5fa;
      --mono: 'SF Mono', 'Fira Code', 'Cascadia Code', 'JetBrains Mono', monospace;
      --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    }

    body {
      font-family: var(--sans);
      background: var(--bg);
      color: var(--text);
      font-size: 14px;
      line-height: 1.5;
      min-height: 100vh;
    }

    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }

    .container { max-width: 1400px; margin: 0 auto; padding: 0 20px; }

    /* Header */
    header {
      border-bottom: 1px solid var(--border);
      padding: 16px 0;
    }
    header .container {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .logo {
      font-family: var(--mono);
      font-size: 18px;
      font-weight: 700;
      color: var(--text-bright);
    }
    .logo span { color: var(--accent); }
    nav a {
      color: var(--text-muted);
      margin-left: 24px;
      font-size: 13px;
    }
    nav a:hover { color: var(--text); text-decoration: none; }

    /* Stats bar */
    .stats-bar {
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border);
      padding: 10px 0;
      font-family: var(--mono);
      font-size: 12px;
      color: var(--text-muted);
    }
    .stats-bar .container {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .stats-headline {
      display: flex;
      gap: 8px;
      align-items: center;
      font-size: 13px;
      margin-bottom: 4px;
    }
    .stats-detail {
      display: flex;
      gap: 24px;
      flex-wrap: wrap;
    }
    .stats-sep {
      color: var(--text-muted);
    }
    .stat-verified {
      color: var(--green);
    }
    .stat-value { color: var(--text-bright); }
    .pct-of {
      color: var(--text-muted);
      font-weight: normal;
      font-size: 11px;
    }

    /* Protocol bar */
    .protocol-bar {
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border);
      padding: 8px 0;
      font-family: var(--mono);
      font-size: 12px;
    }
    .protocol-bar .container {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .protocol-l402 {
      color: #F7931A;
      white-space: nowrap;
      cursor: pointer;
    }
    .protocol-x402 {
      color: #0052FF;
      white-space: nowrap;
    }
    .protocol-base {
      color: #0052FF;
      white-space: nowrap;
      cursor: pointer;
    }
    .protocol-solana {
      color: #9945FF;
      white-space: nowrap;
      cursor: pointer;
    }
    .protocol-tempo {
      color: #10b981;
      white-space: nowrap;
      cursor: pointer;
    }
    .protocol-track {
      flex: 1;
      height: 6px;
      background: rgba(0, 82, 255, 0.25);
      border-radius: 3px;
      overflow: hidden;
    }
    .protocol-track-multi {
      flex: 1;
      height: 6px;
      background: rgba(153, 69, 255, 0.25);
      border-radius: 3px;
      overflow: hidden;
      display: flex;
    }
    .protocol-fill-l402 {
      height: 100%;
      background: #F7931A;
    }
    .protocol-fill-base {
      height: 100%;
      background: #0052FF;
    }
    .protocol-fill-tempo {
      height: 100%;
      background: #10b981;
    }

    /* Filters */
    .filters {
      padding: 16px 0;
      border-bottom: 1px solid var(--border);
    }
    .filters form {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      align-items: center;
    }
    .filters select, .filters input[type="text"] {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 6px 10px;
      border-radius: 4px;
      font-size: 13px;
      font-family: var(--mono);
    }
    .filters select:focus, .filters input:focus {
      outline: none;
      border-color: var(--accent);
    }
    .filters input[type="text"] { width: 220px; }
    .filters label {
      font-size: 12px;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
    }
    .filter-btn {
      background: var(--accent);
      color: #fff;
      border: none;
      padding: 6px 14px;
      border-radius: 4px;
      font-size: 13px;
      cursor: pointer;
    }
    .filter-btn:hover { opacity: 0.9; }
    .filter-clear {
      color: var(--text-muted);
      font-size: 12px;
      cursor: pointer;
      background: none;
      border: none;
    }

    /* Table */
    .services-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .services-table th {
      text-align: left;
      padding: 10px 12px;
      border-bottom: 2px solid var(--border);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      font-weight: 600;
      white-space: nowrap;
    }
    .services-table td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      vertical-align: middle;
    }
    .services-table tr:hover td { background: var(--bg-hover); }
    .services-table tr { cursor: pointer; }

    .svc-name {
      color: var(--text-bright);
      font-weight: 500;
      max-width: 400px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      display: block;
    }
    .svc-url {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--text-muted);
      max-width: 400px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      display: block;
      margin-top: 2px;
    }

    /* Badges */
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 3px;
      font-size: 11px;
      font-weight: 600;
      font-family: var(--mono);
    }
    .badge-x402 { background: rgba(96,165,250,0.15); color: var(--blue); }
    .badge-l402 { background: rgba(251,146,60,0.15); color: var(--orange); }
    .badge-both { background: rgba(124,138,255,0.15); color: var(--accent); }
    .badge-mpp { background: rgba(16,185,129,0.15); color: #10b981; }

    /* Health dots */
    .health-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 6px;
      vertical-align: middle;
    }
    .health-healthy { background: var(--green); }
    .health-degraded { background: var(--yellow); }
    .health-down { background: var(--red); }
    .health-unknown { background: var(--gray); }

    .price {
      font-family: var(--mono);
      font-size: 12px;
      color: var(--text);
      white-space: nowrap;
    }
    .latency {
      font-family: var(--mono);
      font-size: 12px;
      color: var(--text-muted);
    }
    .category-tag {
      font-size: 11px;
      color: var(--text-muted);
      background: var(--bg);
      padding: 2px 6px;
      border-radius: 3px;
      white-space: nowrap;
    }
    .source-tag {
      font-size: 10px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    /* Pagination */
    .pagination {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 0;
      font-size: 13px;
      color: var(--text-muted);
    }
    .pagination a {
      padding: 6px 12px;
      border: 1px solid var(--border);
      border-radius: 4px;
      font-size: 13px;
    }
    .pagination a:hover { border-color: var(--accent); text-decoration: none; }

    /* Detail page */
    .detail-header {
      padding: 32px 0 24px;
      border-bottom: 1px solid var(--border);
    }
    .detail-header h1 {
      font-size: 22px;
      color: var(--text-bright);
      margin-bottom: 8px;
    }
    .detail-url {
      font-family: var(--mono);
      font-size: 13px;
      color: var(--accent);
      word-break: break-all;
    }
    .detail-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
      padding: 24px 0;
    }
    .detail-section {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 20px;
    }
    .detail-section h2 {
      font-size: 14px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 12px;
    }
    .detail-row {
      display: flex;
      justify-content: space-between;
      padding: 6px 0;
      border-bottom: 1px solid var(--border);
      font-size: 13px;
    }
    .detail-row:last-child { border-bottom: none; }
    .detail-label { color: var(--text-muted); }
    .detail-value { color: var(--text-bright); font-family: var(--mono); }

    .health-history {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
      font-family: var(--mono);
    }
    .health-history th {
      text-align: left;
      padding: 6px 8px;
      color: var(--text-muted);
      border-bottom: 1px solid var(--border);
      font-size: 11px;
    }
    .health-history td {
      padding: 6px 8px;
      border-bottom: 1px solid var(--border);
    }

    .schema-block {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 12px;
      font-family: var(--mono);
      font-size: 12px;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 300px;
      overflow-y: auto;
    }

    /* About page */
    .about-content {
      max-width: 700px;
      padding: 32px 0;
      line-height: 1.8;
    }
    .about-content h1 { font-size: 28px; color: var(--text-bright); margin-bottom: 16px; }
    .about-content h2 { font-size: 18px; color: var(--text-bright); margin: 24px 0 12px; }
    .about-content p { margin-bottom: 16px; }
    .about-content code {
      background: var(--bg-surface);
      padding: 2px 6px;
      border-radius: 3px;
      font-family: var(--mono);
      font-size: 13px;
    }
    .about-content pre {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 16px;
      overflow-x: auto;
      font-family: var(--mono);
      font-size: 13px;
      margin-bottom: 16px;
    }

    /* Footer */
    footer {
      border-top: 1px solid var(--border);
      padding: 20px 0;
      margin-top: 40px;
      font-size: 12px;
      color: var(--text-muted);
    }
    footer .container {
      display: flex;
      justify-content: space-between;
    }

    /* Filter toggle (mobile only) */
    .filter-toggle {
      display: none;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      color: var(--text-muted);
      padding: 6px 12px;
      border-radius: 4px;
      font-size: 12px;
      cursor: pointer;
      font-family: var(--mono);
    }
    .filter-toggle:hover { color: var(--text); border-color: var(--accent); }

    /* Table container */
    .table-wrap { overflow-x: auto; }

    /* API docs page */
    .docs-content {
      max-width: 800px;
      padding: 32px 0;
      line-height: 1.8;
    }
    .docs-content h1 { font-size: 28px; color: var(--text-bright); margin-bottom: 8px; }
    .docs-subtitle { color: var(--text-muted); margin-bottom: 32px; font-size: 15px; }
    .docs-content h2 {
      font-size: 20px;
      color: var(--text-bright);
      margin: 32px 0 16px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border);
    }
    .base-url {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 12px 16px;
      font-family: var(--mono);
      font-size: 14px;
      color: var(--accent);
      margin: 8px 0 32px;
    }
    .endpoint {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 20px;
      margin-bottom: 20px;
    }
    .endpoint-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
    }
    .endpoint-method {
      font-family: var(--mono);
      font-size: 12px;
      font-weight: 700;
      color: var(--green);
      background: rgba(52, 211, 153, 0.1);
      padding: 3px 8px;
      border-radius: 3px;
    }
    .endpoint-path {
      font-family: var(--mono);
      font-size: 14px;
      color: var(--text-bright);
    }
    .endpoint p { margin: 8px 0; color: var(--text); }
    .params-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      margin: 12px 0;
    }
    .params-table th {
      text-align: left;
      padding: 8px;
      border-bottom: 1px solid var(--border);
      color: var(--text-muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .params-table td {
      padding: 8px;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
    }
    .params-table td:first-child {
      font-family: var(--mono);
      color: var(--accent);
      white-space: nowrap;
    }
    .params-table td:nth-child(2) {
      font-family: var(--mono);
      font-size: 12px;
      color: var(--text-muted);
    }
    .example-block {
      position: relative;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 12px 60px 12px 12px;
      font-family: var(--mono);
      font-size: 12px;
      overflow-x: auto;
      margin: 12px 0;
      white-space: pre;
      color: var(--text);
    }
    .copy-btn {
      position: absolute;
      top: 8px;
      right: 8px;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      color: var(--text-muted);
      padding: 4px 8px;
      border-radius: 3px;
      font-size: 11px;
      cursor: pointer;
      font-family: var(--mono);
    }
    .copy-btn:hover { color: var(--text); border-color: var(--accent); }
    .response-sample {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 16px;
      font-family: var(--mono);
      font-size: 12px;
      overflow-x: auto;
      white-space: pre;
      color: var(--text);
      line-height: 1.5;
    }
    .info-callout {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-left: 3px solid var(--accent);
      border-radius: 4px;
      padding: 20px;
      margin: 24px 0;
    }
    .info-callout h3 {
      color: var(--text-bright);
      font-size: 16px;
      margin-bottom: 8px;
    }
    .info-callout p { margin: 0; }

    /* Demo page */
    .demo-page { padding: 32px 0; }
    .demo-header { margin-bottom: 32px; padding-left: 24px; }
    .demo-header h1 { font-size: 28px; color: var(--text-bright); margin-bottom: 8px; }
    .demo-subtitle { color: var(--text-muted); font-size: 15px; }

    .demo-panel {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 24px;
      margin-bottom: 24px;
    }
    .demo-panel h2 {
      font-size: 14px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 16px;
    }
    .demo-panel-desc { color: var(--text-muted); font-size: 13px; margin-bottom: 20px; }

    /* Panel 1: Ecosystem */
    .demo-stat-cards {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 16px;
      margin-bottom: 24px;
    }
    .demo-stat-card {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 16px;
      text-align: center;
    }
    .demo-stat-verified { border-color: var(--green); }
    .demo-stat-number {
      font-size: 28px;
      font-weight: 700;
      color: var(--text-bright);
      font-family: var(--mono);
    }
    .demo-stat-verified .demo-stat-number { color: var(--green); }
    .demo-stat-label { font-size: 12px; color: var(--text-muted); margin-top: 4px; }

    .demo-protocol-compare {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 16px;
      margin-bottom: 24px;
    }
    .demo-protocol-card {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 16px;
    }
    .demo-protocol-l402 { border-left: 3px solid #F7931A; }
    .demo-protocol-x402 { border-left: 3px solid #0052FF; }
    .demo-protocol-mpp { border-left: 3px solid #10b981; }
    .demo-protocol-title { font-size: 14px; color: var(--text-bright); margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
    .demo-protocol-row {
      display: flex;
      justify-content: space-between;
      padding: 4px 0;
      font-size: 13px;
      color: var(--text-muted);
    }
    .demo-protocol-row strong { color: var(--text-bright); font-family: var(--mono); }
    .demo-protocol-note { font-size: 11px; color: var(--text-muted); margin-top: 8px; font-style: italic; }

    .demo-health-bars { margin-top: 16px; }
    .demo-health-bars h3 { font-size: 13px; color: var(--text-muted); margin-bottom: 12px; }
    .demo-health-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
      font-size: 13px;
    }
    .demo-health-label { width: 70px; color: var(--text-muted); }
    .demo-health-bar {
      flex: 1;
      height: 8px;
      background: var(--bg);
      border-radius: 4px;
      overflow: hidden;
    }
    .demo-health-fill { height: 100%; border-radius: 4px; }
    .demo-fill-healthy { background: var(--green); }
    .demo-fill-degraded { background: var(--yellow); }
    .demo-fill-down { background: var(--red); }
    .demo-fill-unknown { background: var(--gray); }
    .demo-health-count { width: 60px; text-align: right; font-family: var(--mono); font-size: 12px; color: var(--text-bright); }
    .demo-last-checked { font-size: 11px; color: var(--text-muted); margin-top: 12px; }

    /* Twin panel layout: search + probe side-by-side on desktop */
    .demo-twin-panel {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
      align-items: start;
    }
    .demo-twin-panel .demo-search,
    .demo-twin-panel .demo-probe {
      min-width: 0;
    }
    @media (max-width: 1023px) {
      .demo-twin-panel {
        grid-template-columns: 1fr;
      }
      .demo-twin-panel .demo-probe {
        position: static;
      }
    }

    /* Panel 2: Search */
    .demo-search-form { margin-bottom: 16px; }
    .demo-search-input {
      width: 100%;
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 10px 14px;
      border-radius: 6px;
      font-size: 14px;
      font-family: var(--mono);
      margin-bottom: 8px;
    }
    .demo-search-input:focus { outline: none; border-color: var(--accent); }
    .demo-filter-chips {
      display: flex;
      gap: 8px;
      flex-wrap: nowrap;
      align-items: center;
    }
    .demo-filter-group { display: flex; flex-direction: row; align-items: center; gap: 4px; }
    .demo-filter-group label { font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; white-space: nowrap; }
    .demo-filter-group select {
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-family: var(--mono);
    }
    .demo-filter-group select:focus { outline: none; border-color: var(--accent); }

    .demo-mcp-query {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      margin-bottom: 16px;
      overflow: hidden;
    }
    .demo-mcp-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
      font-size: 11px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .demo-mcp-header .copy-btn {
      position: static;
    }
    .demo-mcp-query .demo-code-block {
      margin: 0;
      border: none;
      border-radius: 0;
    }

    .demo-search-results { min-height: 100px; }
    .demo-search-hint { color: var(--text-muted); font-size: 13px; text-align: center; padding: 32px 0; }
    .demo-results-header { font-size: 12px; color: var(--text-muted); margin-bottom: 12px; font-family: var(--mono); }

    .demo-result-card {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px 16px;
      margin-bottom: 8px;
      cursor: pointer;
      transition: border-color 0.15s;
    }
    .demo-result-card:hover { border-color: var(--accent); }
    .demo-result-name { font-size: 14px; color: var(--text-bright); font-weight: 500; }
    .demo-result-meta {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 4px;
      font-size: 12px;
    }
    .demo-result-url {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 4px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .demo-result-reliability { color: var(--accent); font-family: var(--mono); }
    .demo-result-latency { color: var(--text-muted); font-family: var(--mono); }
    .demo-result-price { color: var(--text); font-family: var(--mono); }
    .demo-result-detail {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--border);
    }
    .demo-result-desc { margin-top: 8px; font-size: 13px; color: var(--text-muted); }

    /* Copy URL button */
    .demo-result-url-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .demo-copy-url-btn {
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--accent);
      padding: 2px 8px;
      border-radius: 3px;
      font-size: 11px;
      font-family: var(--mono);
      cursor: pointer;
      white-space: nowrap;
      flex-shrink: 0;
      transition: background 0.15s, color 0.15s;
    }
    .demo-copy-url-btn:hover { background: var(--accent); color: var(--bg); }
    .demo-view-details-btn {
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--accent);
      padding: 2px 8px;
      border-radius: 3px;
      font-size: 11px;
      font-family: var(--mono);
      white-space: nowrap;
      flex-shrink: 0;
      transition: background 0.15s, color 0.15s;
      text-decoration: none;
    }
    .demo-view-details-btn:hover { background: var(--accent); color: var(--bg); text-decoration: none; }
    .demo-view-all-link {
      display: block;
      text-align: center;
      padding: 16px 0;
      color: var(--accent);
      text-decoration: none;
      font-size: 14px;
    }
    .demo-view-all-link:hover { text-decoration: underline; }

    /* Live Probe Section */
    .demo-probe-section { margin-top: 24px; border-top: 1px solid var(--border); padding-top: 20px; }
    .demo-probe-section h3 { font-size: 16px; color: var(--text-bright); margin-bottom: 4px; }
    .demo-probe-input-row {
      display: flex;
      gap: 8px;
      margin-top: 12px;
    }
    .demo-probe-url {
      flex: 1;
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text-bright);
      padding: 8px 12px;
      border-radius: 4px;
      font-size: 13px;
      font-family: var(--mono);
    }
    .demo-probe-url:focus { outline: none; border-color: var(--accent); }
    .demo-healthcheck-btn {
      background: var(--accent);
      color: var(--bg);
      border: none;
      padding: 8px 16px;
      border-radius: 4px;
      font-size: 13px;
      font-family: var(--mono);
      cursor: pointer;
      white-space: nowrap;
      transition: opacity 0.15s;
    }
    .demo-healthcheck-btn:hover { opacity: 0.85; }
    .demo-healthcheck-btn:disabled { opacity: 0.5; cursor: wait; }

    /* Probe Log (terminal style) */
    .demo-probe-log {
      margin-top: 12px;
      background: #0a0c10;
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 12px 16px;
      font-family: var(--mono);
      font-size: 12px;
      overflow-x: hidden;
      min-height: 0;
    }
    .demo-probe-log:empty { display: none; }
    .demo-probe-step {
      padding: 3px 0;
      color: var(--text);
      line-height: 1.6;
      overflow-wrap: break-word;
      word-break: break-all;
    }
    .demo-probe-icon { color: var(--text-muted); margin-right: 4px; }
    .demo-probe-step-response { color: var(--yellow); }
    .demo-probe-step-headers { color: var(--accent); }
    .demo-probe-step-done { color: var(--green); }
    .demo-probe-step-error { color: var(--red); }
    .demo-probe-header-detail {
      color: var(--text-muted);
      font-size: 11px;
      padding-left: 20px;
      word-break: break-all;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }

    /* Panel 3: Flow */
    .demo-flow-toggle {
      display: flex;
      gap: 8px;
      margin-bottom: 24px;
    }
    .demo-toggle-btn {
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text-muted);
      padding: 6px 16px;
      border-radius: 4px;
      font-size: 13px;
      font-family: var(--mono);
      cursor: pointer;
      transition: all 0.15s;
    }
    .demo-toggle-btn:hover { border-color: var(--accent); color: var(--text); }
    .demo-toggle-active { background: var(--accent); color: #fff; border-color: var(--accent); }
    .demo-toggle-active:hover { opacity: 0.9; }

    .demo-flow-steps { position: relative; padding-left: 40px; }
    .demo-flow-steps::before {
      content: '';
      position: absolute;
      left: 15px;
      top: 20px;
      bottom: 20px;
      width: 2px;
      background: var(--border);
    }
    .demo-flow-step {
      position: relative;
      margin-bottom: 20px;
    }
    .demo-flow-step:last-child { margin-bottom: 0; }
    .demo-flow-step-number {
      position: absolute;
      left: -40px;
      top: 0;
      width: 30px;
      height: 30px;
      background: var(--accent);
      color: #fff;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      font-weight: 700;
      font-family: var(--mono);
      z-index: 1;
    }
    .demo-flow-step-content {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 16px;
    }
    .demo-flow-step-content h4 { font-size: 14px; color: var(--text-bright); margin-bottom: 4px; }
    .demo-flow-step-content p { font-size: 13px; color: var(--text-muted); margin-bottom: 8px; }

    .demo-code-block {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 12px;
      font-family: var(--mono);
      font-size: 12px;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--text);
      line-height: 1.5;
      margin: 0;
    }

    /* CSS-only tooltips */
    [data-tooltip] {
      position: relative;
      cursor: help;
    }
    [data-tooltip]::after {
      content: attr(data-tooltip);
      position: absolute;
      bottom: calc(100% + 8px);
      left: 50%;
      transform: translateX(-50%);
      background: var(--bg-surface);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 12px;
      line-height: 1.5;
      white-space: normal;
      width: max-content;
      max-width: 320px;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.15s;
      z-index: 100;
      font-weight: normal;
      font-style: normal;
      font-family: var(--sans);
    }
    [data-tooltip]:hover::after,
    [data-tooltip]:focus::after {
      opacity: 1;
    }
    @media (max-width: 768px) {
      [data-tooltip]:active::after {
        opacity: 1;
      }
    }

    /* Stats page */
    .stats-page { padding: 32px 0; }
    .stats-header { margin-bottom: 32px; }
    .stats-header h1 { font-size: 28px; color: var(--text-bright); margin-bottom: 8px; }
    .stats-subtitle { color: var(--text-muted); font-size: 15px; }
    .stats-section {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 24px;
      margin-bottom: 24px;
    }
    .stats-section h2 { font-size: 18px; color: var(--text-bright); margin-bottom: 16px; }
    .stats-section-desc { color: var(--text-muted); font-size: 13px; margin-bottom: 16px; }
    .stats-view-toggle { display: flex; gap: 8px; margin-bottom: 16px; }
    .stats-toggle-btn {
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text-muted);
      padding: 6px 16px;
      border-radius: 4px;
      font-size: 13px;
      font-family: var(--mono);
      cursor: pointer;
      transition: all 0.15s;
    }
    .stats-toggle-btn:hover { border-color: var(--accent); color: var(--text); }
    .stats-toggle-active { background: var(--accent); color: #fff; border-color: var(--accent); }
    .stats-toggle-active:hover { opacity: 0.9; }
    .stats-filter-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 16px;
      font-size: 12px;
      color: var(--text-muted);
    }
    .stats-filter-row select {
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-family: var(--mono);
    }
    .stats-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      table-layout: fixed;
    }
    .stats-table th {
      text-align: left;
      padding: 8px 12px;
      border-bottom: 2px solid var(--border);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      font-weight: 600;
      white-space: nowrap;
    }
    .stats-table td {
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
      vertical-align: middle;
    }
    .stats-table tr:hover td { background: var(--bg-hover); }
    .stats-table .rank { color: var(--text-muted); font-family: var(--mono); width: 40px; }
    .stats-table .provider-name { color: var(--text-bright); font-family: var(--mono); font-size: 12px; }
    .stats-table .endpoint-name a { color: var(--text-bright); font-weight: 500; }
    .stats-table .endpoint-name a:hover { color: var(--accent); }
    .stats-table-compact { font-size: 12px; }
    .stats-table-compact th { font-size: 10px; }

    .reliability-bar-cell { width: 100px; }
    .reliability-bar-bg {
      width: 100%;
      height: 6px;
      background: var(--bg);
      border-radius: 3px;
      overflow: hidden;
    }
    .reliability-bar-fill {
      height: 100%;
      border-radius: 3px;
      transition: width 0.3s;
    }

    .stats-callouts {
      display: flex;
      gap: 24px;
      margin-bottom: 24px;
      flex-wrap: wrap;
    }
    .stats-callout {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 16px 24px;
      text-align: center;
      flex: 1;
      min-width: 150px;
    }
    .stats-callout-value {
      display: block;
      font-size: 28px;
      font-weight: 700;
      color: var(--text-bright);
      font-family: var(--mono);
    }
    .stats-callout-label {
      display: block;
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 4px;
    }
    .stats-table-container {
      overflow-x: hidden;
    }
    .stats-table .endpoint-name {
      max-width: 400px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .stats-table .provider-name {
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Latency comparison bars */
    .latency-bars {
      margin: 16px 0 24px;
    }
    .latency-bar-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
    }
    .latency-bar-label {
      width: 60px;
      flex-shrink: 0;
    }
    .latency-bar {
      position: relative;
      height: 24px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      flex: 1;
      min-width: 0;
    }
    .latency-bar-fill {
      height: 100%;
      border-radius: 3px;
    }
    .latency-fill-l402 { background: rgba(247, 147, 26, 0.7); }
    .latency-fill-x402 { background: rgba(0, 82, 255, 0.7); }
    .latency-fill-mpp { background: rgba(16, 185, 129, 0.7); }
    .latency-p90-mark {
      position: absolute;
      top: 0;
      width: 2px;
      height: 100%;
      background: var(--text-muted);
      opacity: 0.6;
    }
    .latency-bar-stats {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--text-muted);
      white-space: nowrap;
      flex-shrink: 0;
    }
    @media (max-width: 768px) {
      .latency-bar-row { flex-wrap: wrap; gap: 6px; }
      .latency-bar-stats { font-size: 10px; width: 100%; padding-left: 72px; }
    }

    /* Gap map */
    .stats-gap-table td { text-align: center; font-family: var(--mono); font-size: 12px; }
    .gap-category { text-align: left !important; color: var(--text-bright); font-family: var(--sans); }
    .gap-total { color: var(--text-bright); font-weight: 600; }
    .gap-cell { min-width: 60px; }
    .gap-zero {
      color: var(--red);
      border: 1px dashed rgba(248,113,113,0.3);
      background: rgba(248,113,113,0.05) !important;
    }
    .gap-col-l402 { color: #F7931A; }
    .gap-col-x402 { color: #0052FF; }
    .gap-col-mpp { color: #10b981; }

    .stats-opportunities {
      margin-top: 20px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
    }
    .stats-opportunities h3 { font-size: 14px; color: var(--text-bright); margin-bottom: 12px; }
    .stats-opportunities ul { list-style: none; }
    .stats-opportunities li {
      padding: 6px 0;
      font-size: 13px;
      color: var(--text-muted);
      border-bottom: 1px solid var(--border);
    }
    .stats-opportunities li:last-child { border-bottom: none; }

    .stats-footer-note {
      text-align: center;
      font-size: 12px;
      color: var(--text-muted);
      padding: 24px 0;
    }

    /* Responsive */
    @media (max-width: 768px) {
      .detail-grid { grid-template-columns: 1fr; }

      /* Stats bar responsive */
      .stats-headline { flex-wrap: wrap; font-size: 12px; }
      .stats-detail { gap: 4px 16px; font-size: 11px; }

      /* Filters: collapsible on mobile */
      .filter-toggle { display: inline-block; }
      .filters form { gap: 8px; }
      .filters input[type="text"] { order: -2; flex: 1; min-width: 0; width: auto; }
      .filters .filter-toggle { order: -1; }
      .filters form:not(.filters-open) select,
      .filters form:not(.filters-open) label,
      .filters form:not(.filters-open) .filter-btn,
      .filters form:not(.filters-open) .filter-clear { display: none; }
      .filters form.filters-open select { width: 100%; }

      /* Table: hide Category(4), Latency(6), Source(7) */
      .services-table { font-size: 12px; }
      .services-table th:nth-child(4),
      .services-table td:nth-child(4),
      .services-table th:nth-child(6),
      .services-table td:nth-child(6),
      .services-table th:nth-child(7),
      .services-table td:nth-child(7) { display: none; }
      .svc-name, .svc-url { max-width: 180px; }

      /* About page code blocks */
      .about-content { max-width: 100%; }
      .about-content pre { white-space: pre-wrap; word-break: break-word; }

      /* API docs */
      .docs-content { max-width: 100%; }
      .endpoint { padding: 14px; }
      .params-table td:first-child { font-size: 12px; }
      .example-block { white-space: pre-wrap; word-break: break-all; }
      .response-sample { white-space: pre-wrap; word-break: break-word; }

      /* Stats page responsive */
      .stats-header h1 { font-size: 20px; }
      .stats-section { padding: 16px; }
      .stats-callouts { gap: 12px; }
      .stats-callout { padding: 12px 16px; min-width: 100px; }
      .stats-callout-value { font-size: 20px; }
      .stats-table { font-size: 12px; }
      .stats-table th, .stats-table td { padding: 6px 8px; }
      .reliability-bar-cell { width: 60px; }

      /* Footer */
      footer .container { flex-direction: column; gap: 8px; }

      /* Demo page responsive */
      .demo-header h1 { font-size: 20px; }
      .demo-subtitle { font-size: 13px; }
      .demo-stat-cards { grid-template-columns: repeat(2, 1fr); }
      .demo-stat-number { font-size: 20px; }
      .demo-stat-label { font-size: 11px; }
      .demo-protocol-compare { grid-template-columns: 1fr; }
      .demo-panel { padding: 16px; }
      .demo-flow-steps { padding-left: 36px; }
      .demo-flow-step-number { width: 26px; height: 26px; font-size: 11px; left: -36px; }
      .demo-flow-step-content { padding: 12px; }
      .demo-flow-step-content .demo-code-block { font-size: 11px; }
      .demo-result-meta { flex-wrap: wrap; gap: 6px; }
      .demo-result-url { font-size: 10px; }
      .demo-result-card { padding: 10px 12px; }
      .demo-mcp-query .demo-code-block { font-size: 11px; }
      .demo-flow-toggle { flex-wrap: wrap; }
      .demo-toggle-btn { flex: 1; text-align: center; }
      .demo-health-label { width: 60px; }
      .demo-health-count { width: 50px; }
      .demo-healthcheck-btn { width: 100%; }
      .demo-probe-input-row { flex-direction: column; }
      .demo-probe-url { font-size: 12px; }
    }

    /* True mobile: stack filters vertically */
    @media (max-width: 480px) {
      .demo-filter-chips { flex-direction: column; flex-wrap: wrap; }
      .demo-filter-group { width: 100%; }
      .demo-filter-group select { width: 100%; min-height: 36px; }
    }

    /* Desktop enhancements */
    @media (min-width: 1200px) {
      .demo-page { padding: 48px 0; }
      .demo-panel { padding: 32px; }
      .demo-stat-number { font-size: 32px; }
      .demo-flow-steps { max-width: 800px; }
    }
`
