/**
 * Normalize a URL: lowercase hostname, strip trailing slashes.
 * By default also upgrades http→https (for aggregated listings).
 * Pass { preserveScheme: true } for registration endpoints where
 * the submitted scheme must be preserved (e.g. HTTP-only tunnels).
 */
/**
 * Extract hostname from a URL, lowercased. Returns null for invalid URLs.
 */
export function extractHostname(url) {
  if (!url || typeof url !== 'string') return null
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

export function normalizeUrl(rawUrl, opts = {}) {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl
  try {
    const url = new URL(rawUrl)
    // reject non-web protocols (defense-in-depth)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    // http → https (unless caller explicitly preserves scheme)
    if (!opts.preserveScheme && url.protocol === 'http:') url.protocol = 'https:'
    // lowercase hostname
    url.hostname = url.hostname.toLowerCase()
    // strip trailing slashes from pathname
    url.pathname = url.pathname.replace(/\/+$/, '') || '/'
    return url.toString()
  } catch {
    return rawUrl
  }
}
