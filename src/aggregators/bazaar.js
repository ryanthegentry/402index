import db from '../db.js'
import { normalizeItem } from './bazaar-utils.js'
import { extractHostname } from '../services/url-normalize.js'

const BAZAAR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources'
const PAGE_SIZE = 100
const MAX_RETRIES = 5
const PAGE_DELAY_MS = 1000

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
  INSERT INTO services (id, name, description, url, protocol, price_usd, payment_asset, payment_network, category, input_schema, output_schema, provider, source, source_id, hostname)
  VALUES (@id, @name, @description, @url, 'x402', @price_usd, @payment_asset, @payment_network, @category, @input_schema, @output_schema, @provider, 'bazaar', @source_id, @hostname)
  ON CONFLICT(url, protocol) DO UPDATE SET
    name = CASE WHEN services.domain_verified = 1 THEN services.name ELSE excluded.name END,
    description = CASE WHEN services.domain_verified = 1 THEN services.description ELSE excluded.description END,
    price_usd = excluded.price_usd,
    payment_asset = excluded.payment_asset,
    payment_network = excluded.payment_network,
    category = CASE WHEN services.domain_verified = 1 THEN services.category ELSE excluded.category END,
    input_schema = excluded.input_schema,
    output_schema = excluded.output_schema,
    provider = CASE WHEN services.domain_verified = 1 THEN services.provider ELSE excluded.provider END,
    source_id = excluded.source_id,
    hostname = COALESCE(excluded.hostname, services.hostname),
    updated_at = datetime('now')
    WHERE services.provider_deleted = 0 OR services.provider_deleted IS NULL
`)

const findExisting = () => stmt('findExisting', 'SELECT id FROM services WHERE url = ? AND protocol = ?')

const getSyncState = () => stmt('getSyncState', 'SELECT value FROM sync_state WHERE key = ?')
const setSyncState = () => stmt('setSyncState', `
  INSERT INTO sync_state (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
`)

export async function pollBazaar() {
  console.log('[bazaar] Starting poll...')

  // Resume from last saved offset
  const savedOffset = getSyncState().get('bazaar_offset')
  let offset = savedOffset ? parseInt(savedOffset.value) || 0 : 0
  if (offset > 0) console.log(`[bazaar] Resuming from saved offset ${offset}`)
  let total = null
  let newCount = 0
  let updatedCount = 0
  let errorCount = 0

  // Track which URLs we've seen this poll to handle dupes within a single poll
  const seen = new Set()

  while (total === null || offset < total) {
    const url = `${BAZAAR_URL}?limit=${PAGE_SIZE}&offset=${offset}`

    let data
    let fetched = false
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(url)
        if (res.status === 429) {
          const backoff = Math.pow(2, attempt + 1) * 1000
          console.warn(`[bazaar] Rate limited at offset ${offset}, retrying in ${backoff / 1000}s...`)
          await sleep(backoff)
          continue
        }
        if (!res.ok) {
          console.error(`[bazaar] API returned ${res.status} at offset ${offset}`)
          break
        }
        data = await res.json()
        fetched = true
        break
      } catch (err) {
        console.error(`[bazaar] Fetch error at offset ${offset} (attempt ${attempt + 1}):`, err.message)
        if (attempt < MAX_RETRIES - 1) await sleep(2000)
      }
    }
    if (!fetched) {
      console.warn(`[bazaar] Stopping at offset ${offset} after failed retries. Will resume next poll.`)
      break
    }

    if (total === null) {
      total = data.pagination?.total || 0
      console.log(`[bazaar] Total resources in Bazaar: ${total}`)
    }

    const items = data.items || []
    if (items.length === 0) break

    for (const item of items) {
      try {
        const normalized = normalizeItem(item)

        // Skip dupes within this poll
        if (seen.has(normalized.url)) continue
        seen.add(normalized.url)

        normalized.hostname = extractHostname(normalized.url)

        // Check if service already exists
        const existing = findExisting().get(normalized.url, 'x402')

        upsert().run(normalized)

        if (existing) {
          updatedCount++
        } else {
          newCount++
        }
      } catch (err) {
        errorCount++
        if (errorCount <= 5) {
          console.error(`[bazaar] Error normalizing item:`, err.message)
        }
      }
    }

    offset += PAGE_SIZE

    // Persist offset so next poll can resume here if we get rate-limited
    setSyncState().run('bazaar_offset', String(offset))

    // Rate limit courtesy delay between pages
    if (total !== null && offset < total) {
      await sleep(PAGE_DELAY_MS)
    }
  }

  // If we reached the end (or past it), reset offset for next full pass
  if (total !== null && offset >= total) {
    setSyncState().run('bazaar_offset', '0')
    console.log(`[bazaar] Completed full catalog pass, resetting offset to 0`)
  }

  const totalProcessed = newCount + updatedCount + errorCount
  const totalSynced = newCount + updatedCount

  // Alert if >50% of items failed normalization — API format may have changed
  if (totalProcessed > 0 && errorCount > 0.5 * totalProcessed) {
    console.error(`[bazaar] ALERT: >50% of Bazaar items failed to normalize (${errorCount}/${totalProcessed}). API format may have changed!`)
  }

  console.log(`[bazaar] Synced ${totalSynced} services from Bazaar (${newCount} new, ${updatedCount} updated${errorCount > 0 ? `, ${errorCount} errors` : ''})`)
  return { new: newCount, updated: updatedCount, errors: errorCount }
}
