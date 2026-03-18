export function escapeHtml(str) {
  if (str == null) return ''
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function escapeXml(str) {
  if (str == null) return ''
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

export function healthDot(status) {
  return `<span class="health-dot health-${status}"></span>${status}`
}

export function protocolBadge(protocol) {
  const cls = protocol === 'x402' ? 'badge-x402' : protocol === 'L402' ? 'badge-l402' : protocol === 'MPP' ? 'badge-mpp' : 'badge-both'
  return `<span class="badge ${cls}">${protocol}</span>`
}

export function formatPrice(service, btcUsdRate) {
  if (service.price_usd != null) return `$${service.price_usd.toFixed(service.price_usd < 0.01 ? 4 : 2)}`
  if (service.price_sats != null && btcUsdRate) {
    const usd = (service.price_sats / 100_000_000) * btcUsdRate
    return `$${usd.toFixed(usd < 0.01 ? 4 : 2)}`
  }
  if (service.price_sats != null) return `${service.price_sats} sats`
  return '—'
}

export function formatSchema(json) {
  if (!json) return null
  try {
    return JSON.stringify(JSON.parse(json), null, 2)
  } catch {
    return json
  }
}
