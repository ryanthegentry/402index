import { layout } from './layout.js'
import { escapeHtml } from './helpers.js'

export function statsSimplePage({ latency, categoryGap }) {
  const content = `
  <div class="container stats-page">
    <div class="stats-header">
      <h1>Stats</h1>
      <p class="stats-subtitle">Live reliability data, latency distributions, and category coverage across L402, x402, and MPP paid APIs</p>
    </div>

    <!-- ─── Section 1: Latency Distribution ────────────────────────────── -->
    <section class="stats-section">
      <h2>How Fast Is the Paid API Economy?</h2>
      <div class="table-wrap">
        <table class="stats-table stats-table-compact">
          <thead><tr><th>Protocol</th><th>Median Latency</th><th>p90 Latency</th><th>% Under 500ms</th></tr></thead>
          <tbody>
            ${['L402', 'x402', 'MPP'].map(proto => {
              const s = latency.protocolSummary[proto]
              if (!s || s.median == null) return ''
              return `<tr><td><span class="badge badge-${proto.toLowerCase()}">${proto}</span></td><td>${s.median}ms</td><td>${s.p90}ms</td><td>${s.under500}%</td></tr>`
            }).join('')}
          </tbody>
        </table>
      </div>
      <p class="stats-chart-note">Latency measured across healthy endpoints only. L402: ~200 endpoints, x402: ~12,000, MPP: ~200.</p>
    </section>

    <!-- ─── Section 2: Category Gap Map ────────────────────────────────── -->
    <section class="stats-section">
      <h2>What's Missing?</h2>
      <p class="stats-section-desc">Healthy endpoint counts by category and protocol. Empty cells are opportunities for new providers.</p>
      <div class="table-wrap">
        <table class="stats-table stats-gap-table">
          <thead>
            <tr>
              <th>Category</th>
              <th class="gap-col-l402">L402</th>
              <th class="gap-col-x402">x402</th>
              <th class="gap-col-mpp">MPP</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            ${categoryGap.grid.map(row => {
              const maxCount = Math.max(...categoryGap.grid.map(r => Math.max(r.L402, r.x402, r.MPP, 1)))
              return `<tr>
                <td class="gap-category">${escapeHtml(row.category)}</td>
                ${['L402', 'x402', 'MPP'].map(proto => {
                  const count = row[proto]
                  if (count === 0) {
                    return `<td class="gap-cell gap-zero">0</td>`
                  }
                  const opacity = Math.max(0.1, Math.min(0.8, count / maxCount))
                  return `<td class="gap-cell" style="background:rgba(52,211,153,${opacity.toFixed(2)})">${count}</td>`
                }).join('')}
                <td class="gap-total">${row.total}</td>
              </tr>`
            }).join('')}
          </tbody>
        </table>
      </div>
      ${categoryGap.opportunities.length > 0 ? `
      <div class="stats-opportunities">
        <h3>Opportunities</h3>
        <ul>
          ${categoryGap.opportunities.map(o => {
            if (o.count === 0) {
              return `<li>No <span class="badge badge-${o.protocol.toLowerCase()}">${o.protocol}</span> endpoints in "${escapeHtml(o.category)}"</li>`
            }
            return `<li>Only ${o.count} <span class="badge badge-${o.protocol.toLowerCase()}">${o.protocol}</span> endpoint${o.count > 1 ? 's' : ''} for "${escapeHtml(o.category)}"</li>`
          }).join('')}
        </ul>
      </div>` : ''}
    </section>

    <div class="stats-footer-note">
      Data updated every hour. Historical data since Feb 27, 2026.
    </div>
  </div>`

  return layout('Stats', content, {
    description: 'Live reliability data, latency distributions, and category coverage across L402, x402, and MPP paid APIs.',
    ogUrl: 'https://402index.io/stats',
  })
}
