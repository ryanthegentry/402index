import { randomUUID } from 'crypto'
import { normalizeUrl } from '../services/url-normalize.js'

/**
 * @param {string} network - Bazaar network name (e.g. 'base', 'ethereum')
 * @returns {string} CAIP-2 chain ID or original value if unmapped
 */
export function mapNetworkToPaymentNetwork(network) {
  const map = {
    'base': 'eip155:8453',
    'base-sepolia': 'eip155:84532',
    'ethereum': 'eip155:1',
    'arbitrum': 'eip155:42161',
    'optimism': 'eip155:10',
    'polygon': 'eip155:137',
  }
  return map[network] || network
}

/**
 * @param {string} url - Service endpoint URL
 * @returns {string|null} Provider name extracted from hostname, or null if URL is invalid
 */
export function extractProviderFromUrl(url) {
  try {
    const hostname = new URL(url).hostname
    return hostname.replace(/^(www|api|public)\./, '').split('.')[0]
  } catch {
    return null
  }
}

/**
 * @param {string|null} description - Service description text
 * @returns {string|null} Category slug inferred from keywords, or null if no match
 */
export function categorizeFromDescription(description) {
  if (!description) return null
  const d = description.toLowerCase()

  if (d.includes('nft')) return 'crypto/nft'
  if (d.includes('token balance') || d.includes('token holding')) return 'crypto/balances'
  if (d.includes('token price') || d.includes('market cap')) return 'crypto/prices'
  if (d.includes('defi') || d.includes('liquidity') || d.includes('swap')) return 'crypto/defi'
  if (d.includes('transaction') || d.includes('transfer')) return 'crypto/transactions'
  if (d.includes('wallet') || d.includes('portfolio')) return 'crypto/wallet'
  if (d.includes('weather') || d.includes('forecast')) return 'real-time-data/weather'
  if (d.includes('news')) return 'real-time-data/news'
  if (d.includes('search')) return 'tools/search'
  if (d.includes('image') || d.includes('photo')) return 'media/images'
  return null
}

/**
 * Normalize a Bazaar API item into the internal service schema.
 * @param {object} item - Raw Bazaar API item with accepts array and resource URL
 * @returns {object} Normalized service object matching the internal schema
 * @throws {Error} If the item is missing required data (accepts array or resource URL).
 */
export function normalizeItem(item) {
  const accept = item.accepts?.[0]
  if (!accept) throw new Error('missing accepts array')

  const rawUrl = item.resource || accept.resource
  if (!rawUrl) throw new Error('missing resource URL')
  const url = normalizeUrl(rawUrl)

  const maxAmount = accept.maxAmountRequired
  const priceUsd = maxAmount ? parseFloat(maxAmount) / 1e6 : null

  const paymentAsset = accept.extra?.name || 'USDC'

  const description = accept.description || null
  const provider = extractProviderFromUrl(url)
  const name = description
    ? description.substring(0, 80) + (description.length > 80 ? '...' : '')
    : url

  const sourceId = url

  return {
    id: randomUUID(),
    name,
    description,
    url,
    price_usd: priceUsd,
    payment_asset: paymentAsset,
    payment_network: mapNetworkToPaymentNetwork(accept.network || 'base'),
    category: categorizeFromDescription(description) || 'uncategorized',
    input_schema: accept.outputSchema?.input ? JSON.stringify(accept.outputSchema.input) : null,
    output_schema: accept.outputSchema?.output ? JSON.stringify(accept.outputSchema.output) : null,
    provider,
    source_id: sourceId,
  }
}
