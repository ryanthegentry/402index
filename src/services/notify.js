/**
 * Email notification for new service registrations.
 * Uses Resend API (https://resend.com). Fire-and-forget — failures are logged, never thrown.
 *
 * Env vars:
 *   RESEND_API_KEY   — Resend API key (notifications disabled if unset)
 *   NOTIFY_EMAIL     — Recipient email (default: hello@402index.io)
 */

const RESEND_API = 'https://api.resend.com/emails'

export async function sendRegistrationNotification(service) {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) return // Silently skip if not configured

  const to = process.env.NOTIFY_EMAIL || 'hello@402index.io'
  const from = process.env.NOTIFY_FROM || '402index <notifications@402index.io>'
  const subject = `[402index] New registration: ${service.name}`
  const html = `
    <h2>New service registration</h2>
    <table>
      <tr><td><strong>Name</strong></td><td>${esc(service.name)}</td></tr>
      <tr><td><strong>URL</strong></td><td>${esc(service.url)}</td></tr>
      <tr><td><strong>Protocol</strong></td><td>${esc(service.protocol)}</td></tr>
      <tr><td><strong>Provider</strong></td><td>${esc(service.provider || '—')}</td></tr>
      <tr><td><strong>Contact</strong></td><td>${esc(service.contact_email || '—')}</td></tr>
      <tr><td><strong>Category</strong></td><td>${esc(service.category || '—')}</td></tr>
      <tr><td><strong>Status</strong></td><td>${esc(service.status || 'pending')}</td></tr>
    </table>
    <p>Review pending registrations: <a href="https://402index.io/admin">https://402index.io/admin</a></p>
  `

  try {
    const res = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to,
        subject,
        html,
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(`[notify] Resend API error ${res.status}: ${body}`)
    }
  } catch (err) {
    console.error('[notify] Failed to send email:', err.message)
  }
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
