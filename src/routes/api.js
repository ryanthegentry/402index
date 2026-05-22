import { Router } from 'express'
import adminRoutes from './api/admin.js'
import demoRoutes from './api/demo.js'
import digestRoutes from './api/digest.js'
import docsRoutes from './api/docs.js'
import domainVerificationRoutes from './api/domain-verification.js'
import healthRoutes from './api/health.js'
import opportunitiesRoutes from './api/opportunities.js'
import registerRoutes, { domainProbeQueue, PROBE_INTER_DELAY_MS } from './api/register.js'
import servicesRoutes from './api/services.js'
import webhooksRoutes from './api/webhooks.js'

const router = Router()

router.use(docsRoutes)
router.use(servicesRoutes)
router.use(healthRoutes)
router.use(registerRoutes)
router.use(digestRoutes)
router.use(demoRoutes)
router.use(adminRoutes)
router.use(opportunitiesRoutes)
router.use(webhooksRoutes)
router.use(domainVerificationRoutes)

export default router
export { domainProbeQueue, PROBE_INTER_DELAY_MS }
