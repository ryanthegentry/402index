import fetch from 'node-fetch'
import { v4 as uuidv4 } from 'uuid'
import db from '../db.js'

const SATRING_URL = 'https://satring.com/api/v1/services'
const PAGE_SIZE = 20 // Satring max per page

const upsert = db.prepare(`
  INSERT INTO services (id, name, description, url, protocol, price_sats, price_usd, payment_asset, payment_network, category, provider, source, source_id)
  VALUES (@id, @name, @description, @url, 'L402', @price_sats, @price_usd, 'BTC/Lightning', 'lightning', @category, @provider, 'satring', @source_id)
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

const findExisting = db.prepare("SELECT id FROM services WHERE url = ? AND protocol = 'L402'")

// Rough BTC/USD conversion for sats → USD
// In production, you'd fetch a real exchange rate
const SATS_PER_BTC = 100_000_000
const BTC_USD = 90_000 // approximate, updated manually

function satsToUsd(sats) {
  if (sats == null || sats === 0) return null
  return (sats / SATS_PER_BTC) * BTC_USD
}

function mapCategory(categories) {
  if (!categories || categories.length === 0) return null
  // Use first category, map Satring slugs to our hierarchy
  const slug = categories[0].slug
  const map = {
    'ai-ml': 'ai/ml',
    'finance': 'crypto/prices',
    'data': 'real-time-data',
    'weather': 'real-time-data/weather',
    'search': 'tools/search',
    'tools': 'tools',
    'social': 'social',
    'identity': 'identity',
    'media': 'media',
    'compute': 'compute',
    'storage': 'storage',
  }
  return map[slug] || slug
}

function normalizeService(svc) {
  return {
    id: uuidv4(),
    name: svc.name || svc.url,
    description: svc.description || null,
    url: svc.url,
    price_sats: svc.pricing_sats || null,
    price_usd: satsToUsd(svc.pricing_sats),
    category: mapCategory(svc.categories),
    provider: svc.owner_name || null,
    source_id: String(svc.id),
  }
}

export async function pollSatring() {
  if (process.env.SATRING_ENABLED !== 'true') {
    console.log('[satring] Disabled (set SATRING_ENABLED=true to enable)')
    return { new: 0, updated: 0, skipped: true }
  }

  console.log('[satring] Starting poll...')

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
        if (!svc.url) {
          errorCount++
          continue
        }

        const normalized = normalizeService(svc)
        const existing = findExisting.get(normalized.url)

        upsert.run(normalized)

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
