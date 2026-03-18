import db from '../db.js'
import { normalizeMppEndpoint } from './mpp-utils.js'

const MPP_API = 'https://mpp.dev/api/services'

const stmts = {}
function stmt(key, sql) {
  if (!stmts[key]) stmts[key] = db.prepare(sql)
  return stmts[key]
}

const upsertEndpoint = () => stmt('mppUpsert', `
  INSERT INTO services (id, name, description, url, protocol, price_usd, payment_asset, payment_network, category, provider, source, source_id, http_method, probe_body)
  VALUES (@id, @name, @description, @url, 'MPP', @price_usd, @payment_asset, @payment_network, @category, @provider, 'mpp', @source_id, @http_method, @probe_body)
  ON CONFLICT(url, protocol) DO UPDATE SET
    name = excluded.name,
    description = COALESCE(excluded.description, services.description),
    price_usd = COALESCE(excluded.price_usd, services.price_usd),
    payment_asset = COALESCE(excluded.payment_asset, services.payment_asset),
    payment_network = COALESCE(excluded.payment_network, services.payment_network),
    category = CASE WHEN services.category = 'uncategorized' THEN excluded.category ELSE services.category END,
    provider = COALESCE(excluded.provider, services.provider),
    http_method = COALESCE(excluded.http_method, services.http_method),
    probe_body = COALESCE(excluded.probe_body, services.probe_body),
    source = CASE
      WHEN services.source LIKE '%mpp%' THEN services.source
      ELSE services.source || ',mpp'
    END,
    updated_at = datetime('now')
`)

const findExisting = () => stmt('mppFindExisting', "SELECT id FROM services WHERE url = ? AND protocol = 'MPP'")

export async function pollMPP() {
  console.log('[mpp] Starting poll...')

  let data
  try {
    const res = await fetch(MPP_API, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) {
      console.error(`[mpp] HTTP ${res.status} fetching API`)
      return { new: 0, updated: 0, errors: 0 }
    }
    data = await res.json()
  } catch (err) {
    console.error(`[mpp] Fetch error: ${err.message}`)
    return { new: 0, updated: 0, errors: 0 }
  }

  const services = data?.services || []
  console.log(`[mpp] Found ${services.length} services`)

  let newCount = 0
  let updatedCount = 0
  let errorCount = 0

  for (const svc of services) {
    const endpoints = svc.endpoints || []
    for (const ep of endpoints) {
      try {
        const record = normalizeMppEndpoint(svc, ep)
        if (!record) continue // free endpoint

        const existing = findExisting().get(record.url)
        upsertEndpoint().run(record)
        if (existing) updatedCount++
        else newCount++
      } catch (err) {
        errorCount++
        if (errorCount <= 5) console.error(`[mpp] Error processing ${svc.name} ${ep.path}:`, err.message)
      }
    }
  }

  const totalSynced = newCount + updatedCount
  console.log(`[mpp] Synced ${totalSynced} endpoints (${newCount} new, ${updatedCount} updated${errorCount > 0 ? `, ${errorCount} errors` : ''})`)
  return { new: newCount, updated: updatedCount, errors: errorCount }
}
