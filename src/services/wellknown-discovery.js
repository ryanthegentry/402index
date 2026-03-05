import { isBlockedScheme, resolveAndCheck } from '../health/checker.js'

const WELLKNOWN_TIMEOUT_MS = 5000

/**
 * Attempt to discover probe configuration for a URL from its host's
 * .well-known/l402-services document.
 *
 * @param {string} url - The endpoint URL to look up
 * @returns {Promise<{ method: string, probeBody: string } | null>}
 */
export async function discoverProbeConfig(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  const wellKnownUrl = `${parsed.protocol}//${parsed.host}/.well-known/l402-services`

  // SSRF protection
  if (isBlockedScheme(wellKnownUrl)) return null
  const blockReason = await resolveAndCheck(wellKnownUrl)
  if (blockReason) return null

  let doc
  try {
    const res = await fetch(wellKnownUrl, {
      signal: AbortSignal.timeout(WELLKNOWN_TIMEOUT_MS),
      headers: { 'Accept': 'application/json' },
      redirect: 'manual',
    })
    if (!res.ok) return null
    doc = await res.json()
  } catch {
    return null
  }

  if (!doc || !Array.isArray(doc.services)) return null

  // Match by path
  const targetPath = parsed.pathname.replace(/\/$/, '')
  const entry = doc.services.find(svc => {
    if (!svc.endpoint) return false
    const entryPath = (svc.endpoint.startsWith('/') ? svc.endpoint : '/' + svc.endpoint).replace(/\/$/, '')
    return entryPath === targetPath
  })

  if (!entry) return null

  const method = (entry.method || 'GET').toUpperCase()
  const probeBody = buildMinimalProbeBody(entry.request_schema)

  return { method, probeBody }
}

/**
 * Construct a minimal JSON body from a .well-known request_schema.
 * Uses dummy values that satisfy type constraints without triggering
 * real processing.
 *
 * @param {object|null} schema - The request_schema from .well-known
 * @returns {string} JSON string for probe body. Returns '{}' if no schema.
 */
export function buildMinimalProbeBody(schema) {
  if (!schema || typeof schema !== 'object') return '{}'

  const body = {}
  for (const [field, spec] of Object.entries(schema)) {
    if (spec.required !== true) continue

    switch (spec.type) {
      case 'string':
        body[field] = 'test'
        break
      case 'number':
      case 'integer':
        body[field] = 1
        break
      case 'boolean':
        body[field] = true
        break
      case 'array':
        if (field === 'input' || field === 'messages') {
          body[field] = [{ role: 'user', content: 'test' }]
        } else {
          body[field] = ['test']
        }
        break
      case 'object':
        body[field] = {}
        break
      default:
        body[field] = 'test'
    }
  }

  return JSON.stringify(body)
}
