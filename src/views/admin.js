import { layout } from './layout.js'

export function adminPage() {
  return layout('Admin', `
    <div class="container">
      <div class="admin-content">
        <div id="auth-gate">
          <h1>402index Admin</h1>
          <p style="color:var(--text-muted);margin:12px 0 24px">Enter your admin secret to continue.</p>
          <form id="auth-form" style="display:flex;gap:12px;max-width:480px">
            <input type="password" id="secret-input" placeholder="Enter admin secret"
              style="flex:1;padding:10px 14px;background:var(--bg-surface);border:1px solid var(--border);border-radius:6px;color:var(--text-bright);font-size:14px;font-family:var(--sans)" />
            <button type="submit"
              style="padding:10px 20px;background:var(--accent);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;font-family:var(--sans)">Submit</button>
          </form>
          <p id="auth-error" style="color:var(--red);margin-top:12px;display:none"></p>
        </div>

        <div id="dashboard" style="display:none">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px">
            <h1>402index Admin</h1>
            <button id="logout-btn" style="padding:6px 14px;background:transparent;border:1px solid var(--border);border-radius:6px;color:var(--text-muted);cursor:pointer;font-size:13px;font-family:var(--sans)">Logout</button>
          </div>

          <div id="toast" style="display:none;position:fixed;top:20px;right:20px;padding:12px 20px;border-radius:6px;font-size:13px;z-index:100"></div>

          <!-- Tab bar -->
          <div class="tab-bar" role="tablist">
            <button class="tab active" data-tab="pending" role="tab">Pending <span id="pending-count" class="tab-count"></span></button>
            <button class="tab" data-tab="recent" role="tab">Recent</button>
            <button class="tab" data-tab="search" role="tab">Search</button>
            <button class="tab" data-tab="traffic" role="tab">Traffic</button>
          </div>

          <!-- Pending panel -->
          <div id="panel-pending" class="tab-panel">
            <div id="pending-list"></div>
          </div>

          <!-- Recent panel -->
          <div id="panel-recent" class="tab-panel" style="display:none">
            <div id="recent-list"></div>
          </div>

          <!-- Search panel -->
          <div id="panel-search" class="tab-panel" style="display:none">
            <form id="search-form" style="display:flex;gap:10px;margin-bottom:20px">
              <input type="text" id="search-input" placeholder="Search by name, URL, provider, or category"
                style="flex:1;padding:10px 14px;background:var(--bg-surface);border:1px solid var(--border);border-radius:6px;color:var(--text-bright);font-size:14px;font-family:var(--sans)" />
              <button type="submit"
                style="padding:10px 20px;background:var(--accent);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;font-family:var(--sans)">Search</button>
            </form>
            <div id="search-results">
              <div class="empty-state" style="padding:40px 20px">Enter a term to search across all endpoints.</div>
            </div>
          </div>

          <!-- Traffic panel -->
          <div id="panel-traffic" class="tab-panel" style="display:none">
            <div id="traffic-content">
              <div class="empty-state">Loading traffic data...</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <style>
      .admin-content { padding: 32px 0; }

      /* Tab bar */
      .tab-bar {
        display: flex;
        gap: 4px;
        border-bottom: 1px solid var(--border);
        margin-bottom: 24px;
      }
      .tab {
        padding: 8px 18px;
        background: transparent;
        border: none;
        border-bottom: 2px solid transparent;
        margin-bottom: -1px;
        color: var(--text-muted);
        font-size: 14px;
        font-family: var(--sans);
        font-weight: 500;
        cursor: pointer;
        transition: color 0.15s, border-color 0.15s;
      }
      .tab:hover { color: var(--text); }
      .tab.active { color: var(--accent); border-bottom-color: var(--accent); }
      .tab-count {
        display: inline-block;
        background: rgba(124,138,255,0.15);
        color: var(--accent);
        font-size: 11px;
        padding: 1px 6px;
        border-radius: 10px;
        margin-left: 4px;
        font-weight: 600;
      }

      /* Cards */
      .reg-card {
        background: var(--bg-surface);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 20px;
        margin-bottom: 16px;
      }
      .reg-card-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 12px;
      }
      .reg-card-title {
        font-size: 16px;
        font-weight: 600;
        color: var(--text-bright);
      }
      .reg-card-url {
        font-family: var(--mono);
        font-size: 12px;
        color: var(--accent);
        word-break: break-all;
      }
      .reg-card-meta {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
        gap: 8px 20px;
        font-size: 13px;
        color: var(--text-muted);
        margin-bottom: 16px;
      }
      .reg-card-meta strong { color: var(--text); }
      .reg-card-verify {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        font-size: 12px;
        font-family: var(--mono);
        margin-bottom: 16px;
      }
      .verify-tag {
        padding: 3px 8px;
        border-radius: 4px;
        background: rgba(124,138,255,0.1);
        color: var(--accent);
      }
      .verify-tag.ok { background: rgba(52,211,153,0.1); color: var(--green); }
      .verify-tag.warn { background: rgba(251,191,36,0.1); color: var(--yellow); }
      .reg-card-actions { display: flex; gap: 10px; align-items: center; }
      .btn-approve, .btn-reject, .btn-delete {
        padding: 8px 18px;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        font-size: 13px;
        font-family: var(--sans);
        font-weight: 500;
      }
      .btn-approve { background: var(--green); color: #0f1117; }
      .btn-approve:hover { opacity: 0.85; }
      .btn-reject { background: var(--red); color: #fff; }
      .btn-reject:hover { opacity: 0.85; }
      .btn-delete { background: transparent; border: 1px solid var(--red); color: var(--red); }
      .btn-delete:hover { background: var(--red); color: #fff; }
      .btn-approve:disabled, .btn-reject:disabled, .btn-delete:disabled { opacity: 0.4; cursor: not-allowed; }

      /* Status badge */
      .status-badge {
        display: inline-block;
        padding: 3px 10px;
        border-radius: 12px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        white-space: nowrap;
      }
      .status-badge.active { background: rgba(52,211,153,0.15); color: var(--green); }
      .status-badge.pending { background: rgba(251,191,36,0.15); color: var(--yellow); }
      .status-badge.rejected { background: rgba(255,90,90,0.12); color: var(--red); }
      .status-badge.unknown { background: rgba(124,138,255,0.1); color: var(--text-muted); }

      .empty-state {
        text-align: center;
        padding: 60px 20px;
        color: var(--text-muted);
        font-size: 15px;
      }

      /* Traffic dashboard */
      .traffic-cards {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
        gap: 12px;
        margin-bottom: 24px;
      }
      .traffic-card {
        background: var(--bg-surface);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 16px;
      }
      .traffic-card-value {
        font-size: 28px;
        font-weight: 700;
        color: var(--text-bright);
      }
      .traffic-card-label {
        font-size: 13px;
        color: var(--text-muted);
        margin-top: 4px;
      }
      .traffic-bars {
        display: flex;
        align-items: flex-end;
        gap: 2px;
        height: 120px;
        padding: 0;
      }
      .traffic-bar-col {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        height: 100%;
        justify-content: flex-end;
      }
      .traffic-bar {
        width: 100%;
        background: var(--accent);
        border-radius: 2px 2px 0 0;
        min-height: 2px;
        position: relative;
      }
      .traffic-bar-mcp {
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        background: var(--green);
        border-radius: 0 0 0 0;
      }
      .traffic-bar-label {
        font-size: 9px;
        color: var(--text-muted);
        margin-top: 4px;
        white-space: nowrap;
      }
      .admin-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
      }
      .admin-table th {
        text-align: left;
        padding: 8px 12px;
        border-bottom: 1px solid var(--border);
        color: var(--text-muted);
        font-weight: 500;
      }
      .admin-table td {
        padding: 8px 12px;
        border-bottom: 1px solid rgba(255,255,255,0.04);
        color: var(--text);
      }
    </style>

    <script>
    var API = '/api/v1'

    function getSecret() { return sessionStorage.getItem('admin_secret') }
    function setSecret(s) { sessionStorage.setItem('admin_secret', s) }
    function clearSecret() { sessionStorage.removeItem('admin_secret') }

    async function apiFetch(path, opts) {
      opts = opts || {}
      var secret = getSecret()
      var res = await fetch(API + path, Object.assign({}, opts, {
        headers: Object.assign({}, opts.headers || {}, { 'Authorization': 'Bearer ' + secret }),
      }))
      if (res.status === 401) {
        clearSecret()
        showAuth()
        return null
      }
      return res
    }

    function showAuth() {
      document.getElementById('auth-gate').style.display = ''
      document.getElementById('dashboard').style.display = 'none'
    }

    function showDashboard() {
      document.getElementById('auth-gate').style.display = 'none'
      document.getElementById('dashboard').style.display = ''
    }

    function logout() {
      clearSecret()
      showAuth()
    }

    function toast(msg, ok) {
      var el = document.getElementById('toast')
      el.textContent = msg
      el.style.display = ''
      el.style.background = ok ? 'var(--green)' : 'var(--red)'
      el.style.color = ok ? '#0f1117' : '#fff'
      setTimeout(function() { el.style.display = 'none' }, 2500)
    }

    function escHtml(s) {
      if (!s) return ''
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
    }

    // ─── Tab switching ──────────────────────────────────────────────────────

    var tabLoaded = { pending: false, recent: false, traffic: false }

    function switchTab(name) {
      document.querySelectorAll('.tab').forEach(function(t) {
        t.classList.toggle('active', t.dataset.tab === name)
      })
      document.querySelectorAll('.tab-panel').forEach(function(p) {
        p.style.display = p.id === 'panel-' + name ? '' : 'none'
      })
      if (name === 'recent' && !tabLoaded.recent) {
        loadRecent()
        tabLoaded.recent = true
      }
      if (name === 'traffic' && !tabLoaded.traffic) {
        loadTraffic()
        tabLoaded.traffic = true
      }
    }

    document.querySelectorAll('.tab').forEach(function(btn) {
      btn.addEventListener('click', function() { switchTab(btn.dataset.tab) })
    })

    // ─── Pending card renderer (approve/reject) ──────────────────────────────

    function renderPendingCard(s) {
      var price = '—'
      if (s.price_usd != null) price = '$' + Number(s.price_usd).toFixed(4)
      else if (s.price_sats != null) price = s.price_sats + ' sats'
      var date = s.registered_at ? new Date(s.registered_at + (s.registered_at.endsWith('Z') ? '' : 'Z')).toLocaleDateString() : '—'
      return '<div class="reg-card" id="card-' + escHtml(s.id) + '">'
        + '<div class="reg-card-header"><div>'
        + '<div class="reg-card-title">' + escHtml(s.name) + '</div>'
        + '<a class="reg-card-url" href="' + escHtml(s.url) + '" target="_blank" rel="noopener">' + escHtml(s.url) + '</a>'
        + '</div></div>'
        + '<div class="reg-card-meta">'
        + '<div><strong>Protocol:</strong> ' + escHtml(s.protocol) + '</div>'
        + '<div><strong>Provider:</strong> ' + escHtml(s.provider || '—') + '</div>'
        + '<div><strong>Category:</strong> ' + escHtml(s.category || '—') + '</div>'
        + '<div><strong>Price:</strong> ' + price + '</div>'
        + '<div><strong>Asset:</strong> ' + escHtml(s.payment_asset || '—') + '</div>'
        + '<div><strong>Network:</strong> ' + escHtml(s.payment_network || '—') + '</div>'
        + '<div><strong>Contact:</strong> ' + escHtml(s.contact_email || '—') + '</div>'
        + '<div><strong>Registered:</strong> ' + date + '</div>'
        + '</div>'
        + '<div class="reg-card-verify">'
        + '<span class="verify-tag ok">HTTP ' + (s.health_status === 'healthy' ? '402' : '?') + '</span>'
        + '<span class="verify-tag' + (s.verified ? ' ok' : '') + '">verified: ' + (s.verified ? 'yes' : 'no') + '</span>'
        + '</div>'
        + '<div class="reg-card-actions">'
        + '<button class="btn-approve" data-id="' + escHtml(s.id) + '">Approve</button>'
        + '<button class="btn-reject" data-id="' + escHtml(s.id) + '" data-name="' + escHtml(s.name) + '">Reject</button>'
        + '</div></div>'
    }

    // ─── Manage card renderer (status badge + delete) ────────────────────────

    function renderManageCard(s) {
      var price = '—'
      if (s.price_usd != null) price = '$' + Number(s.price_usd).toFixed(4)
      else if (s.price_sats != null) price = s.price_sats + ' sats'
      var date = s.registered_at ? new Date(s.registered_at + (s.registered_at.endsWith('Z') ? '' : 'Z')).toLocaleDateString() : '—'
      var status = s.status || 'unknown'
      var badgeClass = ['active','pending','rejected'].includes(status) ? status : 'unknown'
      return '<div class="reg-card" id="card-' + escHtml(s.id) + '">'
        + '<div class="reg-card-header">'
        + '<div>'
        + '<div class="reg-card-title">' + escHtml(s.name) + '</div>'
        + '<a class="reg-card-url" href="' + escHtml(s.url) + '" target="_blank" rel="noopener">' + escHtml(s.url) + '</a>'
        + '</div>'
        + '<span class="status-badge ' + badgeClass + '">' + escHtml(status) + '</span>'
        + '</div>'
        + '<div class="reg-card-meta">'
        + '<div><strong>Protocol:</strong> ' + escHtml(s.protocol) + '</div>'
        + '<div><strong>Provider:</strong> ' + escHtml(s.provider || '—') + '</div>'
        + '<div><strong>Category:</strong> ' + escHtml(s.category || '—') + '</div>'
        + '<div><strong>Price:</strong> ' + price + '</div>'
        + '<div><strong>Asset:</strong> ' + escHtml(s.payment_asset || '—') + '</div>'
        + '<div><strong>Network:</strong> ' + escHtml(s.payment_network || '—') + '</div>'
        + '<div><strong>Contact:</strong> ' + escHtml(s.contact_email || '—') + '</div>'
        + '<div><strong>Registered:</strong> ' + date + '</div>'
        + '</div>'
        + '<div class="reg-card-verify">'
        + '<span class="verify-tag' + (s.health_status === 'healthy' ? ' ok' : '') + '">'
        + escHtml(s.health_status || 'unknown') + '</span>'
        + '<span class="verify-tag' + (s.verified ? ' ok' : '') + '">verified: ' + (s.verified ? 'yes' : 'no') + '</span>'
        + '</div>'
        + '<div class="reg-card-actions" style="justify-content:flex-end">'
        + '<button class="btn-delete" data-id="' + escHtml(s.id) + '" data-name="' + escHtml(s.name) + '">Delete</button>'
        + '</div></div>'
    }

    // ─── Load pending ────────────────────────────────────────────────────────

    async function loadPending() {
      var res = await apiFetch('/admin/pending')
      if (!res) return
      var data = await res.json()
      var list = document.getElementById('pending-list')
      var count = document.getElementById('pending-count')
      count.textContent = data.total
      if (data.services.length === 0) {
        list.innerHTML = '<div class="empty-state">No pending registrations. You are all caught up.</div>'
        return
      }
      list.innerHTML = data.services.map(renderPendingCard).join('')
    }

    // ─── Load recent ─────────────────────────────────────────────────────────

    async function loadRecent() {
      var list = document.getElementById('recent-list')
      list.innerHTML = '<div class="empty-state">Loading...</div>'
      var res = await apiFetch('/admin/recent?limit=50')
      if (!res) return
      var data = await res.json()
      if (data.services.length === 0) {
        list.innerHTML = '<div class="empty-state">No registered services yet.</div>'
        return
      }
      list.innerHTML = data.services.map(renderManageCard).join('')
    }

    // ─── Search ──────────────────────────────────────────────────────────────

    document.getElementById('search-form').addEventListener('submit', async function(e) {
      e.preventDefault()
      var q = document.getElementById('search-input').value.trim()
      if (!q) return
      var results = document.getElementById('search-results')
      results.innerHTML = '<div class="empty-state">Searching...</div>'
      var res = await apiFetch('/admin/search?q=' + encodeURIComponent(q) + '&limit=50')
      if (!res) return
      var data = await res.json()
      if (data.services.length === 0) {
        results.innerHTML = '<div class="empty-state">No results for \u201c' + escHtml(q) + '\u201d.</div>'
        return
      }
      results.innerHTML = data.services.map(renderManageCard).join('')
    })

    // ─── Approve / Reject (pending panel) ───────────────────────────────────

    async function approveService(id, btn) {
      btn.disabled = true
      var res = await apiFetch('/admin/approve/' + id, { method: 'POST' })
      if (!res) return
      if (res.ok) {
        document.getElementById('card-' + id).remove()
        toast('Service approved', true)
        updatePendingCount(-1)
      } else {
        var body = await res.json().catch(function() { return {} })
        toast(body.error || 'Approve failed', false)
        btn.disabled = false
      }
    }

    async function rejectService(id, name, btn) {
      if (!confirm('Reject \u201c' + name + '\u201d?')) return
      btn.disabled = true
      var res = await apiFetch('/admin/reject/' + id, { method: 'POST' })
      if (!res) return
      if (res.ok) {
        document.getElementById('card-' + id).remove()
        toast('Service rejected', true)
        updatePendingCount(-1)
      } else {
        var body = await res.json().catch(function() { return {} })
        toast(body.error || 'Reject failed', false)
        btn.disabled = false
      }
    }

    function updatePendingCount(delta) {
      var el = document.getElementById('pending-count')
      var n = Math.max(0, (parseInt(el.textContent) || 0) + delta)
      el.textContent = n
      if (n === 0) {
        document.getElementById('pending-list').innerHTML =
          '<div class="empty-state">No pending registrations. You are all caught up.</div>'
      }
    }

    // ─── Delete (recent + search panels) ────────────────────────────────────

    async function deleteService(id, name, btn) {
      if (!confirm('Delete \u201c' + name + '\u201d? This cannot be undone.')) return
      btn.disabled = true
      var res = await apiFetch('/admin/services/' + id, { method: 'DELETE' })
      if (!res) return
      if (res.ok) {
        var card = document.getElementById('card-' + id)
        if (card) card.remove()
        toast('Deleted', true)
      } else {
        var body = await res.json().catch(function() { return {} })
        toast(body.error || 'Delete failed', false)
        btn.disabled = false
      }
    }

    // ─── Event delegation ────────────────────────────────────────────────────

    document.getElementById('dashboard').addEventListener('click', function(e) {
      var btn = e.target.closest('.btn-approve, .btn-reject, .btn-delete')
      if (!btn) return
      if (btn.classList.contains('btn-approve')) {
        approveService(btn.dataset.id, btn)
      } else if (btn.classList.contains('btn-reject')) {
        rejectService(btn.dataset.id, btn.dataset.name, btn)
      } else if (btn.classList.contains('btn-delete')) {
        deleteService(btn.dataset.id, btn.dataset.name, btn)
      }
    })

    // ─── Traffic ───────────────────────────────────────────────────────────

    function classifyAgent(ua) {
      if (!ua) return 'API'
      if (ua.includes('402index-mcp')) return 'MCP'
      if (ua.includes('bot') || ua.includes('crawler') || ua.includes('Bot')) return 'Bot'
      if (ua.includes('Mozilla')) return 'Browser'
      return 'API'
    }

    function agentBadge(type) {
      var colors = { MCP: 'var(--green)', Browser: 'var(--accent)', Bot: 'var(--yellow)', API: 'var(--text-muted)' }
      return '<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;background:rgba(124,138,255,0.1);color:' + (colors[type] || 'var(--text-muted)') + '">' + type + '</span>'
    }

    async function loadTraffic() {
      var el = document.getElementById('traffic-content')
      el.innerHTML = '<div class="empty-state">Loading traffic data...</div>'
      var res = await apiFetch('/admin/traffic')
      if (!res) return
      if (!res.ok) {
        el.innerHTML = '<div class="empty-state">Failed to load traffic data.</div>'
        return
      }
      var d = await res.json()
      var html = ''

      // Summary cards
      html += '<div class="traffic-cards">'
      html += '<div class="traffic-card"><div class="traffic-card-value">' + (d.summary.today || 0) + '</div><div class="traffic-card-label">Queries today</div></div>'
      html += '<div class="traffic-card"><div class="traffic-card-value">' + (d.summary.week || 0) + '</div><div class="traffic-card-label">Queries (7 days)</div></div>'
      html += '<div class="traffic-card"><div class="traffic-card-value">' + (d.summary.uniqueAgentsToday || 0) + '</div><div class="traffic-card-label">Unique agents today</div></div>'
      html += '<div class="traffic-card"><div class="traffic-card-value">' + (d.summary.mcpToday || 0) + '</div><div class="traffic-card-label">MCP queries today</div></div>'
      html += '</div>'

      // Queries per hour (CSS bar chart)
      if (d.hourly && d.hourly.length > 0) {
        var maxH = Math.max.apply(null, d.hourly.map(function(h) { return h.total })) || 1
        html += '<h3 style="margin:24px 0 12px">Queries Per Hour (24h)</h3>'
        html += '<div class="traffic-bars">'
        for (var i = 0; i < d.hourly.length; i++) {
          var h = d.hourly[i]
          var pct = Math.round((h.total / maxH) * 100)
          var mcpPct = h.total > 0 ? Math.round((h.mcp_count / h.total) * 100) : 0
          var label = h.hour.split(' ')[1] || h.hour
          html += '<div class="traffic-bar-col" title="' + h.hour + ': ' + h.total + ' total, ' + h.mcp_count + ' MCP">'
          html += '<div class="traffic-bar" style="height:' + pct + '%">'
          if (mcpPct > 0) html += '<div class="traffic-bar-mcp" style="height:' + mcpPct + '%"></div>'
          html += '</div>'
          html += '<div class="traffic-bar-label">' + label + '</div>'
          html += '</div>'
        }
        html += '</div>'
        html += '<div style="font-size:11px;color:var(--text-muted);margin-top:4px"><span style="display:inline-block;width:8px;height:8px;background:var(--accent);border-radius:2px;margin-right:4px"></span>Browser/API <span style="display:inline-block;width:8px;height:8px;background:var(--green);border-radius:2px;margin:0 4px 0 12px"></span>MCP</div>'
      }

      // MCP summary
      if (d.mcpSummary) {
        var m = d.mcpSummary
        html += '<h3 style="margin:24px 0 12px">MCP Server Traffic</h3>'
        html += '<div class="traffic-card" style="max-width:480px"><div class="traffic-card-label">'
        html += m.total + ' total queries &middot; ' + m.activeDays + ' active days'
        if (m.firstSeen) html += ' &middot; First seen: ' + m.firstSeen.split('T')[0]
        if (m.lastSeen) html += ' &middot; Last: ' + m.lastSeen.split('T')[0]
        html += '</div></div>'
      }

      // Top search terms
      if (d.topSearches && d.topSearches.length > 0) {
        html += '<h3 style="margin:24px 0 12px">Top Search Terms (7 days)</h3>'
        html += '<table class="admin-table"><thead><tr><th>Search Term</th><th>Count</th></tr></thead><tbody>'
        for (var j = 0; j < d.topSearches.length; j++) {
          html += '<tr><td>' + escHtml(d.topSearches[j].query_text) + '</td><td>' + d.topSearches[j].count + '</td></tr>'
        }
        html += '</tbody></table>'
      }

      // Top user-agents
      if (d.topAgents && d.topAgents.length > 0) {
        html += '<h3 style="margin:24px 0 12px">Top User-Agents (7 days)</h3>'
        html += '<table class="admin-table"><thead><tr><th>User-Agent</th><th>Count</th><th>Type</th></tr></thead><tbody>'
        for (var k = 0; k < d.topAgents.length; k++) {
          var a = d.topAgents[k]
          html += '<tr><td style="max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(a.user_agent || '(empty)') + '</td><td>' + a.count + '</td><td>' + agentBadge(classifyAgent(a.user_agent)) + '</td></tr>'
        }
        html += '</tbody></table>'
      }

      // Zero-result searches
      if (d.zeroResults && d.zeroResults.length > 0) {
        html += '<h3 style="margin:24px 0 12px">Zero-Result Searches (7 days)</h3>'
        html += '<p style="font-size:13px;color:var(--text-muted);margin-bottom:8px">Unmet demand — what people search for but do not find.</p>'
        html += '<table class="admin-table"><thead><tr><th>Search Term</th><th>Filters</th><th>Count</th></tr></thead><tbody>'
        for (var z = 0; z < d.zeroResults.length; z++) {
          var zr = d.zeroResults[z]
          html += '<tr><td>' + escHtml(zr.query_text) + '</td><td style="font-size:12px;color:var(--text-muted)">' + escHtml(zr.filters || '—') + '</td><td>' + zr.count + '</td></tr>'
        }
        html += '</tbody></table>'
      }

      el.innerHTML = html || '<div class="empty-state">No traffic data yet.</div>'
    }

    // ─── Auth ────────────────────────────────────────────────────────────────

    document.getElementById('auth-form').addEventListener('submit', async function(e) {
      e.preventDefault()
      var secret = document.getElementById('secret-input').value.trim()
      if (!secret) return
      setSecret(secret)
      var res = await apiFetch('/admin/pending')
      if (!res) {
        document.getElementById('auth-error').textContent = 'Invalid secret'
        document.getElementById('auth-error').style.display = ''
        return
      }
      document.getElementById('auth-error').style.display = 'none'
      showDashboard()
      loadPending()
    })

    document.getElementById('logout-btn').addEventListener('click', logout)

    // Auto-login if secret in sessionStorage
    if (getSecret()) {
      showDashboard()
      loadPending()
    }
    </script>
  `)
}
