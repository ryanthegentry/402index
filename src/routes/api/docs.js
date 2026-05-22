import { Router } from 'express'
import { openapiSpec, generateMarkdownDocs } from '../../openapi.js'

const router = Router()

router.get('/openapi.json', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400')
  res.json(openapiSpec)
})

const markdownDocs = generateMarkdownDocs(openapiSpec)
router.get('/docs.md', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400')
  res.type('text/markdown').send(markdownDocs)
})

export default router
