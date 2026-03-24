import crypto from 'crypto'

function constantTimeEqual(a, b) {
  const bufA = Buffer.from(String(a))
  const bufB = Buffer.from(String(b))
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA)
    return false
  }
  return crypto.timingSafeEqual(bufA, bufB)
}

/**
 * Admin authentication middleware.
 * Checks Authorization: Bearer <token> against ADMIN_SECRET env var.
 */
export function adminAuth(req, res, next) {
  const secret = process.env.ADMIN_SECRET
  if (!secret) {
    return res.status(503).json({ error: 'Admin not configured' })
  }

  const auth = req.headers.authorization
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const token = auth.slice(7)
  if (!constantTimeEqual(token, secret)) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  next()
}

/**
 * Digest API authentication middleware.
 * Checks Authorization: Bearer <token> against DIGEST_API_KEY env var.
 * Read-only access to the digest endpoint only.
 */
export function digestAuth(req, res, next) {
  const secret = process.env.DIGEST_API_KEY
  if (!secret) {
    return res.status(503).json({ error: 'Digest API not configured' })
  }

  const auth = req.headers.authorization
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const token = auth.slice(7)
  if (!constantTimeEqual(token, secret)) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  next()
}
