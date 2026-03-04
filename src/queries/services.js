const SORT_COLUMNS = { name: 'name', price: 'price_usd', latency: 'latency_p50_ms', uptime: 'uptime_30d', reliability: 'reliability_score' }
const VALID_HEALTH = new Set(['healthy', 'degraded', 'down', 'unknown'])
const VALID_SOURCE = new Set(['bazaar', 'satring', 'exclusive', 'l402apps', 'self-registered'])

export const API_COLUMNS = 'id, name, description, url, protocol, price_sats, price_usd, payment_asset, payment_network, category, provider, source, featured, health_status, uptime_30d, latency_p50_ms, last_checked, registered_at, http_method, reliability_score'
export const PAGE_COLUMNS = 'id, name, url, protocol, price_sats, price_usd, payment_asset, payment_network, category, provider, source, featured, health_status, latency_p50_ms, reliability_score'

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
 * @param {string} [opts.q] - Full-text search across name and description
 * @param {string} [opts.featured] - 'true' or '1' to filter featured only
 * @param {string} [opts.max_price_usd] - Maximum price in USD (ignored if not a valid number)
 * @param {string} [opts.payment_asset]
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

  const conditions = ["(status = 'active' OR status IS NULL)"]
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
    conditions.push("(name LIKE @q OR description LIKE @q)")
    params.q = `%${q}%`
  }
  if (featured === 'true' || featured === '1') {
    conditions.push('featured = 1')
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
