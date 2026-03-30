import { escapeXml } from './helpers.js'

/**
 * Convert a date string or Date object to RFC 2822 format for RSS.
 * @param {string|Date|null} dateStr
 * @returns {string}
 */
export function rfcDate(dateStr) {
  if (dateStr == null) return ''
  const d = dateStr instanceof Date ? dateStr : new Date(dateStr)
  if (isNaN(d.getTime())) return ''
  return d.toUTCString()
}

/**
 * Render a single service as an RSS <item> with l402: namespace tags.
 */
function serviceItem(s) {
  const desc = s.description || s.name || ''
  const category = s.category ? `    <category>${escapeXml(s.category)}</category>\n` : ''
  return `  <item>
    <title>${escapeXml(s.name)}</title>
    <link>https://402index.io/service/${escapeXml(s.id)}</link>
    <guid isPermaLink="true">https://402index.io/service/${escapeXml(s.id)}</guid>
    <pubDate>${rfcDate(s.registered_at)}</pubDate>
    <description>${escapeXml(desc)}</description>
${category}    <l402:endpoint url="${escapeXml(s.url)}" method="${escapeXml(s.http_method || 'GET')}"/>
    <l402:protocol type="${escapeXml(s.protocol)}" health="${escapeXml(s.health_status)}" reliability="${s.reliability_score || 0}"/>
    <l402:price sats="${s.price_sats != null ? s.price_sats : ''}" usd="${s.price_usd != null ? s.price_usd : ''}"/>
  </item>`
}

/**
 * Generate an RSS 2.0 feed with the l402: XML namespace.
 * @param {{ services: Array, selfUrl: string, filters: object }} opts
 * @returns {string} Complete RSS XML string
 */
export function feedXml({ services, selfUrl, filters }) {
  const items = services.map(s => serviceItem(s)).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:atom="http://www.w3.org/2005/Atom"
  xmlns:l402="https://402index.io/ns/l402">
  <channel>
    <title>402 Index - Paid API Directory</title>
    <link>https://402index.io</link>
    <description>New and updated paid API endpoints (L402 + x402) for AI agents</description>
    <language>en</language>
    <lastBuildDate>${rfcDate(new Date())}</lastBuildDate>
    <atom:link href="${escapeXml(selfUrl)}" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>`
}
