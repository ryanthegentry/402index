/**
 * Normalize a URL: lowercase hostname, strip trailing slashes.
 * By default also upgrades http→https (for aggregated listings).
 * Pass { preserveScheme: true } for registration endpoints where
 * the submitted scheme must be preserved (e.g. HTTP-only tunnels).
 */
export function normalizeUrl(rawUrl, opts = {}) {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl
  try {
    const url = new URL(rawUrl)
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
