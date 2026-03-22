import db from '../db.js'
import { fetchBtcUsdRate, getCachedBtcUsdRate } from '../services/btc-price.js'
import { parseL402AppsHtml, normalizeApi } from './l402apps-utils.js'
import { extractHostname } from '../services/url-normalize.js'

const L402APPS_URL = 'https://www.l402apps.com'

// Lazy-initialized prepared statements
const stmts = {}
function stmt(key, sql) {
  if (!stmts[key]) stmts[key] = db.prepare(sql)
  return stmts[key]
}

const upsertNew = () => stmt('upsertNew', `
  INSERT INTO services (id, name, description, url, protocol, price_sats, price_usd, payment_asset, payment_network, category, provider, source, source_id, hostname)
  VALUES (@id, @name, @description, @url, 'L402', @price_sats, @price_usd, 'BTC', 'Lightning', @category, @provider, 'l402apps', @source_id, @hostname)
  ON CONFLICT(url, protocol) DO UPDATE SET
    name = CASE WHEN services.domain_verified = 1 THEN services.name ELSE excluded.name END,
    description = CASE WHEN services.domain_verified = 1 THEN services.description ELSE excluded.description END,
    price_sats = COALESCE(excluded.price_sats, services.price_sats),
    price_usd = COALESCE(excluded.price_usd, services.price_usd),
    category = CASE WHEN services.domain_verified = 1 THEN services.category ELSE CASE WHEN services.category = 'uncategorized' THEN excluded.category ELSE services.category END END,
    provider = CASE WHEN services.domain_verified = 1 THEN services.provider ELSE COALESCE(excluded.provider, services.provider) END,
    hostname = COALESCE(excluded.hostname, services.hostname),
    source = CASE
      WHEN services.source LIKE '%l402apps%' THEN services.source
      ELSE services.source || ',l402apps'
    END,
    updated_at = datetime('now')
    WHERE services.provider_deleted = 0 OR services.provider_deleted IS NULL
`)

const findExisting = () => stmt('findExisting', "SELECT id, source FROM services WHERE url = ? AND protocol = 'L402'")

export async function pollL402Apps() {
  console.log('[l402apps] Starting poll...')

  await fetchBtcUsdRate()
  const btcRate = getCachedBtcUsdRate()

  let html
  try {
    const res = await fetch(L402APPS_URL, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) {
      console.error(`[l402apps] HTTP ${res.status} fetching ${L402APPS_URL}`)
      return { new: 0, updated: 0, errors: 0 }
    }
    html = await res.text()
  } catch (err) {
    console.error(`[l402apps] Fetch error: ${err.message}`)
    return { new: 0, updated: 0, errors: 0 }
  }

  const { apis } = parseL402AppsHtml(html)
  console.log(`[l402apps] Parsed ${apis.length} APIs`)

  let newCount = 0
  let updatedCount = 0
  let errorCount = 0

  for (const api of apis) {
    try {
      const normalized = normalizeApi(api, btcRate)

      // Skip .well-known discovery URLs — metadata documents, not L402 endpoints
      if (normalized.url.includes('/.well-known/')) {
        continue
      }

      normalized.hostname = extractHostname(normalized.url)
      const existing = findExisting().get(normalized.url)
      upsertNew().run(normalized)
      if (existing) updatedCount++
      else newCount++
    } catch (err) {
      errorCount++
      if (errorCount <= 5) console.error(`[l402apps] Error processing API ${api.name}:`, err.message)
    }
  }

  const totalSynced = newCount + updatedCount
  console.log(`[l402apps] Synced ${totalSynced} services (${newCount} new, ${updatedCount} updated${errorCount > 0 ? `, ${errorCount} errors` : ''})`)
  return { new: newCount, updated: updatedCount, errors: errorCount }
}
