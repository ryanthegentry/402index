/**
 * Per-host debounce cache for the live probe endpoint.
 * Prevents hammering the same host with rapid sequential probes.
 *
 * NOT used by batch health checker (which has its own waitForHost throttle)
 * or registration probes (which are one-shot per endpoint).
 */

export const CACHE_TTL_MS = 3000        // Return cached result if same host probed within 3s
const CACHE_MAX_AGE_MS = 15000   // Evict entries older than 15s to prevent unbounded growth
const cache = new Map()          // hostname → { result, timestamp }

function cleanExpired() {
  const now = Date.now()
  for (const [host, entry] of cache) {
    if (now - entry.timestamp > CACHE_MAX_AGE_MS) {
      cache.delete(host)
    }
  }
}

/**
 * Probe with per-host debounce. Returns cached result if same host
 * was probed within CACHE_TTL_MS, otherwise calls probeFn and caches.
 *
 * @param {string} url - The endpoint URL to probe
 * @param {function} probeFn - The actual probe function (probeEndpoint)
 * @param {object} [options] - Options passed through to probeFn
 * @returns {Promise<object>} Probe result (possibly cached)
 */
export async function liveProbeWithThrottle(url, probeFn, options = {}) {
  let hostname
  try {
    hostname = new URL(url).hostname.toLowerCase()
  } catch {
    // Malformed URL — skip cache, let probeFn handle the error
    return probeFn(url, options)
  }

  const now = Date.now()
  const cached = cache.get(hostname)
  if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
    return { ...cached.result, cached: true }
  }

  // Clean expired entries periodically (cheap, runs inline)
  if (cache.size > 50) cleanExpired()

  const result = await probeFn(url, options)
  cache.set(hostname, { result, timestamp: now })
  return result
}

export function clearCache() { cache.clear() }
export function getCacheSize() { return cache.size }
