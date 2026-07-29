// BTC/USD spot, same source and cache policy as the main app's
// src/services/btc-price.js, injectable for tests.
const CACHE_TTL_MS = 3_600_000;

let cachedRate = 0;
let fetchedAt = 0;

export async function btcUsdRate(fetchImpl: typeof fetch = fetch): Promise<number> {
  if (cachedRate > 0 && Date.now() - fetchedAt < CACHE_TTL_MS) return cachedRate;
  const res = await fetchImpl(
    'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
    { signal: AbortSignal.timeout(5000) }
  );
  if (!res.ok) throw new Error(`CoinGecko returned ${res.status}`);
  const data = (await res.json()) as { bitcoin?: { usd?: number } };
  const rate = data.bitcoin?.usd;
  if (typeof rate !== 'number' || rate <= 0) throw new Error('CoinGecko response missing bitcoin.usd');
  cachedRate = rate;
  fetchedAt = Date.now();
  return rate;
}
