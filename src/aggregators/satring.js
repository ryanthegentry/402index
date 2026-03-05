import db from '../db.js'
import { fetchBtcUsdRate, getCachedBtcUsdRate } from '../services/btc-price.js'
import { normalizeRawService } from './satring-utils.js'

const SATRING_URL = 'https://satring.com/api/v1/services'
const PAGE_SIZE = 20 // Satring max per page

// Lazy-initialized prepared statements
const stmts = {}
function stmt(key, sql) {
  if (!stmts[key]) stmts[key] = db.prepare(sql)
  return stmts[key]
}

const upsert = () => stmt('upsert', `
  INSERT INTO services (id, name, description, url, protocol, price_sats, price_usd, payment_asset, payment_network, category, provider, source, source_id)
  VALUES (@id, @name, @description, @url, 'L402', @price_sats, @price_usd, 'BTC', 'Lightning', @category, @provider, 'satring', @source_id)
  ON CONFLICT(url, protocol) DO UPDATE SET
    name = excluded.name,
    description = excluded.description,
    price_sats = excluded.price_sats,
    price_usd = excluded.price_usd,
    category = excluded.category,
    provider = excluded.provider,
    source_id = excluded.source_id,
    updated_at = datetime('now')
`)

const findExisting = () => stmt('findExisting', "SELECT id FROM services WHERE url = ? AND protocol = 'L402'")

export async function pollSatring() {
  if (process.env.SATRING_ENABLED !== 'true') {
    console.log('[satring] Disabled (set SATRING_ENABLED=true to enable)')
    return { new: 0, updated: 0, skipped: true }
  }

  console.log('[satring] Starting poll...')

  // Refresh BTC/USD rate before converting sats prices
  await fetchBtcUsdRate()

  let page = 1
  let totalPages = null
  let newCount = 0
  let updatedCount = 0
  let errorCount = 0

  while (totalPages === null || page <= totalPages) {
    let data
    try {
      const res = await fetch(`${SATRING_URL}?page=${page}&page_size=${PAGE_SIZE}`)
      if (!res.ok) {
        console.error(`[satring] API returned ${res.status} at page ${page}`)
        break
      }
      data = await res.json()
    } catch (err) {
      console.error(`[satring] Fetch error at page ${page}:`, err.message)
      break
    }

    if (totalPages === null) {
      const total = data.total || 0
      totalPages = Math.ceil(total / PAGE_SIZE)
      console.log(`[satring] Total services: ${total} (${totalPages} pages)`)
    }

    const services = data.services || []
    if (services.length === 0) break

    for (const svc of services) {
      try {
        const normalized = normalizeRawService(svc, getCachedBtcUsdRate())

        // Skip .well-known discovery URLs — these are metadata documents, not L402 endpoints
        if (normalized.url.includes('/.well-known/')) {
          continue
        }

        const existing = findExisting().get(normalized.url)

        upsert().run(normalized)

        if (existing) {
          updatedCount++
        } else {
          newCount++
        }
      } catch (err) {
        errorCount++
        if (errorCount <= 5) {
          console.error(`[satring] Error normalizing service:`, err.message)
        }
      }
    }

    page++
  }

  const totalSynced = newCount + updatedCount
  console.log(`[satring] Synced ${totalSynced} services from Satring (${newCount} new, ${updatedCount} updated${errorCount > 0 ? `, ${errorCount} errors` : ''})`)
  return { new: newCount, updated: updatedCount, errors: errorCount }
}
