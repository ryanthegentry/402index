import { layout } from './layout.js'

function escapeHtml(str) {
  if (!str) return ''
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function healthDot(status) {
  return `<span class="health-dot health-${status}"></span>${status}`
}

function protocolBadge(protocol) {
  const cls = protocol === 'x402' ? 'badge-x402' : protocol === 'L402' ? 'badge-l402' : 'badge-both'
  return `<span class="badge ${cls}">${protocol}</span>`
}

function formatPrice(service) {
  if (service.price_usd != null) return `$${service.price_usd.toFixed(service.price_usd < 0.01 ? 4 : 2)}`
  if (service.price_sats != null) return `${service.price_sats} sats`
  return '—'
}

function formatSchema(json) {
  if (!json) return null
  try {
    return JSON.stringify(JSON.parse(json), null, 2)
  } catch {
    return json
  }
}

export function detailPage(service) {
  const healthRows = (service.health_checks || []).map(h => `
    <tr>
      <td>${h.checked_at}</td>
      <td>${healthDot(h.status)}</td>
      <td>${h.http_status || '—'}</td>
      <td>${h.response_time_ms != null ? h.response_time_ms + 'ms' : '—'}</td>
      <td style="color:var(--text-muted)">${escapeHtml(h.error_message || '')}</td>
    </tr>
  `).join('')

  const inputSchema = formatSchema(service.input_schema)
  const outputSchema = formatSchema(service.output_schema)

  return layout(escapeHtml(service.name), `
    <div class="container">
      <div class="detail-header">
        <p style="margin-bottom:12px"><a href="/">&larr; Back to directory</a></p>
        <h1>${escapeHtml(service.name)}</h1>
        <a href="${escapeHtml(service.url)}" class="detail-url" target="_blank">${escapeHtml(service.url)}</a>
      </div>

      <div class="detail-grid">
        <div class="detail-section">
          <h2>Overview</h2>
          ${service.description ? `<p style="margin-bottom:16px;line-height:1.6">${escapeHtml(service.description)}</p>` : ''}
          <div class="detail-row">
            <span class="detail-label">Protocol</span>
            <span class="detail-value">${protocolBadge(service.protocol)}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Price</span>
            <span class="detail-value">${formatPrice(service)}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Payment Asset</span>
            <span class="detail-value">${escapeHtml(service.payment_asset) || '—'}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Payment Network</span>
            <span class="detail-value">${escapeHtml(service.payment_network) || '—'}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Category</span>
            <span class="detail-value">${escapeHtml(service.category) || '—'}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Provider</span>
            <span class="detail-value">${escapeHtml(service.provider) || '—'}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Source</span>
            <span class="detail-value">${service.source}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Indexed</span>
            <span class="detail-value">${service.registered_at || '—'}</span>
          </div>
        </div>

        <div class="detail-section">
          <h2>Health</h2>
          <div class="detail-row">
            <span class="detail-label">Status</span>
            <span class="detail-value">${healthDot(service.health_status)}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Latency (p50)</span>
            <span class="detail-value">${service.latency_p50_ms != null ? service.latency_p50_ms + 'ms' : '—'}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Uptime (30d)</span>
            <span class="detail-value">${service.uptime_30d != null ? (service.uptime_30d * 100).toFixed(1) + '%' : '—'}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Last Checked</span>
            <span class="detail-value">${service.last_checked || 'Never'}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Last Healthy</span>
            <span class="detail-value">${service.last_seen_healthy || 'Never'}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Consecutive Failures</span>
            <span class="detail-value">${service.consecutive_failures}</span>
          </div>
        </div>
      </div>

      ${inputSchema ? `
      <div class="detail-section" style="margin-bottom:24px">
        <h2>Input Schema</h2>
        <div class="schema-block">${escapeHtml(inputSchema)}</div>
      </div>
      ` : ''}

      ${outputSchema ? `
      <div class="detail-section" style="margin-bottom:24px">
        <h2>Output Schema</h2>
        <div class="schema-block">${escapeHtml(outputSchema)}</div>
      </div>
      ` : ''}

      ${healthRows ? `
      <div class="detail-section" style="margin-bottom:24px">
        <h2>Recent Health Checks</h2>
        <table class="health-history">
          <thead>
            <tr>
              <th>Time</th>
              <th>Status</th>
              <th>HTTP</th>
              <th>Latency</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>${healthRows}</tbody>
        </table>
      </div>
      ` : ''}
    </div>
  `)
}
