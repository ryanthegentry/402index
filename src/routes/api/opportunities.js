import { Router } from 'express'
import db from '../../db.js'
import { findOpportunities } from '../../services/opportunities.js'

const router = Router()

router.get('/opportunities', (req, res) => {
  try {
    const opportunities = findOpportunities(db, { protocol: req.query.protocol })
    res.json({ opportunities, total: opportunities.length })
  } catch (err) {
    console.error('GET /api/v1/opportunities error:', err)
    res.status(500).json({ error: 'Internal Server Error' })
  }
})


export default router
