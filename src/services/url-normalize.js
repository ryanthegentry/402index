/** Normalize a URL: upgrade to HTTPS, lowercase hostname, strip trailing slashes. */
export function normalizeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl
  try {
    const url = new URL(rawUrl)
    // http → https
    if (url.protocol === 'http:') url.protocol = 'https:'
    // lowercase hostname
    url.hostname = url.hostname.toLowerCase()
    // strip trailing slashes from pathname
    url.pathname = url.pathname.replace(/\/+$/, '') || '/'
    return url.toString()
  } catch {
    return rawUrl
  }
}
