#!/usr/bin/env node

/**
 * L402 Endpoint Discovery Script
 *
 * For each degraded/down L402 endpoint in 402index, discovers the actual
 * L402-gated path and HTTP method that returns 402 + WWW-Authenticate.
 *
 * 5-stage pipeline:
 *   1. Direct probe (HEAD/GET/POST on registered URL)
 *   2. Well-known discovery (.well-known/l402-services, etc.)
 *   3. Landing page analysis (link/text extraction)
 *   4. Common path probing (parent paths + known L402 patterns)
 *   5. Robots/sitemap analysis
 *
 * Usage:
 *   node scripts/l402-discovery.js [--json] [--verbose] [--url <url>] [--provider <name>] [--apply]
 */

import { parseWwwAuthenticate, isValidMacaroon, isValidInvoice } from '../src/services/l402-utils.js'
import { isBlockedScheme, resolveAndCheck } from '../src/health/checker.js'

const TIMEOUT_MS = 5000
const MAX_CONCURRENT = 3
const INTER_PROBE_DELAY_MS = 500
const MAX_REQUESTS_PER_ENDPOINT = 30
const MAX_BODY_SIZE = 65536

// Parse CLI args
const args = process.argv.slice(2)
const VERBOSE = args.includes('--verbose')
const JSON_OUTPUT = args.includes('--json')
const APPLY = args.includes('--apply')
const URL_FLAG = args.includes('--url') ? args[args.indexOf('--url') + 1] : null
const PROVIDER_FLAG = args.includes('--provider') ? args[args.indexOf('--provider') + 1] : null

function log(...msg) { console.error(...msg) }
function verbose(...msg) { if (VERBOSE) console.error('[verbose]', ...msg) }

// --- HTTP helpers ---

async function safeFetch(url, options = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      redirect: 'manual',
    })
    return res
  } finally {
    clearTimeout(timeout)
  }
}

