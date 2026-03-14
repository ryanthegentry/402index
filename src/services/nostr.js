/**
 * Nostr event publishing for 402index service events.
 * Publishes NIP-99 (kind 30402) events to configured relays.
 * Fire-and-forget — failures are logged, never thrown.
 *
 * Env vars:
 *   NOSTR_PRIVATE_KEY  — hex-encoded private key (publishing disabled if unset)
 *   NOSTR_RELAY_URLS   — comma-separated relay WebSocket URLs (publishing disabled if unset)
 */

/**
 * Build a Nostr event object (unsigned) for a service event.
 * @param {string} eventType - e.g. 'service.new', 'service.health_changed'
 * @param {object} service - Service data
 * @returns {object} Unsigned Nostr event
 */
export function buildNostrEvent(eventType, service) {
  const content = JSON.stringify({
    name: service.name,
    url: service.url,
    protocol: service.protocol,
    price_sats: service.price_sats,
    price_usd: service.price_usd,
    category: service.category,
    health_status: service.health_status,
    event_type: eventType,
  })

  const tags = [
    ['d', service.url],
    ['L', 'protocol'],
    ['l', service.protocol, 'protocol'],
    ['r', service.url],
  ]

  if (service.category) {
    tags.push(['t', service.category])
  }

  if (service.price_sats != null) {
    tags.push(['price', String(service.price_sats), 'sats'])
  }

  return {
    kind: 30402,
    content,
    tags,
    created_at: Math.floor(Date.now() / 1000),
  }
}

/**
 * Publish a service event to Nostr relays. Fire-and-forget.
 * @param {string} eventType - Event name
 * @param {object} service - Service data
 */
export async function publishNostr(eventType, service) {
  const privateKey = process.env.NOSTR_PRIVATE_KEY
  if (!privateKey) return

  const relayUrls = process.env.NOSTR_RELAY_URLS
  if (!relayUrls) return

  try {
    const { getPublicKey, finalizeEvent } = await import('nostr-tools/pure')
    const { Relay } = await import('nostr-tools/relay')

    const privKeyBytes = hexToBytes(privateKey)
    const event = buildNostrEvent(eventType, service)

    const signedEvent = finalizeEvent({
      ...event,
      pubkey: getPublicKey(privKeyBytes),
    }, privKeyBytes)

    const relays = relayUrls.split(',').map(u => u.trim()).filter(Boolean)

    await Promise.allSettled(relays.map(async (url) => {
      try {
        const relay = await Promise.race([
          Relay.connect(url),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
        ])
        await relay.publish(signedEvent)
        relay.close()
      } catch (err) {
        console.error(`[nostr] Failed to publish to ${url}: ${err.message}`)
      }
    }))
  } catch (err) {
    console.error('[nostr] publishNostr error:', err.message)
  }
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16)
  }
  return bytes
}
