import { readdirSync, readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import yaml from 'js-yaml'
import { randomUUID } from 'crypto'
import db from './db.js'
import { normalizeUrl, extractHostname } from './services/url-normalize.js'
import { generateEmbedding } from './services/embeddings.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LISTINGS_DIR = join(__dirname, '..', 'listings')
const FEATURED_FILE = join(LISTINGS_DIR, 'featured.yaml')

// Lazy-initialized prepared statements
const stmts = {}
function stmt(key, sql) {
  if (!stmts[key]) stmts[key] = db.prepare(sql)
  return stmts[key]
}

const upsert = () => stmt('upsert', `
  INSERT INTO services (id, name, description, url, protocol, price_sats, price_usd, payment_asset, payment_network, category, input_schema, output_schema, provider, source, source_id, hostname)
  VALUES (@id, @name, @description, @url, @protocol, @price_sats, @price_usd, @payment_asset, @payment_network, @category, @input_schema, @output_schema, @provider, 'exclusive', @source_id, @hostname)
  ON CONFLICT(url, protocol) DO UPDATE SET
    name = excluded.name,
    description = excluded.description,
    price_sats = excluded.price_sats,
    price_usd = excluded.price_usd,
    payment_asset = excluded.payment_asset,
    payment_network = excluded.payment_network,
    category = excluded.category,
    input_schema = excluded.input_schema,
    output_schema = excluded.output_schema,
    provider = excluded.provider,
    hostname = COALESCE(excluded.hostname, services.hostname),
    updated_at = datetime('now')
  RETURNING *
`)

/**
 * Load exclusive YAML listing files from the listings/ directory and upsert into DB.
 * @returns {number} Number of listings successfully loaded
 */
export function loadListings() {
  let files
  try {
    files = readdirSync(LISTINGS_DIR).filter(f => (f.endsWith('.yaml') || f.endsWith('.yml')) && f !== 'featured.yaml')
  } catch {
    return 0
  }

  let loaded = 0
  for (const file of files) {
    try {
      const content = readFileSync(join(LISTINGS_DIR, file), 'utf8')
      const listing = yaml.load(content)
      if (!listing || !listing.url || !listing.protocol) {
        console.warn(`[listings] Skipping ${file}: missing required fields`)
        continue
      }

      const listingUrl = normalizeUrl(listing.url)
      const row = upsert().get({
        id: randomUUID(),
        name: listing.name || 'Unknown',
        description: listing.description || null,
        url: listingUrl,
        protocol: listing.protocol,
        hostname: extractHostname(listingUrl),
        price_sats: listing.price_sats || null,
        price_usd: listing.price_usd || null,
        payment_asset: listing.payment_asset || null,
        payment_network: listing.payment_network || null,
        category: listing.category || 'uncategorized',
        input_schema: listing.input ? JSON.stringify(listing.input) : null,
        output_schema: listing.output ? JSON.stringify(listing.output) : null,
        provider: listing.provider || null,
        source_id: file,
      })
      if (row && row.registered_at === row.updated_at) {
        setImmediate(() => generateEmbedding(row.id).catch(() => {}))
      }
      loaded++
    } catch (err) {
      console.error(`[listings] Error loading ${file}:`, err.message)
    }
  }

  console.log(`[listings] Loaded ${loaded} exclusive listing(s) from YAML`)
  return loaded
}

/**
 * Read featured.yaml and set/unset the featured flag on matching services in DB.
 * @returns {void}
 */
export function loadFeatured() {
  if (!existsSync(FEATURED_FILE)) return

  try {
    const content = readFileSync(FEATURED_FILE, 'utf8')
    const data = yaml.load(content)
    const urls = (data?.featured_urls || []).map(e => normalizeUrl(e.url)).filter(Boolean)
    if (urls.length === 0) return

    // Idempotent: unfeatured anything NOT in the list, then feature everything that IS
    const placeholders = urls.map(() => '?').join(',')
    db.prepare(`UPDATE services SET featured = 0 WHERE featured = 1 AND url NOT IN (${placeholders})`).run(...urls)
    const result = db.prepare(`UPDATE services SET featured = 1 WHERE url IN (${placeholders}) AND featured = 0`).run(...urls)

    // Log unmatched featured URLs (actionable warnings)
    const matchedUrls = db.prepare(`SELECT url FROM services WHERE url IN (${placeholders})`).all(...urls).map(r => r.url)
    const matchedSet = new Set(matchedUrls)
    const unmatched = urls.filter(u => !matchedSet.has(u))
    if (unmatched.length > 0) {
      for (const url of unmatched) {
        console.warn(`[featured] URL not found in DB: ${url}`)
      }
    }
  } catch (err) {
    console.error('[featured] Error loading featured.yaml:', err.message)
  }
}
