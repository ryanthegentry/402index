import { Router } from 'express'
import db from '../../db.js'
import { registerWebhook, deleteWebhook, getWebhook } from '../../services/webhooks.js'

const router = Router()

router.post('/webhooks', async (req, res) => {
  try {
    const { url, secret, events, protocol_filter } = req.body || {}
    const result = registerWebhook(db, { url, secret, events, protocol_filter })
    res.status(201).json(result)
  } catch (err) {
    const status = err.message.includes('required') || err.message.includes('HTTPS') || err.message.includes('Invalid') ? 400 : 500
    res.status(status).json({ error: err.message })
  }
})

router.get('/webhooks/:id', (req, res) => {
  try {
    const secret = req.headers['x-webhook-secret']
    if (!secret) return res.status(401).json({ error: 'X-Webhook-Secret header required' })
    const result = getWebhook(db, req.params.id, secret)
    res.json(result)
  } catch (err) {
    if (err.message.includes('not found')) return res.status(404).json({ error: err.message })
    if (err.message.includes('Unauthorized')) return res.status(401).json({ error: err.message })
    res.status(500).json({ error: err.message })
  }
})

router.delete('/webhooks/:id', (req, res) => {
  try {
    const secret = req.headers['x-webhook-secret']
    if (!secret) return res.status(401).json({ error: 'X-Webhook-Secret header required' })
    deleteWebhook(db, req.params.id, secret)
    res.json({ deleted: true })
  } catch (err) {
    if (err.message.includes('not found')) return res.status(404).json({ error: err.message })
    if (err.message.includes('Unauthorized')) return res.status(401).json({ error: err.message })
    res.status(500).json({ error: err.message })
  }
})


export default router
