const SORT_COLUMNS = { name: 'name', price: 'price_usd', latency: 'latency_p50_ms', uptime: 'uptime_30d', reliability: 'reliability_score', registered_at: 'registered_at' }
const VALID_HEALTH = new Set(['healthy', 'degraded', 'down', 'unknown'])
const VALID_SOURCE = new Set(['bazaar', 'satring', 'exclusive', 'l402apps', 'self-registered', 'sponge', 'well-known', 'discovery'])

export const API_COLUMNS = 'id, name, description, url, protocol, price_sats, price_usd, payment_asset, payment_network, category, provider, source, featured, health_status, uptime_30d, latency_p50_ms, last_checked, registered_at, http_method, reliability_score, x402_payment_valid, x402_facilitator_reachable, x402_asset_known, l402_compliant, l402_degrade_reason, l402_format'
export const PAGE_COLUMNS = 'id, name, url, protocol, price_sats, price_usd, payment_asset, payment_network, category, provider, source, featured, health_status, latency_p50_ms, reliability_score, x402_payment_valid'

const DEFAULT_ORDER = `ORDER BY
    featured DESC,
    CASE WHEN featured = 1 THEN 0 ELSE CASE WHEN category != 'uncategorized' THEN 0 ELSE 1 END END,
    CASE health_status WHEN 'healthy' THEN 0 WHEN 'degraded' THEN 1 WHEN 'down' THEN 2 WHEN 'unknown' THEN 3 END,
    name`

/**
 * Build a WHERE clause + params + ORDER BY for querying the services table.
 *
 * @param {object} opts
 * @param {string} [opts.protocol]
 * @param {string} [opts.category]
 * @param {string} [opts.health]
 * @param {string} [opts.source]
 * @param {string} [opts.q] - Full-text search across name, description, and url
 * @param {string} [opts.featured] - 'true' or '1' to filter featured only
 * @param {string} [opts.max_price_usd] - Maximum price in USD (ignored if not a valid number)
 * @param {string} [opts.payment_asset]
 * @param {string} [opts.payment_valid] - 'true' or '1' to filter x402 services with valid payment requirements
 * @param {string} [opts.sort] - Sort column: 'name', 'price', 'latency', 'uptime'
 * @param {string} [opts.order] - Sort direction: 'asc' or 'desc'
 * @param {string|number} [opts.rawLimit] - Results per page (1-200, default 50)
 * @param {string|number} [opts.rawOffset] - Pagination offset (default 0)
 * @returns {{ where: string, params: object, orderBy: string, limit: number, offset: number }}
 */
export function buildServiceQuery(opts = {}) {
  const {
    protocol,
    category,
    health,
    source,
    q,
    featured,
    max_price_usd,
    payment_asset,
    payment_valid,
    l402_compliant,
    l402_format,
    sort,
    order,
    rawLimit,
    rawOffset,
  } = opts

  // Fix: use nullish coalescing to handle limit=0 correctly (0 is falsy but valid input)
  const parsedLimit = parseInt(rawLimit)
  const limit = Math.min(Math.max(Number.isNaN(parsedLimit) ? 50 : parsedLimit, 1), 200)

  const parsedOffset = parseInt(rawOffset)
  const offset = Math.max(Number.isNaN(parsedOffset) ? 0 : parsedOffset, 0)

  const conditions = ["(status = 'active' OR status IS NULL) AND (provider_deleted = 0 OR provider_deleted IS NULL)"]
  const params = {}

  if (protocol) {
    conditions.push('protocol = @protocol COLLATE NOCASE')
    params.protocol = protocol
  }
  if (category) {
    conditions.push("(category = @category OR category LIKE @categoryPrefix)")
    params.category = category
    params.categoryPrefix = category + '/%'
  }
  if (health && VALID_HEALTH.has(health)) {
    conditions.push('health_status = @health')
    params.health = health
  }
  if (source && VALID_SOURCE.has(source)) {
    conditions.push('source = @source')
    params.source = source
  }
  if (max_price_usd) {
    const parsed = parseFloat(max_price_usd)
    if (!Number.isNaN(parsed)) {
      conditions.push('price_usd <= @max_price_usd')
      params.max_price_usd = parsed
    }
  }
  if (payment_asset) {
    conditions.push('payment_asset = @payment_asset')
    params.payment_asset = payment_asset
  }
  if (q) {
    conditions.push("(name LIKE @q OR description LIKE @q OR url LIKE @q)")
    params.q = `%${q}%`
  }
  if (featured === 'true' || featured === '1') {
    conditions.push('featured = 1')
  }
  if (payment_valid === 'true' || payment_valid === '1') {
    conditions.push("((protocol = 'x402' AND x402_payment_valid = 1) OR (protocol = 'L402' AND health_status = 'healthy'))")
  } else if (payment_valid === 'false' || payment_valid === '0') {
    conditions.push("((protocol = 'x402' AND (x402_payment_valid = 0 OR x402_payment_valid IS NULL)) OR (protocol = 'L402' AND health_status != 'healthy'))")
  }
  if (l402_format) {
    const sanitized = l402_format.replace(/[^a-z0-9_]/g, '')
    conditions.push('l402_format = @l402_format')
    params.l402_format = sanitized
  }
  if (l402_compliant === 'true' || l402_compliant === '1') {
    conditions.push("l402_format IN ('v2_tlv', 'v1_binary')")
  } else if (l402_compliant === 'false' || l402_compliant === '0') {
    conditions.push("l402_format IN ('v0_text', 'json', 'unknown')")
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : ''

  const sortCol = SORT_COLUMNS[sort]
  const sortDir = order === 'desc' ? 'DESC' : 'ASC'
  const orderBy = sortCol
    ? `ORDER BY featured DESC, ${sortCol} ${sortDir}`
    : DEFAULT_ORDER

  return { where, params, orderBy, limit, offset }
}

/** Run a paginated service query with COUNT + SELECT. */
export function queryServices(db, opts, columns = API_COLUMNS) {
  const { where, params, orderBy, limit, offset } = buildServiceQuery(opts)
  const total = db.prepare(`SELECT COUNT(*) as c FROM services ${where}`).get(params).c
  const services = db.prepare(
    `SELECT ${columns} FROM services ${where} ${orderBy} LIMIT @limit OFFSET @offset`
  ).all({ ...params, limit, offset })
  return { services, total, limit, offset }
}
