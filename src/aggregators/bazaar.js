import fetch from 'node-fetch'
import { v4 as uuidv4 } from 'uuid'
import db from '../db.js'

const BAZAAR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources'
const PAGE_SIZE = 100
const MAX_RETRIES = 5
const PAGE_DELAY_MS = 1000

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const upsert = db.prepare(`
  INSERT INTO services (id, name, description, url, protocol, price_usd, payment_asset, payment_network, category, input_schema, output_schema, provider, source, source_id)
  VALUES (@id, @name, @description, @url, 'x402', @price_usd, @payment_asset, @payment_network, @category, @input_schema, @output_schema, @provider, 'bazaar', @source_id)
  ON CONFLICT(url, protocol) DO UPDATE SET
    name = excluded.name,
    description = excluded.description,
    price_usd = excluded.price_usd,
    payment_asset = excluded.payment_asset,
    payment_network = excluded.payment_network,
    category = excluded.category,
    input_schema = excluded.input_schema,
    output_schema = excluded.output_schema,
    provider = excluded.provider,
    source_id = excluded.source_id,
    updated_at = datetime('now')
`)

function mapNetworkToPaymentNetwork(network) {
  const map = {
    'base': 'eip155:8453',
    'base-sepolia': 'eip155:84532',
    'ethereum': 'eip155:1',
    'arbitrum': 'eip155:42161',
    'optimism': 'eip155:10',
    'polygon': 'eip155:137',
  }
  return map[network] || network
}

function extractProviderFromUrl(url) {
  try {
    const hostname = new URL(url).hostname
    // Strip common prefixes
    return hostname.replace(/^(www|api|public)\./, '').split('.')[0]
  } catch {
    return null
  }
}

function categorizeFromDescription(description) {
  if (!description) return null
  const d = description.toLowerCase()

  if (d.includes('nft')) return 'crypto/nft'
  if (d.includes('token balance') || d.includes('token holding')) return 'crypto/balances'
  if (d.includes('token price') || d.includes('market cap')) return 'crypto/prices'
  if (d.includes('defi') || d.includes('liquidity') || d.includes('swap')) return 'crypto/defi'
  if (d.includes('transaction') || d.includes('transfer')) return 'crypto/transactions'
  if (d.includes('wallet') || d.includes('portfolio')) return 'crypto/wallet'
  if (d.includes('weather') || d.includes('forecast')) return 'real-time-data/weather'
  if (d.includes('news')) return 'real-time-data/news'
  if (d.includes('search')) return 'tools/search'
  if (d.includes('image') || d.includes('photo')) return 'media/images'
  return null
}

function normalizeItem(item) {
  const accept = item.accepts?.[0]
  if (!accept) return null

  const url = item.resource || accept.resource
  if (!url) return null

  const maxAmount = accept.maxAmountRequired
  // USDC has 6 decimals
  const priceUsd = maxAmount ? parseFloat(maxAmount) / 1e6 : null

  const assetName = accept.extra?.name || null
  const paymentAsset = assetName ? `${assetName}` : 'USDC'

  const description = accept.description || null
  const provider = extractProviderFromUrl(url)
  const name = description
    ? description.substring(0, 80) + (description.length > 80 ? '...' : '')
    : url

  // Build a stable source_id from the URL (Bazaar doesn't have a unique ID per resource)
  const sourceId = url

  return {
    id: uuidv4(),
    name,
    description,
    url,
    price_usd: priceUsd,
    payment_asset: paymentAsset,
    payment_network: mapNetworkToPaymentNetwork(accept.network || 'base'),
    category: categorizeFromDescription(description) || 'uncategorized',
    input_schema: accept.outputSchema?.input ? JSON.stringify(accept.outputSchema.input) : null,
    output_schema: accept.outputSchema?.output ? JSON.stringify(accept.outputSchema.output) : null,
    provider,
    source_id: sourceId,
  }
}

const findExisting = db.prepare('SELECT id FROM services WHERE url = ? AND protocol = ?')

const getSyncState = db.prepare('SELECT value FROM sync_state WHERE key = ?')
const setSyncState = db.prepare(`
  INSERT INTO sync_state (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
`)

export async function pollBazaar() {
  console.log('[bazaar] Starting poll...')

  // Resume from last saved offset
  const savedOffset = getSyncState.get('bazaar_offset')
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
        if (!normalized) {
          errorCount++
          continue
        }

        // Skip dupes within this poll
        if (seen.has(normalized.url)) continue
        seen.add(normalized.url)

        // Check if service already exists
        const existing = findExisting.get(normalized.url, 'x402')

        upsert.run(normalized)

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
    setSyncState.run('bazaar_offset', String(offset))

    // Rate limit courtesy delay between pages
    if (total !== null && offset < total) {
      await sleep(PAGE_DELAY_MS)
    }
  }

  // If we reached the end (or past it), reset offset for next full pass
  if (total !== null && offset >= total) {
    setSyncState.run('bazaar_offset', '0')
    console.log(`[bazaar] Completed full catalog pass, resetting offset to 0`)
  }

  const totalSynced = newCount + updatedCount
  console.log(`[bazaar] Synced ${totalSynced} services from Bazaar (${newCount} new, ${updatedCount} updated${errorCount > 0 ? `, ${errorCount} errors` : ''})`)
  return { new: newCount, updated: updatedCount, errors: errorCount }
}
