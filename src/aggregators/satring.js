import db from '../db.js'
import { fetchBtcUsdRate, getCachedBtcUsdRate } from '../services/btc-price.js'
import { normalizeRawService } from './satring-utils.js'
import { extractHostname } from '../services/url-normalize.js'

const SATRING_URL = 'https://satring.com/api/v1/services'

// Permanently skip confirmed junk providers (not valid on either L402 or x402)
export const BLOCKED_HOSTS = new Set([
  // LightningProx ecosystem — prepaid spend tokens, not per-request L402 or x402
  'lightningprox.com',
  'lpxpoly.com',
  'satsforai.com',
])
const PAGE_SIZE = 20 // Satring max per page
const PAGE_DELAY_MS = 8000 // Delay between pages to avoid rate limiting
const RATE_LIMIT_WAIT_MS = 30000 // Wait time on 429 before retry

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Lazy-initialized prepared statements
const stmts = {}
function stmt(key, sql) {
  if (!stmts[key]) stmts[key] = db.prepare(sql)
  return stmts[key]
}

const upsert = () => stmt('upsert', `
  INSERT INTO services (id, name, description, url, protocol, price_sats, price_usd, payment_asset, payment_network, category, provider, source, source_id, hostname)
  VALUES (@id, @name, @description, @url, @protocol, @price_sats, @price_usd, @payment_asset, @payment_network, @category, @provider, 'satring', @source_id, @hostname)
  ON CONFLICT(url, protocol) DO UPDATE SET
    name = CASE WHEN services.domain_verified = 1 THEN services.name ELSE excluded.name END,
    description = CASE WHEN services.domain_verified = 1 THEN services.description ELSE excluded.description END,
    price_sats = excluded.price_sats,
    price_usd = excluded.price_usd,
    payment_asset = excluded.payment_asset,
    payment_network = excluded.payment_network,
    category = CASE WHEN services.domain_verified = 1 THEN services.category ELSE excluded.category END,
    provider = CASE WHEN services.domain_verified = 1 THEN services.provider ELSE excluded.provider END,
    source_id = excluded.source_id,
    hostname = COALESCE(excluded.hostname, services.hostname),
    updated_at = datetime('now')
    WHERE services.provider_deleted = 0 OR services.provider_deleted IS NULL
`)

const findExisting = () => stmt('findExisting', 'SELECT id FROM services WHERE url = ? AND protocol = ?')

async function fetchPage(page) {
  const res = await fetch(`${SATRING_URL}?page=${page}&page_size=${PAGE_SIZE}`)

  if (res.status === 429) {
    console.log(`[satring] Rate limited at page ${page}, waiting ${RATE_LIMIT_WAIT_MS / 1000}s...`)
    await sleep(RATE_LIMIT_WAIT_MS)
    const retry = await fetch(`${SATRING_URL}?page=${page}&page_size=${PAGE_SIZE}`)
    if (!retry.ok) {
      console.error(`[satring] Retry failed with ${retry.status} at page ${page}`)
      return null
    }
    return retry.json()
  }

  if (!res.ok) {
    console.error(`[satring] API returned ${res.status} at page ${page}`)
    return null
  }

  return res.json()
}

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
    const data = await fetchPage(page).catch(err => {
      console.error(`[satring] Fetch error at page ${page}:`, err.message)
      return null
    })

    if (!data) break

    if (totalPages === null) {
      const total = data.total || 0
      totalPages = Math.ceil(total / PAGE_SIZE)
      console.log(`[satring] Total services: ${total} (${totalPages} pages)`)
    }

    const services = data.services || []
    if (services.length === 0) break

    for (const svc of services) {
      try {
        const rows = normalizeRawService(svc, getCachedBtcUsdRate())

        for (const normalized of rows) {
          // Skip .well-known discovery URLs — these are metadata documents, not endpoints
          if (normalized.url.includes('/.well-known/')) {
            continue
          }

          // Skip blocked hosts (confirmed junk providers)
          try {
            const host = new URL(normalized.url).hostname
            if (BLOCKED_HOSTS.has(host)) {
              continue
            }
          } catch {
            // invalid URL — let upsert handle it
          }

          normalized.hostname = extractHostname(normalized.url)
          const existing = findExisting().get(normalized.url, normalized.protocol)

          upsert().run(normalized)

          if (existing) {
            updatedCount++
          } else {
            newCount++
          }
        }
      } catch (err) {
        errorCount++
        if (errorCount <= 5) {
          console.error(`[satring] Error normalizing service:`, err.message)
        }
      }
    }

    page++

    // Delay between pages to respect rate limits
    if (totalPages !== null && page <= totalPages) {
      await sleep(PAGE_DELAY_MS)
    }
  }

  const totalSynced = newCount + updatedCount
  console.log(`[satring] Synced ${totalSynced} services from Satring (${newCount} new, ${updatedCount} updated${errorCount > 0 ? `, ${errorCount} errors` : ''})`)
  return { new: newCount, updated: updatedCount, errors: errorCount }
}
