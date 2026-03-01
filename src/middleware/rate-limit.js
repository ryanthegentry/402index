import rateLimit from 'express-rate-limit'
import { getProvider } from '../services/l402-provider.js'

const L402_ENABLED = () => process.env.L402_ENABLED === 'true'
const L402_PRICE_SATS = () => parseInt(process.env.L402_PRICE_SATS) || 500
const L402_DURATION_HOURS = () => parseInt(process.env.L402_DURATION_HOURS) || 24

async function sendL402Challenge(req, res) {
  const provider = getProvider()
  const challenge = await provider.createChallenge(L402_PRICE_SATS(), L402_DURATION_HOURS())

  if (challenge) {
    const wwwAuth = `L402 macaroon="${challenge.macaroon}", invoice="${challenge.invoice}"`
    return res.status(402).set('WWW-Authenticate', wwwAuth).json({
      error: 'Payment Required',
      message: 'Rate limit exceeded. Pay the Lightning invoice to continue.',
      invoice: challenge.invoice,
      macaroon: challenge.macaroon,
      payment_hash: challenge.paymentHash,
      price_sats: L402_PRICE_SATS(),
      duration_hours: L402_DURATION_HOURS(),
    })
  }

  // Challenge creation failed — fall back to standard 429
  return res.status(429).set('Retry-After', '60').json({
    error: 'Too Many Requests',
    message: 'Rate limit exceeded. Try again later.',
    retry_after: 60,
  })
}

/**
 * Free tier rate limiter: 100 req/min, skipped if L402 verified.
 * Responds with L402 challenge (if enabled) or 429 when limit is exceeded.
 * @type {import('express').RequestHandler}
 */
export const freeLimiter = rateLimit({
  windowMs: 60_000,
  limit: 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: (req) => req.l402Verified === true,
  handler: async (req, res) => {
    if (L402_ENABLED()) {
      return sendL402Challenge(req, res)
    }
    res.status(429).set('Retry-After', '60').json({
      error: 'Too Many Requests',
      message: 'Rate limit exceeded. Try again later.',
      retry_after: 60,
    })
  },
})

/**
 * L402 tier rate limiter: 1000 req/min, only applies to L402-verified requests.
 * @type {import('express').RequestHandler}
 */
export const l402Limiter = rateLimit({
  windowMs: 60_000,
  limit: 1000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: (req) => req.l402Verified !== true,
  handler: (_req, res) => {
    res.status(429).set('Retry-After', '60').json({
      error: 'Too Many Requests',
      message: 'L402 rate limit exceeded. Try again later.',
      retry_after: 60,
    })
  },
})
