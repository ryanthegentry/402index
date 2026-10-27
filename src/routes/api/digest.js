import { Router } from 'express'
import db, {
  COUNTER_KEYS,
  MCP_QUERY_LOG_RETENTION_DAYS,
  MCP_USER_AGENT_SQL,
  getCounter,
  getCounterInt,
  mcpQueryWindowStats,
} from '../../db.js'

const router = Router()

// Classify a raw User-Agent string into a coarse client type for the digest's
// top-agents breakdown. Restored here after the #276 route-split moved the
// /digest handler out of the monolithic src/routes/api.js without carrying the
// helper across. Behaviour is verbatim from the pre-split api.js.
function classifyAgent(ua) {
  if (!ua || ua === '') return 'api'
  if (ua.includes('402index-mcp')) return 'mcp'
  if (ua.includes('Mozilla') || ua.includes('Chrome') || ua.includes('Safari')) return 'browser'
  return 'api'
}

router.get('/digest', (req, res) => {
  try {
    const ACTIVE = "(status = 'active' OR status IS NULL) AND (provider_deleted = 0 OR provider_deleted IS NULL)"

    // ── Totals ──
    const totalEndpoints = db.prepare(`SELECT COUNT(*) as c FROM services WHERE ${ACTIVE}`).get().c

    const byProtocol = {}
    db.prepare(`SELECT protocol, COUNT(*) as c FROM services WHERE ${ACTIVE} GROUP BY protocol`).all()
      .forEach(r => { byProtocol[r.protocol] = r.c })

    const byHealth = {}
    db.prepare(`SELECT health_status, COUNT(*) as c FROM services WHERE ${ACTIVE} GROUP BY health_status`).all()
      .forEach(r => { byHealth[r.health_status] = r.c })

    // Providers via JS hostname extraction (same approach as /health)
    const allUrls = db.prepare(`SELECT url, is_template, is_demo FROM services WHERE ${ACTIVE}`).all()
    const providerSet = new Set()
    for (const svc of allUrls) {
      if (svc.is_template || svc.is_demo) continue
      try { providerSet.add(new URL(svc.url).hostname) } catch { /* skip */ }
    }

    const paymentVerified = db.prepare(`SELECT COUNT(*) as c FROM services WHERE ${ACTIVE} AND x402_payment_valid = 1`).get().c
    const domainVerifiedProviders = db.prepare("SELECT COUNT(DISTINCT domain) as c FROM domain_claims WHERE status = 'verified'").get().c

    const l402Formats = db.prepare(`
      SELECT l402_format, COUNT(*) as count
      FROM services
      WHERE protocol = 'L402' AND l402_format IS NOT NULL AND ${ACTIVE}
      GROUP BY l402_format
    `).all()

    const l402FormatCounts = {}
    let l402CompliantCount = 0
    let l402NonCompliantCount = 0
    for (const row of l402Formats) {
      l402FormatCounts[row.l402_format] = row.count
      if (row.l402_format === 'v2_tlv' || row.l402_format === 'v1_binary') {
        l402CompliantCount += row.count
      } else {
        l402NonCompliantCount += row.count
      }
    }

    // ── Registrations ──
    const last24h = db.prepare(`
      SELECT id, name, url, protocol, provider, source, registered_at as created_at
      FROM services
      WHERE source = 'self-registered'
        AND registered_at > datetime('now', '-24 hours')
        AND ${ACTIVE}
      ORDER BY registered_at DESC
    `).all()

    const last7dCount = db.prepare(`
      SELECT COUNT(*) as c FROM services
      WHERE registered_at > datetime('now', '-7 days') AND ${ACTIVE}
    `).get().c

    const pendingApproval = db.prepare("SELECT COUNT(*) as c FROM services WHERE status = 'pending'").get().c

    const selfRegisteredTotal = db.prepare(`
      SELECT COUNT(*) as c FROM services WHERE source = 'self-registered' AND ${ACTIVE}
    `).get().c

    // ── Traffic ──
    const queriesToday = db.prepare(
      "SELECT COUNT(*) as c FROM query_log WHERE timestamp > date('now')"
    ).get().c

    const queries7d = db.prepare(
      "SELECT COUNT(*) as c FROM query_log WHERE timestamp > datetime('now', '-7 days')"
    ).get().c

    const uniqueAgentsToday = db.prepare(
      "SELECT COUNT(DISTINCT user_agent) as c FROM query_log WHERE timestamp > date('now')"
    ).get().c

    // Same predicate as the lifetime increment and the 90d window — one rule, three fields.
    const mcpToday = db.prepare(
      `SELECT COUNT(*) as c FROM query_log WHERE timestamp > date('now') AND ${MCP_USER_AGENT_SQL}`
    ).get().c

    // MCP: a true lifetime counter, plus window aggregates named for the window they cover.
    // query_log is pruned at 90 days, so the old "total"/"active_days" fields were rolling
    // windows mislabeled as lifetime totals — hence their non-monotonic drops.
    const mcpWindow = mcpQueryWindowStats(db, MCP_QUERY_LOG_RETENTION_DAYS)
    const mcpLifetime = getCounterInt(COUNTER_KEYS.MCP_QUERIES_LIFETIME)
    const mcpSeededAt = getCounter(COUNTER_KEYS.MCP_COUNTER_SEEDED_AT)

    // ── Search Intelligence ──
    const topSearches = db.prepare(
      `SELECT query_text as term, COUNT(*) as count
       FROM query_log
       WHERE query_text IS NOT NULL AND query_text != ''
         AND timestamp > datetime('now', '-7 days')
       GROUP BY query_text
       ORDER BY count DESC LIMIT 20`
    ).all()

    const zeroResults = db.prepare(
      `SELECT query_text as term, filters, COUNT(*) as count
       FROM query_log
       WHERE result_count = 0
         AND query_text IS NOT NULL AND query_text != ''
         AND timestamp > datetime('now', '-7 days')
       GROUP BY query_text
       ORDER BY count DESC LIMIT 10`
    ).all()

    const topAgents = db.prepare(
      `SELECT user_agent as agent, COUNT(*) as count
       FROM query_log
       WHERE timestamp > datetime('now', '-7 days')
       GROUP BY user_agent
       ORDER BY count DESC LIMIT 15`
    ).all().map(r => ({ ...r, type: classifyAgent(r.agent) }))

    // ── Health Changes (approximate — based on current status + last_checked) ──
    const newlyDegraded = db.prepare(`
      SELECT id, name, url, protocol, provider, health_status, last_checked
      FROM services
      WHERE health_status = 'degraded'
        AND last_checked > datetime('now', '-24 hours')
        AND ${ACTIVE}
      ORDER BY last_checked DESC LIMIT 10
    `).all()

    const newlyDown = db.prepare(`
      SELECT id, name, url, protocol, provider, health_status, last_checked
      FROM services
      WHERE health_status = 'down'
        AND last_checked > datetime('now', '-24 hours')
        AND ${ACTIVE}
      ORDER BY last_checked DESC LIMIT 10
    `).all()

    // Recovered: currently healthy but had a down/degraded check in last 48h
    const recovered = db.prepare(`
      SELECT s.id, s.name, s.url, s.protocol, s.provider, s.health_status, s.last_checked
      FROM services s
      WHERE s.health_status = 'healthy'
        AND s.last_checked > datetime('now', '-24 hours')
        AND EXISTS (
          SELECT 1 FROM health_checks hc
          WHERE hc.service_id = s.id
            AND hc.status IN ('down', 'degraded')
            AND hc.checked_at > datetime('now', '-48 hours')
        )
        AND (s.status = 'active' OR s.status IS NULL)
        AND (s.provider_deleted = 0 OR s.provider_deleted IS NULL)
      ORDER BY s.last_checked DESC LIMIT 10
    `).all()

    // ── Health-check integrity ──
    // A broken status enum silently drops health writes, so it is surfaced here rather than left
    // in a boot log nobody reads. Absent key = healthy schema.
    const health = {
      write_failures_lifetime: getCounterInt(COUNTER_KEYS.HEALTH_WRITE_FAILURES),
      last_cycle: (() => {
        const raw = getCounter(COUNTER_KEYS.LAST_HEALTH_CYCLE)
        if (!raw) return null
        try {
          return JSON.parse(raw)
        } catch {
          return null
        }
      })(),
    }
    if (getCounter(COUNTER_KEYS.HEALTH_SCHEMA_INVALID) === '1') {
      health.health_schema_invalid = true
    }
    // Distinct condition: the boot probe could not reach a verdict (a lock, most often). Surfaced
    // so it is visible, but never as a broken-enum alarm.
    const schemaProbeError = getCounter(COUNTER_KEYS.HEALTH_SCHEMA_PROBE_ERROR)
    if (schemaProbeError) {
      health.health_schema_probe_error = schemaProbeError
    }

    res.json({
      generated_at: new Date().toISOString(),
      totals: {
        endpoints: totalEndpoints,
        providers: providerSet.size,
        by_protocol: byProtocol,
        by_health: byHealth,
        payment_verified: paymentVerified,
        domain_verified_providers: domainVerifiedProviders,
        l402_format_counts: l402FormatCounts,
        l402_compliant_count: l402CompliantCount,
        l402_non_compliant_count: l402NonCompliantCount,
      },
      registrations: {
        last_24h: last24h,
        last_7d_count: last7dCount,
        pending_approval: pendingApproval,
        self_registered_total: selfRegisteredTotal,
      },
      traffic: {
        queries_today: queriesToday,
        queries_7d: queries7d,
        unique_agents_today: uniqueAgentsToday,
        mcp_queries_today: mcpToday,
        mcp_queries_lifetime: mcpLifetime,
        mcp_queries_total: mcpLifetime,
        mcp_counter_seeded_at: mcpSeededAt,
        mcp_queries_90d: mcpWindow.queries,
        mcp_active_days_90d: mcpWindow.activeDays,
        // Deprecated: emits the 90d value for one release so the 5:30am consumer keeps working.
        mcp_active_days: mcpWindow.activeDays,
        mcp_active_days_deprecated: true,
        // The only gate on these counters is a client-controlled User-Agent substring, and the
        // lifetime total is never pruned — so it is a ceiling, not a measurement. Said here rather
        // than left for a reader to infer.
        mcp_counters_ua_attested: true,
      },
      search_intelligence: {
        top_searches_7d: topSearches,
        zero_results_7d: zeroResults,
        top_user_agents_7d: topAgents,
      },
      health,
      health_changes: {
        newly_degraded_24h: newlyDegraded,
        newly_down_24h: newlyDown,
        recovered_24h: recovered,
      },
    })
  } catch (err) {
    console.error('GET /api/v1/digest error:', err)
    res.status(500).json({ error: 'Internal Server Error' })
  }
})

export default router
