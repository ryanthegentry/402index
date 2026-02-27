export function layout(title, content) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — 402 Index</title>
  <style>
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
      gap: 24px;
      flex-wrap: wrap;
    }
    .stat-value { color: var(--text-bright); }

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

    /* Responsive */
    @media (max-width: 768px) {
      .detail-grid { grid-template-columns: 1fr; }
      .services-table { font-size: 12px; }
      .services-table th:nth-child(n+5),
      .services-table td:nth-child(n+5) { display: none; }
      .filters form { flex-direction: column; }
      .filters input[type="text"] { width: 100%; }
    }
  </style>
</head>
<body>
  <header>
    <div class="container">
      <a href="/" class="logo"><span>402</span>index</a>
      <nav>
        <a href="/">Directory</a>
        <a href="/about">About</a>
        <a href="/api/v1/health">API</a>
      </nav>
    </div>
  </header>
  ${content}
  <footer>
    <div class="container">
      <span>402 Index — paid API directory for AI agents</span>
    </div>
  </footer>
</body>
</html>`
}
