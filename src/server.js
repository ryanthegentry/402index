import express from 'express'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { notFoundHandler, errorHandler } from './middleware/error-handler.js'
import { verifyL402 } from './middleware/l402.js'
import { freeLimiter, l402Limiter } from './middleware/rate-limit.js'
import apiRoutes from './routes/api.js'
import pageRoutes from './routes/pages.js'
import { startScheduler, shutdown } from './scheduler.js'

const app = express()
const PORT = process.env.PORT || 3402

if (process.env.NODE_ENV !== 'production') {
  console.warn('[server] WARNING: NODE_ENV is not "production" (current: %s)', process.env.NODE_ENV || 'undefined')
}

app.use(helmet({ contentSecurityPolicy: false }))

// Trust proxy in production (Railway, Fly.io)
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1)
}

// Registration endpoint: JSON body parsing + IP-based rate limit (10/hour)
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: parseInt(process.env.REGISTER_RATE_LIMIT) || 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many registrations. Limit: 10 per hour per IP.' },
})
app.use('/api/v1/register', express.json(), registerLimiter)

// Rate-limited API routes: services, services/:id, categories
app.use('/api/v1/services', verifyL402, freeLimiter, l402Limiter)
app.use('/api/v1/categories', verifyL402, freeLimiter, l402Limiter)
// /api/v1/health is exempt from rate limiting (uptime monitors)

app.use('/api/v1', apiRoutes)
app.use('/', pageRoutes)

// Must be after routes
app.use(notFoundHandler)
app.use(errorHandler)

// Start server
const server = app.listen(PORT, () => {
  console.log(`[server] 402index listening on port ${PORT}`)
  startScheduler()
})

process.on('SIGTERM', () => shutdown(server, 'SIGTERM'))
process.on('SIGINT', () => shutdown(server, 'SIGINT'))
