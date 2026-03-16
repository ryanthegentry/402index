import { getProvider } from '../services/l402-provider.js'

let consecutiveErrors = 0
const ERROR_ALERT_THRESHOLD = 10

// Fail-open: verification errors degrade to free tier (next() without l402Verified).
// Consecutive failures are tracked and alerted at ERROR_ALERT_THRESHOLD.
export async function verifyL402(req, res, next) {
  const auth = req.headers.authorization
  if (!auth || !(auth.startsWith('L402 ') || auth.startsWith('LSAT '))) {
    return next()
  }

  try {
    const provider = getProvider()
    const result = await provider.verifyToken(auth)
    consecutiveErrors = 0

    if (result.valid) {
      if (result.expiresAt && new Date(result.expiresAt) < new Date()) {
        return next()
      }
      req.l402Verified = true
      req.l402ExpiresAt = result.expiresAt
    }
  } catch (err) {
    consecutiveErrors++
    if (consecutiveErrors === ERROR_ALERT_THRESHOLD) {
      console.error(`[l402] ${ERROR_ALERT_THRESHOLD} consecutive verification failures — check provider configuration`)
    } else if (consecutiveErrors < ERROR_ALERT_THRESHOLD) {
      console.error('[l402] Verification error:', err.message)
    }
  }

  next()
}
