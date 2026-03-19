import { layout } from './layout.js'
import { escapeHtml } from './helpers.js'

export function statsPage({ scoreboard, latency, categoryGap }) {
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
      <div class="table-wrap">
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
      <div class="stats-chart-container">
        <canvas id="latency-chart" height="300"></canvas>
      </div>
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

  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
  <script>
  (function() {
    // ─── Scoreboard ─────────────────────────────────────────────────────
    var providerData = ${JSON.stringify(scoreboard.providers)}
    var endpointData = ${JSON.stringify(scoreboard.endpoints)}
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
        return '<span class="badge badge-' + p.toLowerCase() + '">' + p + '</span>'
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
        tbody.innerHTML = filtered.map(function(p, i) {
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
      } else {
        thead.innerHTML = '<tr><th>#</th><th>Name</th><th>Provider</th><th>Protocol</th><th>Reliability</th><th></th><th>Latency</th><th>Health</th><th>Price</th></tr>'
        var filtered = endpointData
        if (currentProtocol) {
          filtered = endpointData.filter(function(e) { return e.protocol === currentProtocol })
        }
        tbody.innerHTML = filtered.map(function(e, i) {
          var provider = '—'
          try { provider = new URL(e.url).hostname } catch(ex) {}
          var price = '—'
          if (e.price_usd != null) price = '$' + e.price_usd
          else if (e.price_sats != null) price = e.price_sats + ' sats'
          return '<tr>' +
            '<td class="rank">' + (i + 1) + '</td>' +
            '<td class="endpoint-name"><a href="/service/' + escapeH(e.id) + '">' + escapeH(e.name) + '</a></td>' +
            '<td class="provider-name">' + escapeH(provider) + '</td>' +
            '<td><span class="badge badge-' + e.protocol.toLowerCase() + '">' + e.protocol + '</span></td>' +
            '<td style="color:' + reliabilityColor(e.reliability_score) + '">' + e.reliability_score + '</td>' +
            '<td class="reliability-bar-cell">' + reliabilityBar(e.reliability_score) + '</td>' +
            '<td>' + (e.latency_p50_ms != null ? e.latency_p50_ms + 'ms' : '—') + '</td>' +
            '<td><span class="health-dot health-' + (e.health_status || 'unknown') + '"></span>' + (e.health_status || 'unknown') + '</td>' +
            '<td>' + price + '</td>' +
            '</tr>'
        }).join('')
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

    // ─── Latency Chart ──────────────────────────────────────────────────
    var latencyData = ${JSON.stringify(latency.buckets)}
    var ctx = document.getElementById('latency-chart')
    if (ctx && typeof Chart !== 'undefined') {
      new Chart(ctx, {
        type: 'bar',
        data: {
          labels: latencyData.map(function(b) { return b.label }),
          datasets: [
            {
              label: 'L402',
              data: latencyData.map(function(b) { return b.L402 }),
              backgroundColor: 'rgba(247, 147, 26, 0.8)',
              borderColor: '#F7931A',
              borderWidth: 1,
            },
            {
              label: 'x402',
              data: latencyData.map(function(b) { return b.x402 }),
              backgroundColor: 'rgba(0, 82, 255, 0.8)',
              borderColor: '#0052FF',
              borderWidth: 1,
            },
            {
              label: 'MPP',
              data: latencyData.map(function(b) { return b.MPP }),
              backgroundColor: 'rgba(16, 185, 129, 0.8)',
              borderColor: '#10b981',
              borderWidth: 1,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              labels: { color: '#c9cdd6', font: { family: "'SF Mono', monospace" } }
            }
          },
          scales: {
            x: {
              stacked: true,
              ticks: { color: '#6b7080' },
              grid: { color: 'rgba(42,45,55,0.5)' }
            },
            y: {
              stacked: true,
              ticks: { color: '#6b7080' },
              grid: { color: 'rgba(42,45,55,0.5)' },
              title: { display: true, text: 'Endpoints', color: '#6b7080' }
            }
          }
        }
      })
    }
  })()
  </script>`

  return layout('Stats', content, {
    description: 'Live reliability data, latency distributions, and category coverage across L402, x402, and MPP paid APIs.',
    ogUrl: 'https://402index.io/stats',
  })
}
