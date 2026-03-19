import { layout } from '../views/layout.js'

const isProduction = process.env.NODE_ENV === 'production'

/**
 * Express middleware that creates a 404 error and passes it to the error handler.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function notFoundHandler(req, res, next) {
  const err = new Error('Not Found')
  err.status = 404
  next(err)
}

/**
 * Express error-handling middleware. Returns JSON for /api/ routes, HTML otherwise.
 * @param {Error & {status?: number}} err
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} _next
 */
export function errorHandler(err, req, res, _next) {
  const status = err.status || 500
  const message = status === 404 ? 'Not Found' : 'Internal Server Error'

  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}:`, err.stack || err.message)
  }

  // JSON for API routes
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(status).json({
      error: message,
      ...(isProduction ? {} : { detail: err.message }),
    })
  }

  // HTML for web routes — styled 404/500
  const body = `<div class="container" style="text-align:center;padding:80px 0">
    <h1 style="font-size:72px;margin:0;font-family:var(--mono)">${status}</h1>
    <p style="font-size:18px;color:var(--text-muted);margin:16px 0">${message}</p>
    <a href="/" style="color:var(--blue)">Back to 402 Index</a>
  </div>`
  res.status(status).send(layout(`${status} ${message}`, body))
}
