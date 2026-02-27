import { readdirSync, readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import yaml from 'js-yaml'
import { v4 as uuidv4 } from 'uuid'
import db from './db.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LISTINGS_DIR = join(__dirname, '..', 'listings')
const FEATURED_FILE = join(LISTINGS_DIR, 'featured.yaml')

const upsert = db.prepare(`
  INSERT INTO services (id, name, description, url, protocol, price_sats, price_usd, payment_asset, payment_network, category, input_schema, output_schema, provider, source, source_id)
  VALUES (@id, @name, @description, @url, @protocol, @price_sats, @price_usd, @payment_asset, @payment_network, @category, @input_schema, @output_schema, @provider, 'exclusive', @source_id)
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
    updated_at = datetime('now')
`)

export function loadListings() {
  let files
  try {
    files = readdirSync(LISTINGS_DIR).filter(f => (f.endsWith('.yaml') || f.endsWith('.yml')) && f !== 'featured.yaml')
  } catch {
    console.log('[listings] No listings directory found, skipping')
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

      upsert.run({
        id: uuidv4(),
        name: listing.name || 'Unknown',
        description: listing.description || null,
        url: listing.url,
        protocol: listing.protocol,
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
      loaded++
    } catch (err) {
      console.error(`[listings] Error loading ${file}:`, err.message)
    }
  }

  console.log(`[listings] Loaded ${loaded} exclusive listing(s) from YAML`)
  return loaded
}

export function loadFeatured() {
  if (!existsSync(FEATURED_FILE)) {
    console.log('[featured] No featured.yaml found, skipping')
    return
  }

  try {
    const content = readFileSync(FEATURED_FILE, 'utf8')
    const data = yaml.load(content)
    const urls = (data?.featured_urls || []).map(e => e.url).filter(Boolean)

    if (urls.length === 0) {
      console.log('[featured] No featured URLs found')
      return
    }

    // Reset all featured flags, then set the ones in the file
    db.prepare('UPDATE services SET featured = 0 WHERE featured = 1').run()

    const placeholders = urls.map(() => '?').join(',')
    const result = db.prepare(`UPDATE services SET featured = 1 WHERE url IN (${placeholders})`).run(...urls)

    console.log(`[featured] Marked ${result.changes} service(s) as featured (${urls.length} URLs in file)`)
  } catch (err) {
    console.error('[featured] Error loading featured.yaml:', err.message)
  }
}
