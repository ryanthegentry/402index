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
  if (token !== secret) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  next()
}
