import { SQLITE_VEC_AVAILABLE } from '../db.js'

const SORT_COLUMNS = { name: 'name', price: 'price_usd', latency: 'latency_p50_ms', uptime: 'uptime_30d', reliability: 'reliability_score', registered_at: 'registered_at' }
const VALID_HEALTH = new Set(['healthy', 'degraded', 'down', 'unknown'])
const VALID_SOURCE = new Set(['bazaar', 'satring', 'exclusive', 'l402apps', 'self-registered', 'sponge', 'well-known', 'discovery'])

const RELATED_PROTOCOLS_SQL = `(SELECT CASE WHEN COUNT(*) = 0 THEN '[]' ELSE json_group_array(s2.protocol) END FROM services s2 WHERE s2.url = services.url AND s2.id != services.id AND (s2.status = 'active' OR s2.status IS NULL) AND (s2.provider_deleted = 0 OR s2.provider_deleted IS NULL)) as related_protocols`

export const API_COLUMNS = 'id, name, description, url, protocol, price_sats, price_usd, payment_asset, payment_network, category, provider, source, featured, health_status, uptime_30d, latency_p50_ms, last_checked, registered_at, http_method, reliability_score, x402_payment_valid, domain_verified, x402_facilitator_reachable, x402_asset_known, l402_compliant, l402_degrade_reason, l402_format, lnget_compatible, ' + RELATED_PROTOCOLS_SQL
export const PAGE_COLUMNS = 'id, name, url, protocol, price_sats, price_usd, payment_asset, payment_network, category, provider, source, featured, health_status, latency_p50_ms, reliability_score, x402_payment_valid, domain_verified'

