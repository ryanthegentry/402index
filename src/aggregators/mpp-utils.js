import { randomUUID } from 'crypto'
import { normalizeUrl } from '../services/url-normalize.js'
import { categorize } from './l402apps-utils.js'

const CATEGORY_MAP = {
  ai: 'ai/llm',
  blockchain: 'blockchain',
  data: 'data',
  search: 'search',
  web: 'web-scraping',
  compute: 'compute',
  media: 'media',
  social: 'social',
  storage: 'storage',
}

const NETWORK_MAP = {
  tempo: 'Tempo',
  stripe: 'Stripe',
}

/**
 * Map MPP categories array to internal category string.
 * Uses first category from the array. Falls back to 'uncategorized'.
 */
export function mapMppCategory(categories) {
  if (!categories || categories.length === 0) return 'uncategorized'
  const first = categories[0]
  return CATEGORY_MAP[first] || first
}

/**
 * Parse MPP currency address to asset name.
 * Currently only USDC on Tempo chain 4217.
 */
export function parseMppCurrency(currencyAddress) {
  if (!currencyAddress) return 'USDC'
  // Known: 0x20c000000000000000000000b9537d11c60e8b50 = USDC on Tempo
  // Stripe services use 'usd' string instead of contract address
  if (currencyAddress === 'usd') return 'USD'
  if (currencyAddress !== '0x20c000000000000000000000b9537d11c60e8b50') {
    console.warn(`[mpp] Unknown currency address: ${currencyAddress}`)
  }
  return 'USDC'
}

/**
 * Normalize an MPP service + endpoint into our services table schema.
 * Returns null for free endpoints (payment: null).
 */
export function normalizeMppEndpoint(service, endpoint) {
  if (!endpoint.payment) return null
  if (!service.url) throw new Error('missing service URL')

  const payment = endpoint.payment
  const decimals = payment.decimals || 6
  const priceUsd = payment.dynamic
    ? null
    : parseFloat(payment.amount) / Math.pow(10, decimals)

  const fullUrl = normalizeUrl(`${service.serviceUrl || service.url}${endpoint.path}`)
  const category = mapMppCategory(service.categories)
  const finalCategory = category === 'uncategorized'
    ? categorize({ description: service.description || endpoint.description || '' })
    : category

  return {
    id: randomUUID(),
    name: `${service.name}: ${endpoint.description || endpoint.path}`,
    description: endpoint.description || service.description || null,
    url: fullUrl,
    price_usd: priceUsd,
    payment_asset: parseMppCurrency(payment.currency),
    payment_network: NETWORK_MAP[payment.method] || payment.method,
    category: finalCategory,
    provider: service.provider?.name || service.name,
    source_id: `${service.id}:${endpoint.path}`,
    http_method: endpoint.method,
    probe_body: endpoint.method === 'POST' ? '{}' : null,
  }
}
