import { layout } from './layout.js'

export function adminPage() {
  return layout('Admin', `
    <div class="container">
      <div class="admin-content">
        <div id="auth-gate">
          <h1>402index Admin</h1>
          <p style="color:var(--text-muted);margin:12px 0 24px">Enter your admin secret to review pending registrations.</p>
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
            <h1>402index Admin <span id="pending-count" style="font-size:16px;color:var(--text-muted);font-weight:400"></span></h1>
            <button onclick="logout()" style="padding:6px 14px;background:transparent;border:1px solid var(--border);border-radius:6px;color:var(--text-muted);cursor:pointer;font-size:13px;font-family:var(--sans)">Logout</button>
          </div>
          <div id="toast" style="display:none;position:fixed;top:20px;right:20px;padding:12px 20px;border-radius:6px;font-size:13px;z-index:100"></div>
          <div id="pending-list"></div>
        </div>
      </div>
    </div>
    <style>
      .admin-content { padding: 32px 0; }
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
      .reg-card-actions { display: flex; gap: 10px; }
      .btn-approve, .btn-reject {
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
      .btn-approve:disabled, .btn-reject:disabled { opacity: 0.4; cursor: not-allowed; }
      .empty-state {
        text-align: center;
        padding: 60px 20px;
        color: var(--text-muted);
        font-size: 15px;
      }
    </style>
    <script>
    const API = '/api/v1'

    function getSecret() { return sessionStorage.getItem('admin_secret') }
    function setSecret(s) { sessionStorage.setItem('admin_secret', s) }
    function clearSecret() { sessionStorage.removeItem('admin_secret') }

    async function apiFetch(path, opts = {}) {
      const secret = getSecret()
      const res = await fetch(API + path, {
        ...opts,
        headers: { ...opts.headers, 'Authorization': 'Bearer ' + secret },
      })
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
      const el = document.getElementById('toast')
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

    function renderCard(s) {
      var price = '—'
      if (s.price_usd != null) price = '$' + Number(s.price_usd).toFixed(4)
      else if (s.price_sats != null) price = s.price_sats + ' sats'

      var date = s.registered_at ? new Date(s.registered_at + (s.registered_at.endsWith('Z') ? '' : 'Z')).toLocaleDateString() : '—'

      return '<div class="reg-card" id="card-' + escHtml(s.id) + '">'
        + '<div class="reg-card-header">'
        + '<div>'
        + '<div class="reg-card-title">' + escHtml(s.name) + '</div>'
        + '<a class="reg-card-url" href="' + escHtml(s.url) + '" target="_blank" rel="noopener">' + escHtml(s.url) + '</a>'
        + '</div>'
        + '</div>'
        + '<div class="reg-card-meta">'
        + '<div><strong>Protocol:</strong> ' + escHtml(s.protocol) + '</div>'
        + '<div><strong>Provider:</strong> ' + escHtml(s.provider || '—') + '</div>'
        + '<div><strong>Category:</strong> ' + escHtml(s.category || '—') + '</div>'
        + '<div><strong>Price:</strong> ' + price + '</div>'
        + '<div><strong>Contact:</strong> ' + escHtml(s.contact_email || '—') + '</div>'
        + '<div><strong>Registered:</strong> ' + date + '</div>'
        + '</div>'
        + '<div class="reg-card-verify">'
        + '<span class="verify-tag ok">HTTP ' + (s.health_status === 'healthy' ? '402' : '?') + '</span>'
        + '<span class="verify-tag' + (s.verified ? ' ok' : '') + '">verified: ' + (s.verified ? 'yes' : 'no') + '</span>'
        + '</div>'
        + '<div class="reg-card-actions">'
        + '<button class="btn-approve" onclick="approveService(\'' + escHtml(s.id) + '\', this)">Approve</button>'
        + '<button class="btn-reject" onclick="rejectService(\'' + escHtml(s.id) + '\', \'' + escHtml(s.name).replace(/'/g, "\\\\'") + '\', this)">Reject</button>'
        + '</div>'
        + '</div>'
    }

    async function loadPending() {
      var res = await apiFetch('/admin/pending')
      if (!res) return
      var data = await res.json()
      var list = document.getElementById('pending-list')
      var count = document.getElementById('pending-count')
      count.textContent = '(' + data.total + ' pending)'
      if (data.services.length === 0) {
        list.innerHTML = '<div class="empty-state">No pending registrations. You\\'re all caught up.</div>'
        return
      }
      list.innerHTML = data.services.map(renderCard).join('')
    }

    async function approveService(id, btn) {
      btn.disabled = true
      var res = await apiFetch('/admin/approve/' + id, { method: 'POST' })
      if (!res) return
      if (res.ok) {
        document.getElementById('card-' + id).remove()
        toast('Service approved', true)
        updateCount(-1)
      } else {
        var body = await res.json().catch(function() { return {} })
        toast(body.error || 'Approve failed', false)
        btn.disabled = false
      }
    }

    async function rejectService(id, name, btn) {
      if (!confirm('Reject ' + name + '?')) return
      btn.disabled = true
      var res = await apiFetch('/admin/reject/' + id, { method: 'POST' })
      if (!res) return
      if (res.ok) {
        document.getElementById('card-' + id).remove()
        toast('Service rejected', true)
        updateCount(-1)
      } else {
        var body = await res.json().catch(function() { return {} })
        toast(body.error || 'Reject failed', false)
        btn.disabled = false
      }
    }

    function updateCount(delta) {
      var el = document.getElementById('pending-count')
      var m = el.textContent.match(/\\d+/)
      var n = m ? parseInt(m[0]) + delta : 0
      if (n <= 0) {
        el.textContent = '(0 pending)'
        document.getElementById('pending-list').innerHTML = '<div class="empty-state">No pending registrations. You\\'re all caught up.</div>'
      } else {
        el.textContent = '(' + n + ' pending)'
      }
    }

    // Auth form submit
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

    // Auto-login if secret in sessionStorage
    if (getSecret()) {
      showDashboard()
      loadPending()
    }
    </script>
  `)
}
