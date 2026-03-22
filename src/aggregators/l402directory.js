import db from '../db.js'
import { randomUUID } from 'crypto'
import { fetchBtcUsdRate, getCachedBtcUsdRate } from '../services/btc-price.js'
import { normalizeServices } from './l402directory-utils.js'

const L402DIR_URL = 'https://l402.directory/api/services'

// l402.directory is itself listed in its own directory — skip self-referential entries
const BLOCKED_HOSTS = new Set([
  'l402.directory',
])

// Lazy-initialized prepared statements
const stmts = {}
function stmt(key, sql) {
  if (!stmts[key]) stmts[key] = db.prepare(sql)
  return stmts[key]
}

const upsert = () => stmt('l402dirUpsert', `
  INSERT INTO services (id, name, description, url, protocol, price_sats, price_usd, payment_asset, payment_network, category, provider, source, source_id, http_method)
  VALUES (@id, @name, @description, @url, 'L402', @price_sats, @price_usd, 'BTC', 'Lightning', @category, @provider, 'l402directory', @source_id, @http_method)
  ON CONFLICT(url, protocol) DO UPDATE SET
    name = CASE WHEN services.domain_verified = 1 THEN services.name ELSE excluded.name END,
    description = CASE WHEN services.domain_verified = 1 THEN services.description ELSE COALESCE(excluded.description, services.description) END,
    price_sats = COALESCE(excluded.price_sats, services.price_sats),
    price_usd = COALESCE(excluded.price_usd, services.price_usd),
    category = CASE WHEN services.domain_verified = 1 THEN services.category ELSE CASE WHEN services.category = 'uncategorized' THEN excluded.category ELSE services.category END END,
    provider = CASE WHEN services.domain_verified = 1 THEN services.provider ELSE COALESCE(excluded.provider, services.provider) END,
    http_method = COALESCE(excluded.http_method, services.http_method),
    source = CASE
      WHEN services.source LIKE '%l402directory%' THEN services.source
      ELSE services.source || ',l402directory'
    END,
    updated_at = datetime('now')
    WHERE services.provider_deleted = 0 OR services.provider_deleted IS NULL
`)

const findExisting = () => stmt('l402dirFind', "SELECT id FROM services WHERE url = ? AND protocol = 'L402'")

export async function pollL402Directory() {
  console.log('[l402directory] Starting poll...')

  await fetchBtcUsdRate()
  const btcRate = getCachedBtcUsdRate()

  let data
  try {
    const res = await fetch(L402DIR_URL, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) {
      console.error(`[l402directory] HTTP ${res.status} fetching ${L402DIR_URL}`)
      return { new: 0, updated: 0, errors: 0 }
    }
    data = await res.json()
  } catch (err) {
    console.error(`[l402directory] Fetch error: ${err.message}`)
    return { new: 0, updated: 0, errors: 0 }
  }

  const services = data.services || []
  console.log(`[l402directory] Found ${services.length} services (${data.count || '?'} reported)`)

  const endpoints = normalizeServices(services)
  console.log(`[l402directory] ${endpoints.length} paid endpoints after normalization`)

  let newCount = 0
  let updatedCount = 0
  let errorCount = 0

  for (const ep of endpoints) {
    try {
      // Skip blocked hosts
      try {
        const host = new URL(ep.url).hostname
        if (BLOCKED_HOSTS.has(host)) continue
      } catch {
        // invalid URL — skip
        continue
      }

      // Compute USD price from sats
      if (ep.price_sats && btcRate) {
        ep.price_usd = (ep.price_sats / 100_000_000) * btcRate
      }

      const existing = findExisting().get(ep.url)
      if (existing) {
        ep.id = existing.id
      }
      upsert().run(ep)

      if (existing) updatedCount++
      else newCount++
    } catch (err) {
      errorCount++
      if (errorCount <= 5) {
        console.error(`[l402directory] Error upserting:`, err.message)
      }
    }
  }

  const totalSynced = newCount + updatedCount
  console.log(`[l402directory] Synced ${totalSynced} endpoints (${newCount} new, ${updatedCount} updated${errorCount > 0 ? `, ${errorCount} errors` : ''})`)
  return { new: newCount, updated: updatedCount, errors: errorCount }
}
