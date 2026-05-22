import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

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
