import { layout } from './layout.js'
import { escapeHtml, healthDot, protocolBadge, formatPrice } from './helpers.js'

export function homePage({ services, total, limit, offset, filters, stats, categories }) {
  const currentPage = Math.floor(offset / limit) + 1
  const totalPages = Math.ceil(total / limit)

  const rows = services.map(s => `
    <tr onclick="location.href='/service/${s.id}'">
      <td>
        <span class="svc-name">${escapeHtml(s.name)}</span>
        <span class="svc-url">${escapeHtml(s.url)}</span>
      </td>
      <td>${protocolBadge(s.protocol)}</td>
      <td class="price">${formatPrice(s)}</td>
      <td>${s.category ? `<span class="category-tag">${escapeHtml(s.category)}</span>` : '<span style="color:var(--text-muted)">—</span>'}</td>
      <td>${healthDot(s.health_status)}</td>
      <td class="latency">${s.latency_p50_ms != null ? s.latency_p50_ms + 'ms' : '—'}</td>
      <td><span class="source-tag">${s.source}</span></td>
    </tr>
  `).join('')

  const catOptions = categories.map(c =>
    `<option value="${escapeHtml(c.category)}"${filters.category === c.category ? ' selected' : ''}>${escapeHtml(c.category)} (${c.count})</option>`
  ).join('')

  const hasFilters = filters.protocol || filters.category || filters.health || filters.source || filters.q || filters.featured

  const prevOffset = Math.max(0, offset - limit)
  const nextOffset = offset + limit

  const l402 = stats.l402Providers || 0
  const x402 = stats.x402Providers || 0
  const l402Pct = (l402 + x402) > 0 ? Math.round((l402 / (l402 + x402)) * 100) : 0

  const protocolBar = (l402 > 0 && x402 > 0) ? `
    <div class="protocol-bar">
      <div class="container">
        <span class="protocol-l402">L402 <strong>${l402}</strong></span>
        <div class="protocol-track">
          <div class="protocol-fill-l402" style="width: ${l402Pct}%"></div>
        </div>
        <span class="protocol-x402">x402 <strong>${x402}</strong></span>
      </div>
    </div>` : ''

  return layout('Directory', `
    <div class="stats-bar">
      <div class="container">
        <span><span class="stat-value">${stats.total.toLocaleString()}</span> endpoints</span>
        <span><span class="stat-value">${stats.distinctServices?.toLocaleString() || '—'}</span> services</span>
        <span><span class="stat-value">${stats.distinctProviders?.toLocaleString() || '—'}</span> providers</span>
        <span><span class="stat-value" style="color:var(--green)">${stats.healthy}</span> healthy</span>
        <span><span class="stat-value" style="color:var(--yellow)">${stats.degraded}</span> degraded</span>
        <span><span class="stat-value" style="color:var(--red)">${stats.down}</span> down</span>
      </div>
    </div>
    ${protocolBar}
    <div class="container">
      <div class="filters">
        <form method="get" action="/"${hasFilters ? ' class="filters-open"' : ''}>
          <select name="protocol" onchange="this.form.submit()">
            <option value="">All protocols</option>
            <option value="x402"${filters.protocol === 'x402' ? ' selected' : ''}>x402</option>
            <option value="L402"${filters.protocol === 'L402' ? ' selected' : ''}>L402</option>
          </select>
          <select name="category" onchange="this.form.submit()">
            <option value="">All categories</option>
            ${catOptions}
          </select>
          <select name="health" onchange="this.form.submit()">
            <option value="">All health</option>
            <option value="healthy"${filters.health === 'healthy' ? ' selected' : ''}>Healthy</option>
            <option value="degraded"${filters.health === 'degraded' ? ' selected' : ''}>Degraded</option>
            <option value="down"${filters.health === 'down' ? ' selected' : ''}>Down</option>
            <option value="unknown"${filters.health === 'unknown' ? ' selected' : ''}>Unknown</option>
          </select>
          <select name="source" onchange="this.form.submit()">
            <option value="">All sources</option>
            <option value="exclusive"${filters.source === 'exclusive' ? ' selected' : ''}>Exclusive</option>
            <option value="satring"${filters.source === 'satring' ? ' selected' : ''}>Satring</option>
            <option value="bazaar"${filters.source === 'bazaar' ? ' selected' : ''}>Bazaar</option>
            <option value="l402apps"${filters.source === 'l402apps' ? ' selected' : ''}>L402 Apps</option>
          </select>
          <input type="text" name="q" placeholder="Search name or description..." value="${escapeHtml(filters.q || '')}">
          <button type="button" class="filter-toggle" onclick="this.form.classList.toggle('filters-open')">Filters ▾</button>
          <label><input type="checkbox" name="featured" value="true"${filters.featured ? ' checked' : ''} onchange="this.form.submit()"> Featured only</label>
          <button type="submit" class="filter-btn">Filter</button>
          ${hasFilters ? '<a href="/" class="filter-clear">Clear</a>' : ''}
        </form>
      </div>
      <div class="table-wrap">
      <table class="services-table">
        <thead>
          <tr>
            <th>Service</th>
            <th>Protocol</th>
            <th>Price</th>
            <th>Category</th>
            <th>Health</th>
            <th>Latency</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          ${services.length === 0 ? '<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--text-muted)">No services found</td></tr>' : rows}
        </tbody>
      </table>
      </div>
      <div class="pagination">
        <span>Showing ${offset + 1}–${Math.min(offset + limit, total)} of ${total}</span>
        <span>
          ${offset > 0 ? `<a href="/?${buildQuery(filters, { offset: prevOffset, limit })}">Prev</a>` : ''}
          Page ${currentPage} of ${totalPages}
          ${nextOffset < total ? `<a href="/?${buildQuery(filters, { offset: nextOffset, limit })}">Next</a>` : ''}
        </span>
      </div>
    </div>
  `)
}

function buildQuery(filters, pagination) {
  const params = new URLSearchParams()
  if (filters.protocol) params.set('protocol', filters.protocol)
  if (filters.category) params.set('category', filters.category)
  if (filters.health) params.set('health', filters.health)
  if (filters.source) params.set('source', filters.source)
  if (filters.q) params.set('q', filters.q)
  if (filters.featured) params.set('featured', 'true')
  params.set('offset', pagination.offset)
  params.set('limit', pagination.limit)
  return params.toString()
}
