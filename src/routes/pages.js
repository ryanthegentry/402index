import { Router } from 'express'

const router = Router()

router.get('/', (req, res) => {
  res.send('<h1>402 Index</h1><p>Coming soon.</p>')
})

export default router
