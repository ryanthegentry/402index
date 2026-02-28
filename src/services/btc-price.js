import fetch from 'node-fetch'

const CACHE_TTL_MS = 3600000 // 1 hour
const FALLBACK_RATE = 90_000

let cachedRate = FALLBACK_RATE
let lastFetchedAt = 0

export async function getBtcUsdRate() {
  const now = Date.now()
  if (now - lastFetchedAt < CACHE_TTL_MS && cachedRate !== FALLBACK_RATE) {
    return cachedRate
  }

  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
      { signal: AbortSignal.timeout(5000) }
    )
    if (!res.ok) throw new Error(`CoinGecko returned ${res.status}`)
    const data = await res.json()
    const rate = data?.bitcoin?.usd
    if (rate && typeof rate === 'number') {
      cachedRate = rate
      lastFetchedAt = now
      console.log(`[btc-price] Updated BTC/USD rate: $${rate.toLocaleString()}`)
      return rate
    }
    throw new Error('Invalid response shape')
  } catch (err) {
    console.warn(`[btc-price] Failed to fetch rate, using cached $${cachedRate.toLocaleString()}: ${err.message}`)
    return cachedRate
  }
}

export function getCachedBtcUsdRate() {
  return cachedRate
}
