const isProduction = process.env.NODE_ENV === 'production'

export function notFoundHandler(req, res, next) {
  const err = new Error('Not Found')
  err.status = 404
  next(err)
}

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

  // HTML for web routes
  res.status(status).send(`
    <!DOCTYPE html>
    <html><head><title>${status} ${message}</title></head>
    <body style="font-family:monospace;text-align:center;padding:60px">
      <h1>${status}</h1>
      <p>${message}</p>
      <a href="/">Back to 402 Index</a>
    </body></html>
  `)
}
