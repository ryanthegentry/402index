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

const NETWORK_MAP = {
  'eip155:8453': 'Base',
  'eip155:1': 'Ethereum',
  'eip155:42161': 'Arbitrum',
  'eip155:10': 'Optimism',
  'eip155:137': 'Polygon',
  'base': 'Base',
  'ethereum': 'Ethereum',
  'arbitrum': 'Arbitrum',
  'optimism': 'Optimism',
  'polygon': 'Polygon',
  'solana': 'Solana',
}

/**
 * Map a Satring x402 network identifier to a human-readable name.
 * @param {string|null} network - e.g. 'eip155:8453' or 'base'
 * @returns {string} Human-readable network name
 */
export function mapX402Network(network) {
  if (!network) return 'Base'
  return NETWORK_MAP[network] || network
}

/**
 * Normalize a Satring API service into one or more internal service objects.
 * Returns an array — dual-protocol ("L402+x402") entries produce two rows.
 * @param {object} svc - Raw Satring API service object
 * @param {number} btcUsdRate - Current BTC/USD exchange rate for price conversion
 * @returns {object[]} Array of normalized service objects
 * @throws {Error} If the service is missing a URL.
 */
export function normalizeRawService(svc, btcUsdRate) {
  if (!svc.url) throw new Error('missing URL')

  const protocol = (svc.protocol || 'L402').trim()
  const base = {
    name: svc.name || svc.url,
    description: svc.description || null,
    url: normalizeUrl(svc.url),
    category: mapCategory(svc.categories) || 'uncategorized',
    provider: svc.owner_name || null,
    source_id: String(svc.id),
  }

  const results = []

  if (protocol === 'L402' || protocol === 'L402+x402') {
    results.push({
      ...base,
      id: randomUUID(),
      protocol: 'L402',
      price_sats: svc.pricing_sats || null,
      price_usd: satsToUsd(svc.pricing_sats, btcUsdRate),
      payment_asset: 'BTC',
      payment_network: 'Lightning',
    })
  }

  if (protocol === 'x402' || protocol === 'L402+x402') {
    results.push({
      ...base,
      id: randomUUID(),
      protocol: 'x402',
      price_sats: null,
      price_usd: svc.pricing_usd || null,
      payment_asset: svc.x402_asset || 'USDC',
      payment_network: mapX402Network(svc.x402_network),
    })
  }

  // Fallback: unknown protocol string — treat as L402 (legacy behavior)
  if (results.length === 0) {
    results.push({
      ...base,
      id: randomUUID(),
      protocol: 'L402',
      price_sats: svc.pricing_sats || null,
      price_usd: satsToUsd(svc.pricing_sats, btcUsdRate),
      payment_asset: 'BTC',
      payment_network: 'Lightning',
    })
  }

  return results
}