async function readBodySafe(res, limit = MAX_BODY_SIZE) {
  try {
    const text = await res.text()
    return text.length > limit ? text.slice(0, limit) : text
  } catch {
    return null
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// --- L402 validation ---

function checkL402Response(res, body = null) {
  if (res.status !== 402) return null

  const wwwAuth = res.headers.get('www-authenticate')
  const parsed = parseWwwAuthenticate(wwwAuth)

  if (!parsed.scheme || !/L402|LSAT/i.test(parsed.scheme)) return null

  return {
    scheme: parsed.scheme,
    has_macaroon: isValidMacaroon(parsed.macaroon),
    has_invoice: isValidInvoice(parsed.invoice),
    invoice_prefix: parsed.invoice ? parsed.invoice.slice(0, 4) : null,
    raw_header: wwwAuth,
  }
}

function isValidL402(l402Details) {
  return l402Details && l402Details.has_macaroon && l402Details.has_invoice
}

// --- SSRF-safe probe ---

async function probeUrl(url, method, probes, requestCount) {
  if (requestCount.n >= MAX_REQUESTS_PER_ENDPOINT) {
    verbose(`  [skip] max requests reached for endpoint`)
    return null
  }

  // SSRF checks
  if (isBlockedScheme(url)) {
    verbose(`  [skip] blocked scheme: ${url}`)
    return null
  }
  const blockReason = await resolveAndCheck(url)
  if (blockReason) {
    verbose(`  [skip] ${blockReason}`)
    return null
  }

  requestCount.n++
  verbose(`  [probe] ${method} ${url} (req #${requestCount.n})`)

  const probe = {
    url,
    method,
    status: null,
    has_www_authenticate: false,
    www_authenticate_scheme: null,
    l402_details: null,
    body_preview: null,
    error: null,
  }

  try {
    const options = { method }
    if (method === 'POST') {
      options.headers = { 'Content-Type': 'application/json' }
      options.body = '{}'
    }
    const res = await safeFetch(url, options)
    probe.status = res.status

    const wwwAuth = res.headers.get('www-authenticate')
    probe.has_www_authenticate = !!wwwAuth
    if (wwwAuth) {
      const parsed = parseWwwAuthenticate(wwwAuth)
      probe.www_authenticate_scheme = parsed.scheme
    }

    const l402 = checkL402Response(res)
    probe.l402_details = l402

    // Read body for GET (landing page analysis, baseline)
    if (method === 'GET' && res.status !== 402) {
      probe.body_preview = await readBodySafe(res, 4096)
    }

    return probe
  } catch (err) {
    probe.error = err.name === 'AbortError' ? 'timeout' : err.message
    return probe
  }
}

// --- Stage implementations ---

async function stage1DirectProbe(url, probes, requestCount) {
  verbose(`Stage 1: Direct probe ${url}`)

  for (const method of ['POST', 'GET', 'HEAD']) {
    const probe = await probeUrl(url, method, probes, requestCount)
    if (probe) {
      probe.stage = 'stage_1_direct'
      probes.push(probe)
      if (isValidL402(probe.l402_details)) {
        return { found_url: url, found_method: method, found_stage: 'stage_1_direct', l402_details: probe.l402_details }
      }
    }
    await sleep(INTER_PROBE_DELAY_MS)
  }
  return null
}

async function stage2WellKnown(origin, probes, requestCount) {
  verbose(`Stage 2: Well-known discovery ${origin}`)

  const wellKnownPaths = [
    '/.well-known/l402-services',
    '/.well-known/l402',
    '/.well-known/lsat/services',
  ]

  for (const path of wellKnownPaths) {
    const url = origin + path
    const probe = await probeUrl(url, 'GET', probes, requestCount)
    if (probe) {
      probe.stage = 'stage_2_well_known'
      probes.push(probe)

      // If it returns JSON with endpoint info, probe those
      if (probe.status === 200 && probe.body_preview) {
        try {
          const data = JSON.parse(probe.body_preview)
          const urls = extractUrlsFromJson(data, origin)
          for (const discoveredUrl of urls.slice(0, 5)) {
            for (const method of ['POST', 'GET']) {
              const subProbe = await probeUrl(discoveredUrl, method, probes, requestCount)
              if (subProbe) {
                subProbe.stage = 'stage_2_well_known'
                probes.push(subProbe)
                if (isValidL402(subProbe.l402_details)) {
                  return { found_url: discoveredUrl, found_method: method, found_stage: 'stage_2_well_known', l402_details: subProbe.l402_details }
                }
              }
              await sleep(INTER_PROBE_DELAY_MS)
            }
          }
        } catch { /* not JSON */ }
      }

      // The well-known path itself might be L402-gated
      if (isValidL402(probe.l402_details)) {
        return { found_url: url, found_method: 'GET', found_stage: 'stage_2_well_known', l402_details: probe.l402_details }
      }
    }
    await sleep(INTER_PROBE_DELAY_MS)
  }
  return null
}

async function stage3LandingPage(origin, registeredUrl, probes, requestCount, signals) {
  verbose(`Stage 3: Landing page analysis ${origin}`)

  // Fetch root page
  const rootUrl = origin + '/'
  const probe = await probeUrl(rootUrl, 'GET', probes, requestCount)
  if (!probe || !probe.body_preview) return null
  probe.stage = 'stage_3_landing'
  probes.push(probe)

  if (isValidL402(probe.l402_details)) {
    return { found_url: rootUrl, found_method: 'GET', found_stage: 'stage_3_landing', l402_details: probe.l402_details }
  }

  const body = probe.body_preview
  const discoveredUrls = new Set()

  // Extract links from HTML
  const linkPattern = /href="([^"]*(?:\/api|\/v1|\/v2|\/l402|\/lsat|\/docs|\/swagger|\/openapi)[^"]*)"/gi
  let match
  while ((match = linkPattern.exec(body)) !== null) {
    try {
      const resolved = new URL(match[1], origin).href
      if (new URL(resolved).origin === origin) {
        discoveredUrls.add(resolved)
        signals.push(`Link: ${match[1]}`)
      }
    } catch { /* malformed URL */ }
  }

  // Links with API-related text
  const textLinkPattern = /<a[^>]+href="([^"]+)"[^>]*>[^<]*(?:API|documentation|endpoint|pricing)[^<]*<\/a>/gi
  while ((match = textLinkPattern.exec(body)) !== null) {
    try {
      const resolved = new URL(match[1], origin).href
      if (new URL(resolved).origin === origin) {
        discoveredUrls.add(resolved)
        signals.push(`Text link: ${match[1]}`)
      }
    } catch { /* malformed URL */ }
  }

  // Scan for URL patterns
  const urlPattern = /https?:\/\/[^\s"'<>]+\/api[^\s"'<>]*/g
  while ((match = urlPattern.exec(body)) !== null) {
    try {
      const url = new URL(match[0])
      if (url.origin === origin) {
        discoveredUrls.add(url.href)
      }
    } catch { /* malformed URL */ }
  }

  // Scan for L402/Lightning mentions
  const keywords = ['L402', 'LSAT', 'Lightning', 'macaroon', 'paywall', '402']
  for (const kw of keywords) {
    if (body.includes(kw)) {
      signals.push(`Text match: "${kw}"`)
    }
  }

  // JSON response handling
  if (body.trim().startsWith('{') || body.trim().startsWith('[')) {
    try {
      const data = JSON.parse(body)
      const urls = extractUrlsFromJson(data, origin)
      for (const u of urls) discoveredUrls.add(u)
    } catch { /* not valid JSON */ }
  }

  // Probe discovered URLs (limit 10)
  const toProbe = [...discoveredUrls].slice(0, 10)
  for (const url of toProbe) {
    for (const method of ['POST', 'GET']) {
      const subProbe = await probeUrl(url, method, probes, requestCount)
      if (subProbe) {
        subProbe.stage = 'stage_3_landing'
        probes.push(subProbe)
        if (isValidL402(subProbe.l402_details)) {
          return { found_url: url, found_method: method, found_stage: 'stage_3_landing', l402_details: subProbe.l402_details }
        }
      }
      await sleep(INTER_PROBE_DELAY_MS)
    }
  }

  return null
}

async function stage4CommonPaths(origin, registeredUrl, probes, requestCount) {
  verbose(`Stage 4: Common path probing ${origin}`)

  const candidatePaths = new Set()

  // Parent paths from registered URL
  try {
    const parsed = new URL(registeredUrl)
    const segments = parsed.pathname.split('/').filter(Boolean)
    for (let i = segments.length - 1; i >= 0; i--) {
      candidatePaths.add('/' + segments.slice(0, i).join('/'))
    }
  } catch { /* malformed URL */ }

  // Common L402 API paths
  const commonPaths = [
    '/api/l402', '/api/v1', '/api', '/v1',
    '/api/v1/chat', '/api/v1/completions', '/api/chat',
    '/ask', '/api/generate', '/api/inference', '/api/search',
  ]
  for (const p of commonPaths) candidatePaths.add(p)

  // Remove empty/root (already probed in stage 1/3)
  candidatePaths.delete('')
  candidatePaths.delete('/')

  // Limit to 15
  const paths = [...candidatePaths].slice(0, 15)

  for (const path of paths) {
    const url = origin + path
    // POST first per spec (most L402 are POST-only APIs)
    for (const method of ['POST', 'GET']) {
      const probe = await probeUrl(url, method, probes, requestCount)
      if (probe) {
        probe.stage = 'stage_4_common_paths'
        probes.push(probe)
        if (isValidL402(probe.l402_details)) {
          return { found_url: url, found_method: method, found_stage: 'stage_4_common_paths', l402_details: probe.l402_details }
        }
      }
      await sleep(INTER_PROBE_DELAY_MS)
    }
  }

  return null
}

async function stage5RobotsSitemap(origin, probes, requestCount, signals) {
  verbose(`Stage 5: Robots/sitemap analysis ${origin}`)

  const apiPaths = new Set()

  // robots.txt
  const robotsProbe = await probeUrl(origin + '/robots.txt', 'GET', probes, requestCount)
  if (robotsProbe) {
    robotsProbe.stage = 'stage_5_robots_sitemap'
    probes.push(robotsProbe)
    if (robotsProbe.body_preview) {
      const disallowPattern = /Disallow:\s*([^\s]+)/gi
      let match
      while ((match = disallowPattern.exec(robotsProbe.body_preview)) !== null) {
        const path = match[1]
        if (/\/api|\/v1|\/v2|\/l402|\/lsat/i.test(path)) {
          apiPaths.add(path)
          signals.push(`robots.txt Disallow: ${path}`)
        }
      }
    }
  }
  await sleep(INTER_PROBE_DELAY_MS)

  // sitemap.xml
  const sitemapProbe = await probeUrl(origin + '/sitemap.xml', 'GET', probes, requestCount)
  if (sitemapProbe) {
    sitemapProbe.stage = 'stage_5_robots_sitemap'
    probes.push(sitemapProbe)
    if (sitemapProbe.body_preview) {
      const locPattern = /<loc>(https?:\/\/[^<]+)<\/loc>/gi
      let match
      while ((match = locPattern.exec(sitemapProbe.body_preview)) !== null) {
        try {
          const url = new URL(match[1])
          if (url.origin === origin && /\/api|\/v1|\/v2|\/l402|\/lsat/i.test(url.pathname)) {
            apiPaths.add(url.pathname)
            signals.push(`sitemap.xml: ${url.pathname}`)
          }
        } catch { /* malformed URL */ }
      }
    }
  }

  // Probe discovered paths (limit 5)
  const paths = [...apiPaths].slice(0, 5)
  for (const path of paths) {
    const url = origin + path
    for (const method of ['POST', 'GET']) {
      await sleep(INTER_PROBE_DELAY_MS)
      const probe = await probeUrl(url, method, probes, requestCount)
      if (probe) {
        probe.stage = 'stage_5_robots_sitemap'
        probes.push(probe)
        if (isValidL402(probe.l402_details)) {
          return { found_url: url, found_method: method, found_stage: 'stage_5_robots_sitemap', l402_details: probe.l402_details }
        }
      }
    }
  }

  return null
}

// --- Helpers ---

function extractUrlsFromJson(data, origin) {
  const urls = []
  const seen = new Set()

  function walk(obj) {
    if (!obj || typeof obj !== 'object') return
    if (typeof obj === 'string' && obj.startsWith('http')) {
      try {
        const url = new URL(obj)
        if (url.origin === origin && !seen.has(url.href)) {
          seen.add(url.href)
          urls.push(url.href)
        }
      } catch { /* ignore */ }
      return
    }
    for (const val of Object.values(obj)) {
      if (typeof val === 'string' && val.startsWith('http')) {
        walk(val)
      } else if (typeof val === 'object') {
        walk(val)
      }
    }
  }

  walk(data)
  return urls
}

function getOrigin(url) {
  try { return new URL(url).origin } catch { return null }
}

// --- Main discovery for one endpoint ---

async function discoverEndpoint(service) {
  const { id, name, url, health_status, last_status_code, http_method, source, provider } = service

  const origin = getOrigin(url)
  if (!origin) {
    return {
      service_id: id,
      registered_url: url,
      registered_name: name,
      source, provider,
      current_health: health_status,
      last_status_code,
      discovery_result: { status: 'not_found', error: 'invalid URL' },
      probes: [],
      landing_page_signals: [],
      suggested_update: null,
    }
  }

  // Skip .onion
  if (new URL(url).hostname.endsWith('.onion')) {
    return {
      service_id: id,
      registered_url: url,
      registered_name: name,
      source, provider,
      current_health: health_status,
      last_status_code,
      discovery_result: { status: 'not_found', error: 'onion domain skipped' },
      probes: [],
      landing_page_signals: [],
      suggested_update: null,
    }
  }

  const probes = []
  const signals = []
  const requestCount = { n: 0 }

  // Run stages in order, stop on first valid L402
  let result = await stage1DirectProbe(url, probes, requestCount)

  if (!result) {
    result = await stage2WellKnown(origin, probes, requestCount)
  }

  if (!result) {
    result = await stage3LandingPage(origin, url, probes, requestCount, signals)
  }

  if (!result) {
    result = await stage4CommonPaths(origin, url, probes, requestCount)
  }

  if (!result) {
    result = await stage5RobotsSitemap(origin, probes, requestCount, signals)
  }

  // Build suggested update
  let suggestedUpdate = null
  let status = 'not_found'

  if (result && isValidL402(result.l402_details)) {
    status = 'found'
    const urlChanged = result.found_url !== url
    const methodChanged = result.found_method !== (http_method || 'GET')

    if (urlChanged && methodChanged) {
      suggestedUpdate = { action: 'update_url_and_method', url: result.found_url, http_method: result.found_method, confidence: 'high' }
    } else if (urlChanged) {
      suggestedUpdate = { action: 'update_url', url: result.found_url, confidence: 'high' }
    } else if (methodChanged) {
      suggestedUpdate = { action: 'update_method', http_method: result.found_method, confidence: 'high' }
    } else {
      suggestedUpdate = { action: 'none_needed', confidence: 'high', notes: 'registered URL works — may have been transiently down' }
    }
  } else if (signals.length > 0) {
    status = 'partial'
    // Check if any probe got a 402 without full L402 validation
    const got402 = probes.some(p => p.status === 402)
    if (got402) {
      suggestedUpdate = { action: 'manual_review', confidence: 'medium', notes: 'Got 402 but missing valid L402 headers' }
    }
  }

  return {
    service_id: id,
    registered_url: url,
    registered_name: name,
    source, provider,
    current_health: health_status,
    last_status_code,
    discovery_result: {
      status,
      ...(result ? {
        found_url: result.found_url,
        found_method: result.found_method,
        found_stage: result.found_stage,
        l402_details: result.l402_details,
      } : {}),
    },
    probes: VERBOSE ? probes : probes.filter(p => p.status === 402 || p.l402_details || p.error),
    landing_page_signals: signals,
    suggested_update: suggestedUpdate,
  }
}

// --- Fetch endpoints from API ---

async function fetchEndpoints() {
  if (URL_FLAG) {
    return [{
      id: 'manual',
      name: 'Manual test',
      url: URL_FLAG,
      health_status: 'unknown',
      last_status_code: null,
      http_method: null,
      source: 'manual',
      provider: 'manual',
    }]
  }

  log('Fetching L402 endpoints from 402index API...')
  const res = await fetch('https://402index.io/api/v1/services?protocol=L402&limit=200')
  if (!res.ok) throw new Error(`API returned ${res.status}`)
  const data = await res.json()

  let services = data.services || data
  log(`Fetched ${services.length} L402 endpoints total`)

  // Filter for degraded/down
  services = services.filter(s => s.health_status !== 'healthy')
  log(`${services.length} are degraded/down`)

  if (PROVIDER_FLAG) {
    services = services.filter(s => s.provider && s.provider.toLowerCase().includes(PROVIDER_FLAG.toLowerCase()))
    log(`${services.length} match provider filter: ${PROVIDER_FLAG}`)
  }

  return services
}

// --- Concurrency limiter ---

async function runWithConcurrency(items, concurrency, fn) {
  const results = []
  let index = 0

  async function worker() {
    while (index < items.length) {
      const i = index++
      results[i] = await fn(items[i], i)
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  await Promise.all(workers)
  return results
}

// --- Summary generation ---

function generateSummary(reports) {
  const total = reports.length
  const found = reports.filter(r => r.discovery_result.status === 'found')
  const partial = reports.filter(r => r.discovery_result.status === 'partial')
  const notFound = reports.filter(r => r.discovery_result.status === 'not_found')

  const byStage = {}
  for (const r of found) {
    const stage = r.discovery_result.found_stage || 'unknown'
    byStage[stage] = (byStage[stage] || 0) + 1
  }

  const urlChanges = found.filter(r => r.suggested_update && r.suggested_update.action.includes('url'))
  const methodChanges = found.filter(r => r.suggested_update && r.suggested_update.action.includes('method'))
  const transient = found.filter(r => r.suggested_update && r.suggested_update.action === 'none_needed')

  const lines = [
    `L402 Endpoint Discovery Report — ${new Date().toISOString().split('T')[0]}`,
    '='.repeat(55),
    '',
    `Total endpoints scanned:     ${total}`,
    `L402 found (new URL):        ${urlChanges.length}`,
    `L402 found (method fix):     ${methodChanges.length}`,
    `L402 found (transient):      ${transient.length}`,
    `Partial signals (manual):    ${partial.length}`,
    `No signals found:            ${notFound.length}`,
    '',
    `Suggested DB updates:        ${urlChanges.length + methodChanges.length}`,
    `Manual review needed:        ${partial.length}`,
    '',
    `Finds by stage:`,
  ]

  for (const [stage, count] of Object.entries(byStage)) {
    lines.push(`  ${stage}: ${count}`)
  }

  if (urlChanges.length + methodChanges.length > 0) {
    lines.push('')
    lines.push('--- HIGH CONFIDENCE UPDATES ---')
    lines.push('')
    for (const r of [...urlChanges, ...methodChanges]) {
      const u = r.suggested_update
      const parts = [`  ${r.service_id}`]
      if (u.url) parts.push(`url: ${r.registered_url} → ${u.url}`)
      if (u.http_method) parts.push(`method: ${u.http_method}`)
      parts.push(`stage: ${r.discovery_result.found_stage}`)
      lines.push(parts.join(' | '))
    }
  }

  if (transient.length > 0) {
    lines.push('')
    lines.push('--- TRANSIENT (registered URL works now) ---')
    lines.push('')
    for (const r of transient) {
      lines.push(`  ${r.service_id} | ${r.registered_url} | method: ${r.discovery_result.found_method}`)
    }
  }

  if (partial.length > 0) {
    lines.push('')
    lines.push('--- MANUAL REVIEW ---')
    lines.push('')
    for (const r of partial) {
      lines.push(`  ${r.service_id} | ${r.registered_url} | signals: ${r.landing_page_signals.join(', ')}`)
    }
  }

  if (notFound.length > 0) {
    lines.push('')
    lines.push('--- NO SIGNALS ---')
    lines.push('')
    for (const r of notFound) {
      const note = r.discovery_result.error || `last_status: ${r.last_status_code}`
      lines.push(`  ${r.service_id} | ${r.registered_url} | ${note}`)
    }
  }

  if (APPLY && (urlChanges.length + methodChanges.length > 0)) {
    lines.push('')
    lines.push('--- SQL UPDATE STATEMENTS ---')
    lines.push('')
    for (const r of [...urlChanges, ...methodChanges]) {
      const u = r.suggested_update
      if (u.url && u.http_method) {
        lines.push(`UPDATE services SET url = '${u.url.replace(/'/g, "''")}', http_method = '${u.http_method}', updated_at = datetime('now') WHERE id = '${r.service_id}';`)
      } else if (u.url) {
        lines.push(`UPDATE services SET url = '${u.url.replace(/'/g, "''")}', updated_at = datetime('now') WHERE id = '${r.service_id}';`)
      } else if (u.http_method) {
        lines.push(`UPDATE services SET http_method = '${u.http_method}', updated_at = datetime('now') WHERE id = '${r.service_id}';`)
      }
    }
  }

  return lines.join('\n')
}

// --- Main ---

async function main() {
  const startTime = Date.now()

  let endpoints
  try {
    endpoints = await fetchEndpoints()
  } catch (err) {
    log(`ERROR: Failed to fetch endpoints: ${err.message}`)
    process.exit(1)
  }

  if (endpoints.length === 0) {
    log('No endpoints to scan.')
    process.exit(0)
  }

  log(`Starting discovery on ${endpoints.length} endpoints (max ${MAX_CONCURRENT} concurrent)...`)
  log('')

  const reports = await runWithConcurrency(endpoints, MAX_CONCURRENT, async (endpoint, i) => {
    const n = `[${i + 1}/${endpoints.length}]`
    log(`${n} ${endpoint.provider || '?'} — ${endpoint.url}`)

    try {
      const report = await discoverEndpoint(endpoint)
      const status = report.discovery_result.status
      const detail = status === 'found'
        ? `→ ${report.discovery_result.found_method} ${report.discovery_result.found_url} (${report.discovery_result.found_stage})`
        : status === 'partial'
        ? `~ ${report.landing_page_signals.length} signals`
        : '✗ no L402 found'
      log(`${n}   ${status === 'found' ? '✓' : status === 'partial' ? '~' : '✗'} ${detail}`)
      return report
    } catch (err) {
      log(`${n}   ERROR: ${err.message}`)
      return {
        service_id: endpoint.id,
        registered_url: endpoint.url,
        registered_name: endpoint.name,
        source: endpoint.source,
        provider: endpoint.provider,
        current_health: endpoint.health_status,
        last_status_code: endpoint.last_status_code,
        discovery_result: { status: 'not_found', error: err.message },
        probes: [],
        landing_page_signals: [],
        suggested_update: null,
      }
    }
  })

  const duration = ((Date.now() - startTime) / 1000).toFixed(1)
  log('')
  log(`Discovery complete in ${duration}s`)
  log('')

  // Summary to stderr
  const summary = generateSummary(reports)
  log(summary)

  // JSON to stdout
  if (JSON_OUTPUT) {
    const output = {
      generated_at: new Date().toISOString(),
      duration_seconds: parseFloat(duration),
      total_scanned: reports.length,
      found: reports.filter(r => r.discovery_result.status === 'found').length,
      partial: reports.filter(r => r.discovery_result.status === 'partial').length,
      not_found: reports.filter(r => r.discovery_result.status === 'not_found').length,
      reports,
    }
    console.log(JSON.stringify(output, null, 2))
  }
}

main().catch(err => {
  log(`FATAL: ${err.message}`)
  process.exit(1)
})
