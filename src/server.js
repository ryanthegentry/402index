import express from 'express'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { notFoundHandler, errorHandler } from './middleware/error-handler.js'
import { verifyL402 } from './middleware/l402.js'
import { freeLimiter, l402Limiter, digestLimiter } from './middleware/rate-limit.js'
import { adminAuth, digestAuth } from './middleware/admin-auth.js'
import apiRoutes from './routes/api.js'
import pageRoutes from './routes/pages.js'
import { startScheduler, shutdown } from './scheduler.js'

const app = express()
const PORT = process.env.PORT || 3402

if (process.env.NODE_ENV !== 'production') {
  console.warn('[server] WARNING: NODE_ENV is not "production" (current: %s)', process.env.NODE_ENV || 'undefined')
}

app.use(helmet({ contentSecurityPolicy: false }))
app.use(express.static('public'))

// Trust proxy in production (Railway, Fly.io)
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1)
}

// ─── Cache-Control Headers ───────────────────────────────────────────────────
// Homepage: 5 min (stats change on health checker cycle)
app.use(/^\/$/, (req, res, next) => { res.set('Cache-Control', 'public, max-age=300'); next() })
// Static-ish pages: 1 hour
app.use(/^\/(about|api-docs|opportunities|stats)$/, (req, res, next) => { res.set('Cache-Control', 'public, max-age=3600'); next() })
// API reads: 1 min (not register, probe-live, webhooks, or admin)
app.use(/^\/api\/v1\/(services|health|categories|opportunities)/, (req, res, next) => { res.set('Cache-Control', 'public, max-age=60'); next() })

// Registration endpoint: JSON body parsing + IP-based rate limit (50/hour)
// Per-domain limits (20 unverified / 100 verified) are the real abuse brake;
// this just caps a single IP from flooding the endpoint itself.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: parseInt(process.env.REGISTER_RATE_LIMIT) || 50,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many registrations. Limit: 50 per hour per IP.' },
})
app.use('/api/v1/register', express.json({ limit: '10kb' }), registerLimiter)

// Domain claim routes: JSON body parsing for all /claim/* + rate limit on claim creation only
const claimLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: parseInt(process.env.CLAIM_RATE_LIMIT) || 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many claim requests. Limit: 10 per hour per IP.' },
})
app.use('/api/v1/claim', express.json({ limit: '10kb' }), (req, res, next) => {
  // Rate-limit POST /claim and POST /claim/revoke, not /claim/verify
  if (req.path === '/' || req.path === '' || req.path === '/revoke') return claimLimiter(req, res, next)
  next()
})

// Rate-limited API routes: services, services/:id, categories, export
// express.json() included for PATCH /api/v1/services/:id (domain-verified edits)
app.use('/api/v1/services', express.json({ limit: '10kb' }), verifyL402, freeLimiter, l402Limiter)
app.use('/api/v1/categories', verifyL402, freeLimiter, l402Limiter)
app.use('/api/v1/export.csv', verifyL402, freeLimiter, l402Limiter)
// /api/v1/health is exempt from rate limiting (uptime monitors)

// Webhook routes: JSON body parsing + rate limit (5/hour)
const webhookLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many webhook registrations. Limit: 5 per hour per IP.' },
})
app.use('/api/v1/webhooks', express.json({ limit: '10kb' }), webhookLimiter)

// Digest endpoint: separate auth + conservative rate limit (10/hour)
app.use('/api/v1/digest', digestAuth, digestLimiter)

// Admin routes: JSON body parsing + auth
app.use('/api/v1/admin', express.json({ limit: '10kb' }), adminAuth)

// ─── API Request Logging ────────────────────────────────────────────────────
app.use('/api/v1', (req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    const ip = req.ip || req.socket.remoteAddress
    const ua = req.get('user-agent') || '-'
    console.log(`[api] ${req.method} ${req.originalUrl} ${res.statusCode} ua=${ua} ip=${ip} ${Date.now() - start}ms`)
  })
  next()
})

app.use('/api/v1', apiRoutes)
app.use('/', pageRoutes)

// Must be after routes
app.use(notFoundHandler)
app.use(errorHandler)

// Start server
const server = app.listen(PORT, () => {
  console.log(`[server] 402index listening on port ${PORT}`)
  if (!process.env.DIGEST_API_KEY) {
    console.log('[server] DIGEST_API_KEY not set — /api/v1/digest endpoint disabled')
  }
  startScheduler()
})

process.on('SIGTERM', () => shutdown(server, 'SIGTERM'))
process.on('SIGINT', () => shutdown(server, 'SIGINT'))
