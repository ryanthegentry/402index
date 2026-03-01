import { randomUUID } from 'crypto'
import { normalizeUrl } from '../services/url-normalize.js'

/**
 * Extract embedded JSON data from l402apps.com HTML.
 * The page embeds window.__APPS__ and window.__APIS__ as inline JSON.
 */
export function parseL402AppsHtml(html) {
  return {
    apps: extractJsonVar(html, '__APPS__') || [],
    apis: extractJsonVar(html, '__APIS__') || [],
  }
}

function extractJsonVar(html, varName) {
  // Match window.__VAR__=[...]; — the JSON array ends at ];
  const start = html.indexOf(`window.${varName}=`)
  if (start === -1) return null

  const arrayStart = html.indexOf('[', start)
  if (arrayStart === -1) return null

  // Find matching closing bracket (handle nested arrays/objects)
  let depth = 0
  let i = arrayStart
  for (; i < html.length; i++) {
    if (html[i] === '[' || html[i] === '{') depth++
    else if (html[i] === ']' || html[i] === '}') {
      depth--
      if (depth === 0) break
    }
  }

  try {
    return JSON.parse(html.slice(arrayStart, i + 1))
  } catch {
    return null
  }
}

/**
 * Infer category from description and provider name.
 */
export function categorize(item) {
  const desc = (item.description || '').toLowerCase()

  if (desc.includes('llm') || desc.includes('gpt') || desc.includes('ai-generated') || desc.includes('ai response')) return 'ai/ml'
  if (desc.includes('sentiment') || desc.includes('keyword') || desc.includes('summariz')) return 'ai/ml'
  if (desc.includes('profanity') || desc.includes('moderation')) return 'tools/moderation'
  if (desc.includes('trust') || desc.includes('reputation') || desc.includes('sybil') || desc.includes('spam classif')) return 'identity'
  if (desc.includes('mempool') || desc.includes('fee estimate') || desc.includes('on-chain fee')) return 'crypto/bitcoin'
  if (desc.includes('btc') || desc.includes('bitcoin') || desc.includes('lightning')) return 'crypto/bitcoin'
  if (desc.includes('invoice') || desc.includes('node info')) return 'crypto/bitcoin'
  if (desc.includes('wallet')) return 'crypto/wallet'
  if (desc.includes('ordinal') || desc.includes('inscri')) return 'crypto/nft'
  if (desc.includes('payment') || desc.includes('infrastructure')) return 'crypto/payments'
  if (desc.includes('messaging') || desc.includes('chat')) return 'social'
  if (desc.includes('storage') || desc.includes('key-value') || desc.includes('memory')) return 'storage'
  if (desc.includes('task') || desc.includes('bounty') || desc.includes('marketplace')) return 'tools/marketplace'
  if (desc.includes('analytics') || desc.includes('stats')) return 'real-time-data'
  if (desc.includes('entropy') || desc.includes('random')) return 'tools/crypto'
  if (desc.includes('lottery')) return 'tools'
  if (desc.includes('directory') || desc.includes('listing')) return 'tools/directory'
  return 'uncategorized'
}

/**
 * Normalize an l402apps "App" (website/product) into our service schema.
 */
export function normalizeApp(app) {
  if (!app.url) throw new Error('missing URL')
  return {
    id: randomUUID(),
    name: app.name || app.url,
    description: app.description || null,
    url: normalizeUrl(app.url),
    price_sats: null,
    price_usd: null,
    category: categorize(app),
    provider: app.name || null,
    source_id: app.id || null,
  }
}

/**
 * Normalize an l402apps "API" (L402-paywalled endpoint) into our service schema.
 * @param {object} api - Raw API object from window.__APIS__
 * @param {number} btcUsdRate - Current BTC/USD rate for sats-to-USD conversion
 */
export function normalizeApi(api, btcUsdRate) {
  if (!api.endpoint) throw new Error('missing endpoint')
  const priceSats = api.cost || null
  const priceUsd = priceSats && btcUsdRate ? (priceSats / 100_000_000) * btcUsdRate : null
  return {
    id: randomUUID(),
    name: api.provider ? `${api.provider}: ${api.name}` : (api.name || api.endpoint),
    description: api.description || null,
    url: normalizeUrl(api.endpoint),
    price_sats: priceSats,
    price_usd: priceUsd,
    category: categorize(api),
    provider: api.provider || null,
    source_id: api.id || null,
  }
}
