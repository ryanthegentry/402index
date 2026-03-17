import { randomUUID } from 'crypto'
import { normalizeUrl } from '../services/url-normalize.js'

/**
 * Map l402.directory categories to internal categories.
 * They use an array of strings like ['data', 'finance', 'analytics'].
 */
export function mapCategory(categories) {
  if (!categories || categories.length === 0) return 'uncategorized'
  const primary = categories[0]
  const map = {
    'ai': 'ai/ml',
    'analytics': 'data/analytics',
    'content': 'media',
    'data': 'real-time-data',
    'developer-tools': 'tools',
    'finance': 'crypto/prices',
    'media': 'media',
    'search': 'tools/search',
    'social': 'social',
    'streaming': 'media/streaming',
    'video': 'media/video',
  }
  return map[primary] || primary
}

/**
 * Normalize a single endpoint from the l402.directory service format.
 * Each service has multiple endpoints; we create one DB row per endpoint.
 */
export function normalizeEndpoint(service, endpoint) {
  const url = endpoint.url
  if (!url) throw new Error('endpoint missing URL')

  // Skip .onion URLs (Tor hidden services — can't health-check)
  if (url.includes('.onion')) return null

  // Skip template URLs with unresolved {param} placeholders
  if (url.includes('{') && url.includes('}')) return null

  const pricing = endpoint.pricing || {}
  const priceSats = pricing.amount != null ? pricing.amount : null

  // Skip free endpoints (0 sats) — only index paid L402 endpoints
  if (priceSats === 0 || priceSats === null) return null

  const providerName = service.provider?.name || service.name || null

  return {
    id: randomUUID(),
    name: `${service.name}: ${endpoint.description || endpoint.url}`,
    description: endpoint.description || service.description || null,
    url: normalizeUrl(url),
    price_sats: priceSats,
    price_usd: null, // Will be computed from BTC rate
    category: mapCategory(service.categories),
    provider: providerName,
    source_id: service.service_id,
    http_method: (endpoint.method || 'GET').toUpperCase(),
  }
}

/**
 * Extract all paid endpoints from the l402.directory API response.
 * Returns an array of normalized endpoint objects ready for DB upsert.
 */
export function normalizeServices(services) {
  const results = []
  for (const svc of services) {
    if (svc.status !== 'live' && svc.status !== 'degraded') continue
    for (const ep of svc.endpoints || []) {
      try {
        const normalized = normalizeEndpoint(svc, ep)
        if (normalized) results.push(normalized)
      } catch {
        // skip invalid endpoints
      }
    }
  }
  return results
}
