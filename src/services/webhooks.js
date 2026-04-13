import crypto from 'crypto'

const VALID_EVENTS = new Set(['service.new', 'service.health_changed', 'service.down'])
const VALID_PROTOCOLS = new Set(['L402', 'x402', 'MPP'])
const MAX_FAILURES = 10

/**
 * Create the webhooks table in the given database.
 * Safe to call multiple times (IF NOT EXISTS).
 */
export function createWebhooksTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      secret TEXT NOT NULL,
      events TEXT NOT NULL DEFAULT 'service.new',
      protocol_filter TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_triggered_at TEXT,
      failure_count INTEGER DEFAULT 0
    )
  `)
}

/**
 * Constant-time secret comparison.
 */
export function verifySecret(a, b) {
  const bufA = Buffer.from(String(a))
  const bufB = Buffer.from(String(b))
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

/**
 * Register a new webhook.
 * @param {Database} db
 * @param {{ url: string, secret: string, events?: string, protocol_filter?: string }} opts
 * @returns {{ id: string, url: string, events: string, created_at: string }}
 */
export function registerWebhook(db, { url, secret, events, protocol_filter } = {}) {
  if (!url) throw new Error('url is required')
  if (!secret) throw new Error('secret is required')

  // Validate HTTPS (exception: *.railway.internal — encrypted at infra layer)
  try {
    const parsed = new URL(url)
    const isRailwayInternal = parsed.hostname.endsWith('.railway.internal')
    if (parsed.protocol !== 'https:' && !isRailwayInternal) {
      throw new Error('Webhook URL must be HTTPS (exception: *.railway.internal)')
    }
  } catch (e) {
    if (e.message.includes('HTTPS')) throw e
    throw new Error('Webhook URL must be HTTPS (exception: *.railway.internal)')
  }

  // Validate events
  const eventList = events ? events.split(',').map(e => e.trim()) : ['service.new']
  for (const evt of eventList) {
    if (!VALID_EVENTS.has(evt)) {
      throw new Error(`Invalid event: ${evt}. Valid events: ${[...VALID_EVENTS].join(', ')}`)
    }
  }
  const normalizedEvents = eventList.join(',')

  // Validate protocol_filter
  if (protocol_filter && !VALID_PROTOCOLS.has(protocol_filter)) {
    throw new Error(`Invalid protocol filter: ${protocol_filter}. Valid: ${[...VALID_PROTOCOLS].join(', ')}`)
  }

  const id = crypto.randomUUID()
  const now = new Date().toISOString()

  db.prepare(`
    INSERT INTO webhooks (id, url, secret, events, protocol_filter, created_at)
    VALUES (@id, @url, @secret, @events, @protocol_filter, @created_at)
  `).run({ id, url, secret, events: normalizedEvents, protocol_filter: protocol_filter || null, created_at: now })

  return { id, url, events: normalizedEvents, created_at: now }
}

/**
 * Delete a webhook by id after verifying the secret.
 */
export function deleteWebhook(db, id, secret) {
  const row = db.prepare('SELECT secret FROM webhooks WHERE id = ?').get(id)
  if (!row) throw new Error('Webhook not found')
  if (!verifySecret(row.secret, secret)) throw new Error('Unauthorized: secret mismatch')
  db.prepare('DELETE FROM webhooks WHERE id = ?').run(id)
  return true
}

/**
 * Get webhook status by id after verifying the secret. Does not return the secret.
 */
export function getWebhook(db, id, secret) {
  const row = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id)
  if (!row) throw new Error('Webhook not found')
  if (!verifySecret(row.secret, secret)) throw new Error('Unauthorized: secret mismatch')
  const { secret: _, ...status } = row
  return status
}

/**
 * Build a webhook delivery payload.
 */
export function buildWebhookPayload(event, service) {
  return {
    event,
    service,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Deliver webhook notifications for an event. Fire-and-forget.
 * @param {Database} db
 * @param {string} event - Event name (service.new, service.health_changed, service.down)
 * @param {object} service - Service data
 */
export async function deliverWebhooks(db, event, service) {
  try {
    const webhooks = db.prepare(
      "SELECT * FROM webhooks WHERE is_active = 1"
    ).all()

    const matching = webhooks.filter(wh => {
      // Check event subscription
      const subscribedEvents = wh.events.split(',').map(e => e.trim())
      if (!subscribedEvents.includes(event)) return false
      // Check protocol filter
      if (wh.protocol_filter && service.protocol !== wh.protocol_filter) return false
      return true
    })

    if (matching.length === 0) return

    const payload = buildWebhookPayload(event, service)
    const body = JSON.stringify(payload)

    await Promise.allSettled(matching.map(async (wh) => {
      try {
        const hmac = crypto.createHmac('sha256', wh.secret).update(body).digest('hex')

        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 5000)

        const res = await fetch(wh.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-402Index-Signature': `sha256=${hmac}`,
            'X-402Index-Event': event,
          },
          body,
          signal: controller.signal,
        })

        clearTimeout(timeout)

        if (res.ok) {
          db.prepare(
            "UPDATE webhooks SET failure_count = 0, last_triggered_at = datetime('now') WHERE id = ?"
          ).run(wh.id)
        } else {
          incrementFailure(db, wh)
        }
      } catch (err) {
        console.error(`[webhooks] Delivery failed for ${wh.url}: ${err.message}`)
        incrementFailure(db, wh)
      }
    }))
  } catch (err) {
    console.error('[webhooks] deliverWebhooks error:', err.message)
  }
}

function incrementFailure(db, wh) {
  const newCount = (wh.failure_count || 0) + 1
  if (newCount >= MAX_FAILURES) {
    db.prepare('UPDATE webhooks SET failure_count = ?, is_active = 0 WHERE id = ?').run(newCount, wh.id)
    console.warn(`[webhooks] Deactivated webhook ${wh.id} after ${MAX_FAILURES} consecutive failures`)
  } else {
    db.prepare('UPDATE webhooks SET failure_count = ? WHERE id = ?').run(newCount, wh.id)
  }
}
