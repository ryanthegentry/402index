import { Router } from 'express'
import db from '../../db.js'
import { buildProbeSample } from '../pages.js'
import { validateProbeUrl, runProbeSteps } from '../../services/probe-live.js'

const router = Router()

router.get('/demo/probe-sample', (req, res) => {
  try {
    const protocol = req.query.protocol || 'L402'
    const sample = buildProbeSample(db, protocol)
    res.json(sample)
  } catch (err) {
    console.error('GET /api/v1/demo/probe-sample error:', err)
    res.status(500).json({ error: 'Internal Server Error' })
  }
})

// SSE live probe — streams health check steps in real time
const probeLiveRateLimit = new Map()
const PROBE_RATE_LIMIT_MS = 12000 // 5 per minute
const PROBE_RATE_LIMIT_MAX = 5

router.get('/demo/probe-live', async (req, res) => {
  const url = req.query.url
  const validationError = validateProbeUrl(url)
  if (validationError) {
    return res.status(400).json({ error: validationError })
  }

  // Rate limit by IP
  const ip = req.ip || req.connection.remoteAddress
  const now = Date.now()
  const entries = probeLiveRateLimit.get(ip) || []
  const recent = entries.filter(t => now - t < 60000)
  if (recent.length >= PROBE_RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Rate limit exceeded — max 5 probes per minute' })
  }
  recent.push(now)
  probeLiveRateLimit.set(ip, recent)

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  try {
    for await (const step of runProbeSteps(url, db)) {
      if (res.writableEnded) break
      res.write(`data: ${JSON.stringify(step)}\n\n`)
    }
  } catch (err) {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ step: 'error', message: err.message })}\n\n`)
    }
  }

  if (!res.writableEnded) {
    res.end()
  }
})

export default router