const DEFAULT_ORDER = `ORDER BY
    featured DESC,
    domain_verified DESC,
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
 * @param {string} [opts.verified] - 'true' or '1' to filter verified services (x402: payment_valid, L402+MPP: healthy)
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
    verified,
    l402_compliant,
    l402_format,
    lnget_compatible,
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
  if (q && q !== '*') {
    const escaped = q.replace(/[%_\\]/g, '\\$&')
    conditions.push("(name LIKE @q ESCAPE '\\' OR description LIKE @q ESCAPE '\\' OR url LIKE @q ESCAPE '\\')")
    params.q = `%${escaped}%`
  }
  if (featured === 'true' || featured === '1') {
    conditions.push('featured = 1')
  }
  if (payment_valid === 'true' || payment_valid === '1') {
    conditions.push("((protocol = 'x402' AND x402_payment_valid = 1) OR (protocol = 'L402' AND health_status = 'healthy'))")
  } else if (payment_valid === 'false' || payment_valid === '0') {
    conditions.push("((protocol = 'x402' AND (x402_payment_valid = 0 OR x402_payment_valid IS NULL)) OR (protocol = 'L402' AND health_status != 'healthy'))")
  }
  if (verified === 'true' || verified === '1') {
    conditions.push(`(
      (protocol = 'x402' AND x402_payment_valid = 1)
      OR (protocol = 'L402' AND health_status = 'healthy')
      OR (protocol = 'MPP' AND health_status = 'healthy')
    )`)
  }
  if (l402_format) {
    const sanitized = l402_format.replace(/[^a-z0-9_]/g, '')
    conditions.push('l402_format = @l402_format')
    params.l402_format = sanitized
  }
  if (lnget_compatible === 'true' || lnget_compatible === '1') {
    conditions.push('lnget_compatible = 1')
  } else if (lnget_compatible === 'false' || lnget_compatible === '0') {
    conditions.push('lnget_compatible = 0')
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
  for (const s of services) {
    if (typeof s.related_protocols === 'string') {
      s.related_protocols = JSON.parse(s.related_protocols)
    }
  }
  return { services, total, limit, offset }
}

/**
 * Build a 5-tier hybrid re-rank comparator.
 * Pure function — no DB access, no side effects.
 */
export function buildHybridComparator({ q, likeNameIdSet, likeDescIdSet, semanticScores }) {
  const qLower = q.toLowerCase()
  return (a, b) => {
    // Tier A: exact name match (case-insensitive equality)
    const aExact = a.name && a.name.toLowerCase() === qLower ? 1 : 0
    const bExact = b.name && b.name.toLowerCase() === qLower ? 1 : 0
    if (bExact !== aExact) return bExact - aExact

    // Tier B: LIKE match on name
    const aName = likeNameIdSet.has(a.id) ? 1 : 0
    const bName = likeNameIdSet.has(b.id) ? 1 : 0
    if (bName !== aName) return bName - aName

    // Tier C: LIKE match on description
    const aDesc = likeDescIdSet.has(a.id) ? 1 : 0
    const bDesc = likeDescIdSet.has(b.id) ? 1 : 0
    if (bDesc !== aDesc) return bDesc - aDesc

    // Tier D: cosine similarity DESC
    const aCos = semanticScores.get(a.id) ?? 0
    const bCos = semanticScores.get(b.id) ?? 0
    if (bCos !== aCos) return bCos - aCos

    // Tier E: DEFAULT_ORDER cascade
    const aFeat = a.featured || 0
    const bFeat = b.featured || 0
    if (bFeat !== aFeat) return bFeat - aFeat

    const aDv = a.domain_verified || 0
    const bDv = b.domain_verified || 0
    if (bDv !== aDv) return bDv - aDv

    const aCat = (a.category && a.category !== 'uncategorized') ? 0 : 1
    const bCat = (b.category && b.category !== 'uncategorized') ? 0 : 1
    if (aCat !== bCat) return aCat - bCat

    const healthOrder = { healthy: 0, degraded: 1, down: 2, unknown: 3 }
    const aH = healthOrder[a.health_status] ?? 3
    const bH = healthOrder[b.health_status] ?? 3
    if (aH !== bH) return aH - bH

    return (a.name || '').localeCompare(b.name || '')
  }
}

/**
 * Hybrid query: combines LIKE results with semantic (embedding) results.
 * Falls back to LIKE-only on any semantic failure.
 * Returns { services, total, limit, offset, degradedReason }.
 */
export async function queryServicesHybrid(db, opts, columns = API_COLUMNS) {
  const { q, sort } = opts

  // No q → delegate to existing queryServices
  if (!q) return { ...queryServices(db, opts, columns), degradedReason: null, semantic_cap: false }

  // q=* → match-all shortcut (no semantic)
  if (q === '*') return { ...queryServices(db, opts, columns), degradedReason: null, semantic_cap: false }

  // Explicit sort → skip re-rank, run LIKE-only with requested sort
  if (sort && SORT_COLUMNS[sort]) {
    return { ...queryServices(db, opts, columns), degradedReason: null, semantic_cap: false }
  }

  // ─── Run LIKE query (always authoritative) ───────────────────────────────
  const { where, params, orderBy, limit, offset } = buildServiceQuery(opts)
  // Ensure LIKE fetch covers the requested pagination window + headroom for re-rank union
  const likeCap = Math.max(1000, offset + limit)
  const likeServices = db.prepare(
    `SELECT ${columns} FROM services ${where} ${orderBy} LIMIT @_likeCap`
  ).all({ ...params, _likeCap: likeCap })
  for (const s of likeServices) {
    if (typeof s.related_protocols === 'string') s.related_protocols = JSON.parse(s.related_protocols)
  }

  // ─── Attempt semantic path ───────────────────────────────────────────────
  const { embedQueryForRead, cosineSimilarity } = await import('../services/embeddings.js')
  const { embedding, degradedReason } = await embedQueryForRead(q, 1500)

  if (degradedReason || !embedding) {
    // Semantic failed — return LIKE-only
    const total = db.prepare(`SELECT COUNT(*) as c FROM services ${where}`).get(params).c
    const paged = likeServices.slice(offset, offset + limit)
    return { services: paged, total, limit, offset, degradedReason: degradedReason || 'embed-error', semantic_cap: false }
  }

  // ─── Get cosine scores from embeddings ─────────────────────────────────
  let semanticScores = new Map() // service_id → cosine score
  let vecDegraded = null
  const K = Math.max(50, limit) // top-K semantic window; semantic_cap = true when saturated

  if (SQLITE_VEC_AVAILABLE) {
    // sqlite-vec top-K with 500ms deadline
    try {
      let vecTimer
      const vecResult = await Promise.race([
        new Promise((resolve) => {
          const blob = Buffer.from(embedding.buffer)
          const rows = db.prepare(
            `SELECT service_id, distance FROM vec_service_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
          ).all(blob, K)
          resolve(rows)
        }),
        new Promise(resolve => { vecTimer = setTimeout(() => resolve('__vec_deadline__'), 500) }),
      ])
      clearTimeout(vecTimer)

      if (vecResult === '__vec_deadline__') {
        vecDegraded = 'vec-deadline'
      } else {
        for (const row of vecResult) {
          // sqlite-vec returns distance (lower = more similar), convert to similarity
          semanticScores.set(row.service_id, 1 - row.distance)
        }
      }
    } catch {
      vecDegraded = 'vec-deadline'
    }
  } else {
    // Pure-JS fallback with row count guard
    const countRow = db.prepare('SELECT COUNT(*) as c FROM service_embeddings').get()
    if (countRow.c > 5000) {
      vecDegraded = 'js-fallback-too-large'
    } else {
      // Load all embeddings and compute cosine
      try {
        let jsTimer
        const result = await Promise.race([
          new Promise((resolve) => {
            const rows = db.prepare('SELECT service_id, embedding FROM service_embeddings').all()
            const scores = []
            for (const row of rows) {
              if (row.embedding.byteLength % 4 !== 0) throw new Error(`Malformed embedding for ${row.service_id}: byteLength=${row.embedding.byteLength} not divisible by 4`)
              const vec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4)
              if (vec.length === 1536) {
                const score = cosineSimilarity(embedding, vec)
                scores.push({ service_id: row.service_id, score })
              }
            }
            resolve(scores)
          }),
          new Promise(resolve => { jsTimer = setTimeout(() => resolve('__vec_deadline__'), 500) }),
        ])
        clearTimeout(jsTimer)

        if (result === '__vec_deadline__') {
          vecDegraded = 'vec-deadline'
        } else {
          for (const { service_id, score } of result) {
            semanticScores.set(service_id, score)
          }
        }
      } catch {
        vecDegraded = 'vec-deadline'
      }
    }
  }

  if (vecDegraded) {
    // Vec path failed — return LIKE-only with reason
    const total = db.prepare(`SELECT COUNT(*) as c FROM services ${where}`).get(params).c
    const paged = likeServices.slice(offset, offset + limit)
    return { services: paged, total, limit, offset, degradedReason: vecDegraded, semantic_cap: false }
  }

  // ─── Union candidates ────────────────────────────────────────────────────
  const likeIdSet = new Set(likeServices.map(s => s.id))
  const semanticIds = [...semanticScores.keys()].filter(id => !likeIdSet.has(id))

  // Fetch semantic-only services with ALL user filters applied (not just status/provider_deleted)
  let semanticOnlyServices = []
  if (semanticIds.length > 0) {
    const noQOpts = { ...opts, q: undefined, rawLimit: undefined, rawOffset: undefined }
    const { where: filterWhere, params: filterParams } = buildServiceQuery(noQOpts)
    const idParams = {}
    const idNames = semanticIds.map((id, i) => {
      const key = `_semId${i}`
      idParams[key] = id
      return `@${key}`
    })
    const semWhere = filterWhere
      ? `${filterWhere} AND id IN (${idNames.join(',')})`
      : `WHERE id IN (${idNames.join(',')})`
    semanticOnlyServices = db.prepare(
      `SELECT ${columns} FROM services ${semWhere}`
    ).all({ ...filterParams, ...idParams })
    for (const s of semanticOnlyServices) {
      if (typeof s.related_protocols === 'string') s.related_protocols = JSON.parse(s.related_protocols)
    }
    // Post-filter: remove services that would LIKE-match q (prevent double-counting)
    //
    // ⚠ P4 — LIKE vs JS normalization divergence (documented, not fixed here):
    // The SQL LIKE path (services.js:98-102) uses SQLite's default NOCASE collation, which is
    // ASCII-only case-insensitive and accent-SENSITIVE (e.g., "café" ≠ "cafe").
    // The JS post-filter below uses .toLowerCase().includes(), which is Unicode-aware
    // (uses the host engine's Unicode tables for case folding).
    // For accented-character queries this can produce ±1 drift in `total` between the two paths.
    // Practical impact is near-zero on the current dataset, but the divergence is real.
    // A future fix would introduce a shared normalization step: NFC + lowercase applied to both
    // the SQL side (explicit COLLATE or normalised column) and this JS filter, or alternatively
    // replace LIKE with a JS-side filter entirely for the post-overlap check.
    const needle = q.toLowerCase()
    semanticOnlyServices = semanticOnlyServices.filter(s => {
      const n = (s.name || '').toLowerCase()
      const d = (s.description || '').toLowerCase()
      const u = (s.url || '').toLowerCase()
      return !n.includes(needle) && !d.includes(needle) && !u.includes(needle)
    })
  }

  // True LIKE count (uncapped) + semantic-only count (post-overlap-filter)
  const likeCount = db.prepare(`SELECT COUNT(*) as c FROM services ${where}`).get(params).c
  const total = likeCount + semanticOnlyServices.length

  const allCandidates = [...likeServices, ...semanticOnlyServices]

  // ─── 5-tier composite re-rank ────────────────────────────────────────────
  // Build LIKE match sets using plain lowercase (no SQL escaping for JS comparison)
  const likeNameIdSet = new Set()
  const likeDescIdSet = new Set()
  const qLower = q.toLowerCase()
  for (const s of allCandidates) {
    if (s.name && s.name.toLowerCase().includes(qLower)) likeNameIdSet.add(s.id)
    if (s.description && s.description.toLowerCase().includes(qLower)) likeDescIdSet.add(s.id)
  }

  allCandidates.sort(buildHybridComparator({ q, likeNameIdSet, likeDescIdSet, semanticScores }))

  // Apply pagination
  const paged = allCandidates.slice(offset, offset + limit)
  // semantic_cap is true only when the sqlite-vec ANN query saturated its K budget.
  // JS-fallback never truncates (loads all embeddings), so semantic_cap is always false in that path.
  const vecTruncated = SQLITE_VEC_AVAILABLE && semanticScores.size === K
  return { services: paged, total, limit, offset, degradedReason: null, semantic_cap: vecTruncated }
}
