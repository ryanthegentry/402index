import { randomUUID } from 'crypto'
import { normalizeUrl } from '../services/url-normalize.js'

/**
 * @param {Array<{slug: string}>|null} categories - Satring category objects
 * @returns {string|null} Mapped internal category slug, or null if empty
 */
export function mapCategory(categories) {
  if (!categories || categories.length === 0) return null
  const slug = categories[0].slug
  const map = {
    'ai-ml': 'ai/ml',
    'finance': 'crypto/prices',
    'data': 'real-time-data',
    'weather': 'real-time-data/weather',
    'search': 'tools/search',
    'tools': 'tools',
    'social': 'social',
    'identity': 'identity',
    'media': 'media',
    'compute': 'compute',
    'storage': 'storage',
  }
  return map[slug] || slug
}

/**
 * @param {number|null} sats - Price in satoshis
 * @param {number} btcUsdRate - Current BTC/USD exchange rate
 * @returns {number|null} Price in USD, or null if sats is null/zero
 */
export function satsToUsd(sats, btcUsdRate) {
  if (sats == null || sats === 0) return null
  return (sats / 100_000_000) * btcUsdRate
}

/**
 * Normalize a Satring API service into the internal service schema.
 * @param {object} svc - Raw Satring API service object
 * @param {number} btcUsdRate - Current BTC/USD exchange rate for price conversion
 * @returns {object} Normalized service object matching the internal schema
 * @throws {Error} If the service is missing a URL.
 */
export function normalizeRawService(svc, btcUsdRate) {
  if (!svc.url) throw new Error('missing URL')
  return {
    id: randomUUID(),
    name: svc.name || svc.url,
    description: svc.description || null,
    url: normalizeUrl(svc.url),
    price_sats: svc.pricing_sats || null,
    price_usd: satsToUsd(svc.pricing_sats, btcUsdRate),
    category: mapCategory(svc.categories) || 'uncategorized',
    provider: svc.owner_name || null,
    source_id: String(svc.id),
  }
}
