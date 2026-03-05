import { randomUUID } from 'crypto'
import db from '../db.js'
import { normalizeUrl } from '../services/url-normalize.js'
import { categorize } from './l402apps-utils.js'

const SPONGE_API = 'https://api.catalog.paysponge.com/api/services'

const stmts = {}
function stmt(key, sql) {
  if (!stmts[key]) stmts[key] = db.prepare(sql)
  return stmts[key]
}

const upsertEndpoint = () => stmt('spongeUpsert', `
  INSERT INTO services (id, name, description, url, protocol, price_usd, payment_asset, payment_network, category, provider, source, source_id, http_method)
  VALUES (@id, @name, @description, @url, 'x402', @price_usd, 'USDC', @payment_network, @category, @provider, 'sponge', @source_id, @http_method)
  ON CONFLICT(url, protocol) DO UPDATE SET
    name = excluded.name,
    description = COALESCE(excluded.description, services.description),
    price_usd = COALESCE(excluded.price_usd, services.price_usd),
    payment_network = COALESCE(excluded.payment_network, services.payment_network),
    category = CASE WHEN services.category = 'uncategorized' THEN excluded.category ELSE services.category END,
    provider = COALESCE(excluded.provider, services.provider),
    http_method = COALESCE(excluded.http_method, services.http_method),
    source = CASE
      WHEN services.source LIKE '%sponge%' THEN services.source
      ELSE services.source || ',sponge'
    END,
    updated_at = datetime('now')
`)

const findExisting = () => stmt('spongeFindExisting', "SELECT id FROM services WHERE url = ? AND protocol = 'x402'")

const NETWORK_MAP = { base: 'Base', solana: 'Solana', polygon: 'Polygon', tempo: 'Tempo' }

function mapNetwork(network) {
  return NETWORK_MAP[network] || network
}

export async function pollSponge() {
  console.log('[sponge] Starting poll...')

  let listing
  try {
    const res = await fetch(SPONGE_API, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) {
      console.error(`[sponge] HTTP ${res.status} fetching listing`)
      return { new: 0, updated: 0, errors: 0 }
    }
    listing = await res.json()
  } catch (err) {
    console.error(`[sponge] Fetch error: ${err.message}`)
    return { new: 0, updated: 0, errors: 0 }
  }

  const services = Array.isArray(listing) ? listing : listing.data || []
  console.log(`[sponge] Found ${services.length} services`)

  let newCount = 0
  let updatedCount = 0
  let errorCount = 0

  for (const svc of services) {
    try {
      // Fetch service detail for individual endpoints
      const detailRes = await fetch(`${SPONGE_API}/${svc.id}`, { signal: AbortSignal.timeout(10000) })
      if (!detailRes.ok) {
        errorCount++
        if (errorCount <= 5) console.error(`[sponge] HTTP ${detailRes.status} fetching detail for ${svc.name}`)
        continue
      }
      const detailJson = await detailRes.json()
      const detail = detailJson.data || detailJson

      const configs = svc.paymentsProtocolConfig || []
      const x402Config = configs.find(c => c.protocol === 'x402')
      if (!x402Config) continue

      const baseUrl = x402Config.baseUrl
      const networks = (x402Config.networks || []).map(mapNetwork)
      const paymentNetwork = networks.join(', ') || 'Base'

      const endpoints = detail.endpoints || []
      for (const ep of endpoints) {
        const path = ep.path || ''
        const fullUrl = normalizeUrl(`${baseUrl}${path}`)
        const priceUsd = ep.price != null ? ep.price / 1_000_000 : null

        const record = {
          id: randomUUID(),
          name: `${svc.name}: ${ep.description || path}`,
          description: ep.description || ep.instructions || null,
          url: fullUrl,
          price_usd: priceUsd,
          payment_network: paymentNetwork,
          category: svc.category ? svc.category.replace(/_/g, '/') : categorize({ description: svc.description || '' }),
          provider: svc.name,
          source_id: ep.id || svc.id,
          http_method: (ep.httpMethod || 'GET').toUpperCase(),
        }

        const existing = findExisting().get(fullUrl)
        upsertEndpoint().run(record)
        if (existing) updatedCount++
        else newCount++
      }
    } catch (err) {
      errorCount++
      if (errorCount <= 5) console.error(`[sponge] Error processing ${svc.name}:`, err.message)
    }
  }

  const totalSynced = newCount + updatedCount
  console.log(`[sponge] Synced ${totalSynced} endpoints (${newCount} new, ${updatedCount} updated${errorCount > 0 ? `, ${errorCount} errors` : ''})`)
  return { new: newCount, updated: updatedCount, errors: errorCount }
}
