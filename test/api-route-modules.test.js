import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import apiRouter from '../src/routes/api.js'

const root = join(import.meta.dirname, '..')
const routeDir = join(root, 'src/routes/api')

const expectedModules = [
  'admin.js',
  'demo.js',
  'digest.js',
  'docs.js',
  'domain-verification.js',
  'health.js',
  'opportunities.js',
  'register.js',
  'services.js',
  'webhooks.js',
]

describe('API route module structure', () => {
  it('splits /api/v1 route groups into dedicated modules', () => {
    for (const file of expectedModules) {
      assert.ok(existsSync(join(routeDir, file)), `missing src/routes/api/${file}`)
    }
  })

  it('keeps src/routes/api.js as a thin route composer', () => {
    const source = readFileSync(join(root, 'src/routes/api.js'), 'utf8')
    const routeRegistrations = [...source.matchAll(/\brouter\.(get|post|patch|delete|put)\(/g)]

    assert.equal(routeRegistrations.length, 0, 'api.js should mount route modules, not define handlers inline')
    assert.ok(source.includes("from './api/register.js'"), 'api.js should compose the registration route module')
    assert.ok(source.includes("from './api/admin.js'"), 'api.js should compose the admin route module')
  })
})

// Walks the composed apiRouter's stack and collects (METHOD, path) pairs
// across all mounted sub-routers. Catches the failure mode where a
// `router.use(xRoutes)` line is removed from api.js but the structural
// test above still passes — the routes from that module would silently
// 404 in production. Coupled to Express 5's layer/route shape; if the
// internals change, swap `apiRouter.stack` traversal for a behavioral
// test (boot in-process app, HEAD each documented path).
function collectRoutes(router, prefix = '') {
  const out = []
  for (const layer of router.stack || []) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods || {})
        .filter(m => layer.route.methods[m])
      for (const method of methods) {
        out.push(`${method.toUpperCase()} ${prefix}${layer.route.path}`)
      }
    } else if (layer.handle && Array.isArray(layer.handle.stack)) {
      // Sub-router mounted via router.use(subRouter) — express stores the
      // mount prefix on layer.regexp. For root-mounted sub-routers
      // (router.use(subRouter), no path), recurse with the same prefix.
      out.push(...collectRoutes(layer.handle, prefix))
    }
  }
  return out
}

const EXPECTED_ROUTES = [
  // docs
  'GET /openapi.json',
  'GET /docs.md',
  // services
  'GET /services',
  'GET /services/:id',
  'GET /export.csv',
  // health
  'GET /health',
  'GET /stats/snapshots',
  'GET /categories',
  // register
  'POST /register',
  // digest
  'GET /digest',
  // demo
  'GET /demo/probe-sample',
  'GET /demo/probe-live',
  // admin
  'GET /admin/pending',
  'GET /admin/recent',
  'GET /admin/search',
  'DELETE /admin/services/:id',
  'POST /admin/approve/:id',
  'POST /admin/reject/:id',
  'POST /admin/services/:id/restore',
  'POST /admin/services/:id/probe-status',
  'GET /admin/domains',
  'POST /admin/domains/:domain/reset',
  'GET /admin/failed-registrations',
  'GET /admin/traffic',
  'GET /admin/protocol-changes',
  'POST /admin/protocol-changes/:id/approve',
  'POST /admin/protocol-changes/:id/dismiss',
  'POST /admin/vacuum',
  // opportunities
  'GET /opportunities',
  // webhooks
  'POST /webhooks',
  'GET /webhooks/:id',
  'DELETE /webhooks/:id',
  // domain verification — both /claim* and the verified-provider /services/:id edits
  'POST /claim',
  'POST /claim/verify',
  'POST /claim/revoke',
  'PATCH /services/:id',
  'DELETE /services/:id',
  'POST /services/bulk-delete',
]

describe('API route composer — actual mount coverage', () => {
  const mounted = collectRoutes(apiRouter)
  const mountedSet = new Set(mounted)

  it('mounts every documented /api/v1 route', () => {
    const missing = EXPECTED_ROUTES.filter(r => !mountedSet.has(r))
    assert.equal(
      missing.length,
      0,
      `${missing.length} expected route(s) not reachable through the composer:\n  ${missing.join('\n  ')}`,
    )
  })

  it('exposes exactly 38 distinct (method, path) pairs', () => {
    // Pin the total. If this changes, either a route was added (update
    // EXPECTED_ROUTES + this count) or a route was dropped (find out why
    // before bumping the number).
    assert.equal(mountedSet.size, 38,
      `expected 38 mounted routes, found ${mountedSet.size}. ` +
      `Mounted: [${[...mountedSet].sort().join(', ')}]`)
  })
})
