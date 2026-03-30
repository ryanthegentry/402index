import { layout } from './layout.js'
import { escapeHtml, safeJsonEmbed } from './helpers.js'

export function statsPage({ scoreboard, latency, categoryGap }) {
  // Pre-compute latency bar HTML
  const protos = ['L402', 'x402', 'MPP']
  const maxP90 = Math.max(...protos.map(p => latency.protocolSummary[p]?.p90 || 0))
  const latencyBarsHtml = maxP90 > 0 ? `<div class="latency-bars">${protos.map(proto => {
    const s = latency.protocolSummary[proto]
    if (!s || s.median == null) return ''
    const medianPct = (s.median / maxP90 * 100).toFixed(1)
    const p90Pct = (s.p90 / maxP90 * 100).toFixed(1)
    return `<div class="latency-bar-row">
      <span class="latency-bar-label"><span class="badge badge-${proto.toLowerCase()}">${escapeHtml(proto)}</span></span>
      <div class="latency-bar">
        <div class="latency-bar-fill latency-fill-${proto.toLowerCase()}" style="width:${medianPct}%"></div>
        <div class="latency-p90-mark" style="left:${p90Pct}%"></div>
      </div>
      <span class="latency-bar-stats">${s.median}ms median &middot; ${s.p90}ms p90 &middot; ${s.under500}% &lt; 500ms</span>
    </div>`
  }).join('')}</div>` : ''

  const content = `
  <div class="container stats-page">
    <div class="stats-header">
      <h1>Stats</h1>
      <p class="stats-subtitle">Live reliability data, latency distributions, and category coverage across L402, x402, and MPP paid APIs</p>
    </div>

    <!-- ─── Section 1: Reliability Scoreboard ──────────────────────────── -->
    <section class="stats-section">
      <h2>Which Paid APIs Work the Best?</h2>
      <div class="stats-view-toggle" id="scoreboard-toggle">
        <button class="stats-toggle-btn stats-toggle-active" data-view="provider">By Provider</button>
        <button class="stats-toggle-btn" data-view="endpoint">By Endpoint</button>
      </div>
      <div class="stats-filter-row">
        <label>Protocol</label>
        <select id="scoreboard-protocol-filter">
          <option value="">All</option>
          <option value="L402">L402</option>
          <option value="x402">x402</option>
          <option value="MPP">MPP</option>
        </select>
      </div>
      <div class="stats-table-container">
        <table class="stats-table" id="scoreboard-table">
          <thead id="scoreboard-thead"></thead>
          <tbody id="scoreboard-tbody"></tbody>
        </table>
      </div>
    </section>

    <!-- ─── Section 2: Latency Distribution ────────────────────────────── -->
    <section class="stats-section">
      <h2>How Fast Is the Paid API Economy?</h2>
      <div class="stats-callouts">
        ${latency.median != null ? `<div class="stats-callout"><span class="stats-callout-value">${latency.median}ms</span><span class="stats-callout-label">Median latency</span></div>` : ''}
        ${latency.fastestProtocol ? `<div class="stats-callout"><span class="stats-callout-value">${escapeHtml(latency.fastestProtocol)}</span><span class="stats-callout-label">Fastest protocol (${latency.fastestMedian}ms median)</span></div>` : ''}
        ${latency.under500 > 0 ? `<div class="stats-callout"><span class="stats-callout-value">${latency.under500}%</span><span class="stats-callout-label">Respond under 500ms</span></div>` : ''}
      </div>
      ${latencyBarsHtml}
      <p class="stats-chart-note">Latency measured across healthy endpoints only. L402: ~200 endpoints, x402: ~12,000, MPP: ~200.</p>
      <div class="table-wrap" style="margin-top:24px">
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
    </section>

    <!-- ─── Section 3: Category Gap Map ────────────────────────────────── -->
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
  </div>

  <script>
  (function() {
    // ─── Scoreboard ─────────────────────────────────────────────────────
    var providerData = ${safeJsonEmbed(scoreboard.providers)}
    var endpointData = ${safeJsonEmbed(scoreboard.endpoints)}
    var currentView = 'provider'
    var currentProtocol = ''

    var toggle = document.getElementById('scoreboard-toggle')
    var protocolFilter = document.getElementById('scoreboard-protocol-filter')
    var thead = document.getElementById('scoreboard-thead')
    var tbody = document.getElementById('scoreboard-tbody')

    function escapeH(str) {
      if (!str) return ''
      return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
    }

    function protocolBadges(protocols) {
      return protocols.map(function(p) {
        return '<span class="badge badge-' + escapeH(p.toLowerCase()) + '">' + escapeH(p) + '</span>'
      }).join(' ')
    }

    function reliabilityColor(score) {
      if (score >= 90) return 'var(--green)'
      if (score >= 70) return 'var(--yellow)'
      return 'var(--red)'
    }

    function reliabilityBar(score) {
      var color = reliabilityColor(score)
      return '<div class="reliability-bar-bg"><div class="reliability-bar-fill" style="width:' + Math.min(score, 100) + '%;background:' + color + '"></div></div>'
    }

    function renderScoreboard() {
      if (currentView === 'provider') {
        thead.innerHTML = '<tr><th>#</th><th>Provider</th><th>Protocol(s)</th><th>Avg Reliability</th><th></th><th>Endpoints</th><th>% Healthy</th><th>Avg Latency</th></tr>'
        var filtered = providerData
        if (currentProtocol) {
          filtered = providerData.filter(function(p) { return p.protocols.indexOf(currentProtocol) !== -1 })
        }
        var display = filtered.slice(0, 25)
        tbody.innerHTML = display.map(function(p, i) {
          return '<tr>' +
            '<td class="rank">' + (i + 1) + '</td>' +
            '<td class="provider-name">' + escapeH(p.provider) + '</td>' +
            '<td>' + protocolBadges(p.protocols) + '</td>' +
            '<td style="color:' + reliabilityColor(p.avg_reliability) + '">' + p.avg_reliability + '</td>' +
            '<td class="reliability-bar-cell">' + reliabilityBar(p.avg_reliability) + '</td>' +
            '<td>' + p.endpoints + '</td>' +
            '<td>' + p.healthy_pct + '%</td>' +
            '<td>' + (p.avg_latency != null ? p.avg_latency + 'ms' : '—') + '</td>' +
            '</tr>'
        }).join('')
        if (filtered.length > 25) {
          tbody.innerHTML += '<tr><td colspan="8" style="text-align:center;color:var(--text-muted);font-size:12px;padding:12px;">Showing 25 of ' + filtered.length + ' providers</td></tr>'
        }
      } else {
        thead.innerHTML = '<tr><th>#</th><th>Name</th><th>Provider</th><th>Protocol</th><th>Reliability</th><th></th><th>Latency</th><th>Health</th><th>Price</th></tr>'
        var filtered = endpointData
        if (currentProtocol) {
          filtered = endpointData.filter(function(e) { return e.protocol === currentProtocol })
        }
        var display = filtered.slice(0, 25)
        tbody.innerHTML = display.map(function(e, i) {
          var provider = '—'
          try { provider = new URL(e.url).hostname } catch(ex) {}
          var price = '—'
          if (e.price_usd != null) price = '$' + e.price_usd
          else if (e.price_sats != null) price = e.price_sats + ' sats'
          return '<tr>' +
            '<td class="rank">' + (i + 1) + '</td>' +
            '<td class="endpoint-name"><a href="/service/' + escapeH(e.id) + '">' + escapeH(e.name) + '</a></td>' +
            '<td class="provider-name">' + escapeH(provider) + '</td>' +
            '<td><span class="badge badge-' + escapeH(e.protocol.toLowerCase()) + '">' + escapeH(e.protocol) + '</span></td>' +
            '<td style="color:' + reliabilityColor(e.reliability_score) + '">' + e.reliability_score + '</td>' +
            '<td class="reliability-bar-cell">' + reliabilityBar(e.reliability_score) + '</td>' +
            '<td>' + (e.latency_p50_ms != null ? e.latency_p50_ms + 'ms' : '—') + '</td>' +
            '<td><span class="health-dot health-' + escapeH(e.health_status || 'unknown') + '"></span>' + escapeH(e.health_status || 'unknown') + '</td>' +
            '<td>' + price + '</td>' +
            '</tr>'
        }).join('')
        if (filtered.length > 25) {
          tbody.innerHTML += '<tr><td colspan="9" style="text-align:center;color:var(--text-muted);font-size:12px;padding:12px;">Showing 25 of ' + filtered.length + ' endpoints</td></tr>'
        }
      }
    }

    toggle.addEventListener('click', function(e) {
      var btn = e.target.closest('.stats-toggle-btn')
      if (!btn) return
      currentView = btn.getAttribute('data-view')
      toggle.querySelectorAll('.stats-toggle-btn').forEach(function(b) { b.classList.remove('stats-toggle-active') })
      btn.classList.add('stats-toggle-active')
      renderScoreboard()
    })

    protocolFilter.addEventListener('change', function() {
      currentProtocol = this.value
      renderScoreboard()
    })

    renderScoreboard()
  })()
  </script>`

  return layout('Stats', content, {
    description: 'Live reliability data, latency distributions, and category coverage across L402, x402, and MPP paid APIs.',
    ogUrl: 'https://402index.io/stats',
  })
}
