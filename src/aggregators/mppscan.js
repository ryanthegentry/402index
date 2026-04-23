import { randomUUID } from 'crypto'
import db from '../db.js'
import { normalizeUrl, extractHostname } from '../services/url-normalize.js'
import { categorize } from './l402apps-utils.js'
import { generateEmbedding } from '../services/embeddings.js'

const MPPSCAN_API = 'https://mppscan.com/api/trpc/servers.list'

const stmts = {}
function stmt(key, sql) {
  if (!stmts[key]) stmts[key] = db.prepare(sql)
  return stmts[key]
}

const CATEGORY_MAP = {
  ai: 'ai/llm',
  blockchain: 'blockchain',
  data: 'data',
  search: 'search',
  web: 'web-scraping',
  compute: 'compute',
  media: 'media',
  social: 'social',
  storage: 'storage',
}

function normalizeMppscanEndpoint(server, endpoint) {
  const baseUrl = server.url || ''
  const path = endpoint?.path || ''
  const fullUrl = normalizeUrl(`${baseUrl}${path}`)
  if (!fullUrl) return null

  const category = CATEGORY_MAP[server.category] || server.category || 'uncategorized'
  const finalCategory = category === 'uncategorized'
    ? categorize({ description: server.description || endpoint?.description || '' })
    : category

  return {
    id: randomUUID(),
    name: endpoint?.description
      ? `${server.name}: ${endpoint.description}`
      : server.name,
    description: endpoint?.description || server.description || null,
    url: fullUrl,
    price_usd: endpoint?.price ?? null,
    payment_asset: 'USDC',
    payment_network: 'Tempo',
    category: finalCategory,
    provider: server.name,
    source_id: `${server.id}:${path}`,
    http_method: endpoint?.method || 'GET',
    probe_body: (endpoint?.method === 'POST') ? '{}' : null,
    hostname: extractHostname(fullUrl),
  }
}

// Source-merge uses instr() exact token match (not LIKE '%mppscan%')
const upsertEndpoint = () => stmt('mppscanUpsert', `
  INSERT INTO services (id, name, description, url, protocol, price_usd, payment_asset, payment_network, category, provider, source, source_id, http_method, probe_body, hostname)
  VALUES (@id, @name, @description, @url, 'MPP', @price_usd, @payment_asset, @payment_network, @category, @provider, 'mppscan', @source_id, @http_method, @probe_body, @hostname)
  ON CONFLICT(url, protocol) DO UPDATE SET
    name = CASE WHEN services.domain_verified = 1 THEN services.name ELSE excluded.name END,
    description = CASE WHEN services.domain_verified = 1 THEN services.description ELSE COALESCE(excluded.description, services.description) END,
    price_usd = COALESCE(excluded.price_usd, services.price_usd),
    payment_asset = COALESCE(excluded.payment_asset, services.payment_asset),
    payment_network = COALESCE(excluded.payment_network, services.payment_network),
    category = CASE WHEN services.domain_verified = 1 THEN services.category ELSE CASE WHEN services.category = 'uncategorized' THEN excluded.category ELSE services.category END END,
    provider = CASE WHEN services.domain_verified = 1 THEN services.provider ELSE COALESCE(excluded.provider, services.provider) END,
    http_method = COALESCE(excluded.http_method, services.http_method),
    probe_body = COALESCE(excluded.probe_body, services.probe_body),
    hostname = COALESCE(excluded.hostname, services.hostname),
    source = CASE
      WHEN services.source = 'mppscan' THEN services.source
      WHEN instr(',' || services.source || ',', ',mppscan,') > 0 THEN services.source
      ELSE services.source || ',mppscan'
    END,
    provider_deleted = 0,
    approval_reason = CASE WHEN services.provider_deleted = 1 THEN 'mppscan-relisted' ELSE services.approval_reason END,
    updated_at = datetime('now')
  RETURNING *
`)

const findExisting = () => stmt('mppscanFindExisting', "SELECT id FROM services WHERE url = ? AND protocol = 'MPP' AND (provider_deleted = 0 OR provider_deleted IS NULL)")

