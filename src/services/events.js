/**
 * Event dispatcher for 402index service events.
 * Coordinates webhooks, Nostr publishing, and email notifications.
 * All handlers are fire-and-forget — emit() never throws.
 */

import { deliverWebhooks } from './webhooks.js'
import { publishNostr } from './nostr.js'
import { sendRegistrationNotification } from './notify.js'

/**
 * Emit a service event to all distribution channels.
 * @param {string} event - Event name: 'service.new', 'service.health_changed', 'service.down'
 * @param {object} service - Service data
 * @param {Database} db - Database instance (for webhook queries)
 */
export async function emit(event, service, db) {
  try {
    const handlers = [
      deliverWebhooks(db, event, service).catch(err =>
        console.error('[events] webhooks error:', err.message)
      ),
      publishNostr(event, service).catch(err =>
        console.error('[events] nostr error:', err.message)
      ),
    ]

    // Only send email notification for new service registrations
    if (event === 'service.new' && service) {
      handlers.push(
        sendRegistrationNotification(service).catch(err =>
          console.error('[events] notify error:', err.message)
        )
      )
    }

    await Promise.allSettled(handlers)
  } catch (err) {
    console.error('[events] emit error:', err.message)
  }
}
