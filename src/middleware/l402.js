import { getProvider } from '../services/l402-provider.js'

export async function verifyL402(req, res, next) {
  const auth = req.headers.authorization
  if (!auth || !auth.startsWith('L402 ')) {
    return next()
  }

  try {
    const provider = getProvider()
    const result = await provider.verifyToken(auth)

    if (result.valid) {
      // Check expiry
      if (result.expiresAt && new Date(result.expiresAt) < new Date()) {
        return next()
      }
      req.l402Verified = true
      req.l402ExpiresAt = result.expiresAt
    }
  } catch (err) {
    console.error('[l402] Verification error:', err.message)
  }

  next()
}
