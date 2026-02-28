import crypto from 'crypto'
import fetch from 'node-fetch'

class StubL402Provider {
  async createChallenge() { return null }
  async verifyToken() { return { valid: false } }
}

class MockL402Provider {
  constructor() {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('MockL402Provider cannot be used in production')
    }
    console.log('[l402] Using mock provider (dev/test only)')
  }

  async createChallenge(priceSats, durationHours) {
    const macaroon = crypto.randomBytes(32).toString('base64')
    const paymentHash = crypto.randomBytes(32).toString('hex')
    return {
      macaroon,
      invoice: `lnbc${priceSats}n1mock_invoice_for_testing`,
      paymentHash,
    }
  }

  async verifyToken(authorization) {
    // Accept any well-formed L402 token: base64:hex64
    const match = authorization.match(/^L402\s+(\S+):([a-f0-9]{64})$/i)
    if (!match) return { valid: false }
    return {
      valid: true,
      expiresAt: new Date(Date.now() + 24 * 3600000).toISOString(),
    }
  }
}

class GolemL402Provider {
  constructor() {
    this.baseUrl = process.env.GOLEM_INTERNAL_URL || 'http://golem.railway.internal:8402'
    console.log(`[l402] Using Golem provider at ${this.baseUrl}`)
  }

  async createChallenge(priceSats, durationHours) {
    try {
      const res = await fetch(`${this.baseUrl}/l402/challenge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ price_sats: priceSats, duration_hours: durationHours }),
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) {
        console.error(`[l402] Golem challenge returned ${res.status}`)
        return null
      }
      return await res.json()
    } catch (err) {
      console.error(`[l402] Golem gateway unreachable: ${err.message}`)
      return null
    }
  }

  async verifyToken(authorization) {
    try {
      const res = await fetch(`${this.baseUrl}/l402/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authorization }),
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) {
        console.error(`[l402] Golem verify returned ${res.status}`)
        return { valid: false }
      }
      return await res.json()
    } catch (err) {
      console.error(`[l402] Golem gateway unreachable: ${err.message}`)
      return { valid: false }
    }
  }
}

let provider = null

export function getProvider() {
  if (provider) return provider

  const gateway = (process.env.L402_GATEWAY || 'none').toLowerCase()

  switch (gateway) {
    case 'mock':
      provider = new MockL402Provider()
      break
    case 'golem':
      provider = new GolemL402Provider()
      break
    default:
      provider = new StubL402Provider()
      break
  }

  return provider
}