// Sweep helpers — temp-table approach to avoid SQLITE_LIMIT_VARIABLE_NUMBER
const createSeenTable = () => stmt('mppscanCreateSeen', 'CREATE TEMP TABLE IF NOT EXISTS mppscan_seen_urls (url TEXT PRIMARY KEY)')
const clearSeenTable = () => stmt('mppscanClearSeen', 'DELETE FROM mppscan_seen_urls')
const insertSeen = () => stmt('mppscanInsertSeen', 'INSERT OR IGNORE INTO mppscan_seen_urls (url) VALUES (?)')
const sweepStale = () => stmt('mppscanSweep', `
  UPDATE services
     SET provider_deleted = 1, deleted_at = datetime('now')
   WHERE source = 'mppscan'
     AND (provider_deleted = 0 OR provider_deleted IS NULL)
     AND url NOT IN (SELECT url FROM mppscan_seen_urls)
`)
const dropSeenTable = () => stmt('mppscanDropSeen', 'DROP TABLE IF EXISTS mppscan_seen_urls')

export async function pollMppscan() {
  console.log('[mppscan] Starting poll...')

  let data
  try {
    const res = await fetch(MPPSCAN_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ json: {} }),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) {
      console.error(`[mppscan] HTTP ${res.status} fetching API`)
      return { new: 0, updated: 0, errors: 0, swept: 0 }
    }
    data = await res.json()
  } catch (err) {
    console.error(`[mppscan] Fetch error: ${err.message}`)
    return { new: 0, updated: 0, errors: 0, swept: 0 }
  }

  const servers = data?.result?.data?.json || []
  console.log(`[mppscan] Found ${servers.length} servers`)

  if (servers.length === 0) {
    console.warn('[mppscan] Empty servers array — skipping sweep')
    return { new: 0, updated: 0, errors: 0, swept: 0 }
  }

  let newCount = 0
  let updatedCount = 0
  let errorCount = 0
  const seenUrls = new Set()

  for (const server of servers) {
    const endpoints = server.endpoints || [{ method: 'GET', path: '', description: server.description }]
    for (const ep of endpoints) {
      try {
        const record = normalizeMppscanEndpoint(server, ep)
        if (!record) continue

        seenUrls.add(record.url)
        const existing = findExisting().get(record.url)
        const row = upsertEndpoint().get(record)
        if (existing) updatedCount++
        else {
          newCount++
          if (row && row.registered_at === row.updated_at) {
            setImmediate(() => generateEmbedding(row.id).catch(() => {}))
          }
        }
      } catch (err) {
        errorCount++
        if (errorCount <= 5) console.error(`[mppscan] Error processing ${server.name}:`, err.message)
      }
    }
  }

  // Normalization-failure amplification guard: if most servers failed to normalize,
  // seenUrls will be much smaller than the API response, causing an overly broad sweep.
  // Skip sweep if <10% of servers produced valid URLs.
  let swept = 0
  if (seenUrls.size < servers.length * 0.1) {
    console.warn(`[mppscan] Normalization anomaly: only ${seenUrls.size} URLs from ${servers.length} servers — skipping sweep`)
    const totalSynced = newCount + updatedCount
    console.log(`[mppscan] Synced ${totalSynced} endpoints (${newCount} new, ${updatedCount} updated${errorCount > 0 ? `, ${errorCount} errors` : ''})`)
    return { new: newCount, updated: updatedCount, errors: errorCount, swept: 0 }
  }

  // Sweep stale rows via temp table
  try {
    createSeenTable().run()
    clearSeenTable().run()

    const insertSeenStmt = insertSeen()
    db.transaction(() => {
      for (const url of seenUrls) {
        insertSeenStmt.run(url)
      }
    })()

    const result = sweepStale().run()
    swept = result.changes
    if (swept > 0) {
      console.log(`[mppscan] Swept ${swept} stale rows`)
    }

    dropSeenTable().run()
  } catch (err) {
    console.error(`[mppscan] Sweep error: ${err.message}`)
    try { dropSeenTable().run() } catch { /* ignore cleanup error */ }
  }

  const totalSynced = newCount + updatedCount
  console.log(`[mppscan] Synced ${totalSynced} endpoints (${newCount} new, ${updatedCount} updated${errorCount > 0 ? `, ${errorCount} errors` : ''}${swept > 0 ? `, ${swept} swept` : ''})`)
  return { new: newCount, updated: updatedCount, errors: errorCount, swept }
}
