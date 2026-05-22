import { Router } from 'express'
import { initiateClaim, verifyClaim, editService, revokeClaim, deleteService, bulkDeleteServices } from '../../services/domain-verify.js'

const router = Router()

router.post('/claim', (req, res) => {
  try {
    const { domain, contact_email } = req.body || {}
    const result = initiateClaim(domain, contact_email)
    if (result.error) {
      return res.status(result.status).json({ error: result.error })
    }
    return res.status(result.status).json(result.data)
  } catch (err) {
    console.error('[claim] Error:', err.message)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/v1/claim/verify — Verify a pending domain claim
router.post('/claim/verify', async (req, res) => {
  try {
    const { domain } = req.body || {}
    const result = await verifyClaim(domain)
    if (result.error) {
      return res.status(result.status).json({ error: result.error })
    }
    return res.status(result.status).json(result.data)
  } catch (err) {
    console.error('[claim/verify] Error:', err.message)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/v1/claim/revoke — Revoke a verified domain claim
router.post('/claim/revoke', (req, res) => {
  try {
    const { domain, verification_token } = req.body || {}
    const result = revokeClaim(domain, verification_token)
    if (result.error) {
      return res.status(result.status).json({ error: result.error })
    }
    return res.status(result.status).json(result.data)
  } catch (err) {
    console.error('[claim/revoke] Error:', err.message)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// PATCH /api/v1/services/:id — Edit a listing by verified domain owner
router.patch('/services/:id', (req, res) => {
  try {
    const result = editService(req.params.id, req.body || {})
    if (result.error) {
      return res.status(result.status).json({ error: result.error })
    }
    const editedFields = Object.keys(req.body || {}).filter(k => !['domain', 'verification_token'].includes(k))
    console.log(`[services/patch] EDIT: service=${req.params.id} domain=${req.body?.domain} fields=${editedFields.join(',')}`)
    return res.status(result.status).json(result.data)
  } catch (err) {
    console.error('[services/patch] Error:', err.message)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/v1/services/:id — Soft-delete a listing by verified domain owner
router.delete('/services/:id', (req, res) => {
  try {
    const result = deleteService(req.params.id, req.body || {})
    if (result.error) {
      return res.status(result.status).json({ error: result.error })
    }
    console.log(`[services/delete] SOFT-DELETE: service=${req.params.id} domain=${req.body?.domain}`)
    return res.status(result.status).json(result.data)
  } catch (err) {
    console.error('[services/delete] Error:', err.message)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/v1/services/bulk-delete — Soft-delete multiple listings by verified domain owner
router.post('/services/bulk-delete', (req, res) => {
  try {
    const { domain, verification_token, service_ids } = req.body || {}
    const result = bulkDeleteServices(service_ids, { domain, verification_token })
    if (result.error) {
      return res.status(result.status).json({ error: result.error })
    }
    console.log(`[services/bulk-delete] SOFT-DELETE: domain=${domain} deleted=${result.data.deleted.length} skipped=${result.data.skipped.length}`)
    return res.status(result.status).json(result.data)
  } catch (err) {
    console.error('[services/bulk-delete] Error:', err.message)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
