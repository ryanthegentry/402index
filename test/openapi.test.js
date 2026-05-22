import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { readFileSync } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── OpenAPI Spec Tests ─────────────────────────────────────────────────────

describe('OpenAPI spec — structure', async () => {
  const { openapiSpec } = await import('../src/openapi.js')

  it('has openapi field with value "3.1.0"', () => {
    assert.equal(openapiSpec.openapi, '3.1.0')
  })

  it('has info.title = "402 Index API"', () => {
    assert.equal(openapiSpec.info.title, '402 Index API')
  })

  it('has info.version', () => {
    assert.ok(openapiSpec.info.version)
  })

  it('has info.contact.email', () => {
    assert.equal(openapiSpec.info.contact.email, 'hello@402index.io')
  })

  it('has servers array with production URL', () => {
    assert.ok(Array.isArray(openapiSpec.servers))
    assert.ok(openapiSpec.servers.some(s => s.url === 'https://402index.io'))
  })

  it('has paths object with at least 8 paths', () => {
    const pathCount = Object.keys(openapiSpec.paths).length
    assert.ok(pathCount >= 8, `Expected at least 8 paths, got ${pathCount}`)
  })
})

describe('OpenAPI spec — /api/v1/services', async () => {
  const { openapiSpec } = await import('../src/openapi.js')
  const servicesPath = openapiSpec.paths['/api/v1/services']

  it('has GET method', () => {
    assert.ok(servicesPath.get)
  })

  it('has parameters array', () => {
    assert.ok(Array.isArray(servicesPath.get.parameters))
  })

  it('parameters include protocol, category, health, q, sort, limit', () => {
    const paramNames = servicesPath.get.parameters.map(p => p.name)
    for (const name of ['protocol', 'category', 'health', 'q', 'sort', 'limit']) {
      assert.ok(paramNames.includes(name), `Missing parameter: ${name}`)
    }
  })

  it('protocol parameter enum includes L402, x402, MPP', () => {
    const protocolParam = servicesPath.get.parameters.find(p => p.name === 'protocol')
    assert.ok(protocolParam.schema.enum)
    for (const proto of ['L402', 'x402', 'MPP']) {
      assert.ok(protocolParam.schema.enum.includes(proto), `Missing protocol enum value: ${proto}`)
    }
  })

  it('has 200 response', () => {
    assert.ok(servicesPath.get.responses['200'])
  })

  it('has 402 response documenting L402 payment', () => {
    assert.ok(servicesPath.get.responses['402'])
  })
})

describe('OpenAPI spec — /api/v1/register', async () => {
  const { openapiSpec } = await import('../src/openapi.js')
  const registerPath = openapiSpec.paths['/api/v1/register']

  it('has POST method', () => {
    assert.ok(registerPath.post)
  })

  it('has request body', () => {
    assert.ok(registerPath.post.requestBody)
  })

  it('has 201, 422, and 429 responses', () => {
    for (const code of ['201', '422', '429']) {
      assert.ok(registerPath.post.responses[code], `Missing response code: ${code}`)
    }
  })
})

describe('OpenAPI spec — other endpoints', async () => {
  const { openapiSpec } = await import('../src/openapi.js')

  it('has /api/v1/services/{id} with GET', () => {
    const path = openapiSpec.paths['/api/v1/services/{id}']
    assert.ok(path?.get)
  })

  it('has /api/v1/health with GET', () => {
    assert.ok(openapiSpec.paths['/api/v1/health']?.get)
  })

  it('has /api/v1/categories with GET', () => {
    assert.ok(openapiSpec.paths['/api/v1/categories']?.get)
  })

  it('has /api/v1/export.csv with GET and 402 response', () => {
    const path = openapiSpec.paths['/api/v1/export.csv']
    assert.ok(path?.get)
    assert.ok(path.get.responses['402'])
  })

  it('has /api/v1/stats/snapshots with GET', () => {
    assert.ok(openapiSpec.paths['/api/v1/stats/snapshots']?.get)
  })

  it('has /api/v1/opportunities with GET', () => {
    assert.ok(openapiSpec.paths['/api/v1/opportunities']?.get)
  })

  it('has /feed.xml with GET', () => {
    assert.ok(openapiSpec.paths['/feed.xml']?.get)
  })

  it('has /api/v1/webhooks with POST', () => {
    assert.ok(openapiSpec.paths['/api/v1/webhooks']?.post)
  })

  it('has /api/v1/webhooks/{id} with GET and DELETE', () => {
    const path = openapiSpec.paths['/api/v1/webhooks/{id}']
    assert.ok(path?.get)
    assert.ok(path?.delete)
  })
})

describe('OpenAPI spec — schemas', async () => {
  const { openapiSpec } = await import('../src/openapi.js')
  const schemas = openapiSpec.components?.schemas

  it('has components.schemas', () => {
    assert.ok(schemas)
  })

  it('contains Service schema', () => {
    assert.ok(schemas.Service)
  })

  it('Service schema has required fields: id, name, url, protocol', () => {
    assert.ok(Array.isArray(schemas.Service.required))
    for (const field of ['id', 'name', 'url', 'protocol']) {
      assert.ok(schemas.Service.required.includes(field), `Missing required field: ${field}`)
    }
  })

  it('contains HealthCheck schema', () => {
    assert.ok(schemas.HealthCheck)
  })

  it('contains DailySnapshot schema', () => {
    assert.ok(schemas.DailySnapshot)
  })

  it('contains Category schema', () => {
    assert.ok(schemas.Category)
  })
})

// ─── Markdown Docs Tests ────────────────────────────────────────────────────

describe('Markdown docs generator', async () => {
  const { openapiSpec, generateMarkdownDocs } = await import('../src/openapi.js')
  const md = generateMarkdownDocs(openapiSpec)

  it('returns a string', () => {
    assert.equal(typeof md, 'string')
  })

  it('starts with "# 402 Index API"', () => {
    assert.ok(md.startsWith('# 402 Index API'), `Starts with: ${md.substring(0, 50)}`)
  })

  it('contains GET /api/v1/services', () => {
    assert.ok(md.includes('GET /api/v1/services'))
  })

  it('contains POST /api/v1/register', () => {
    assert.ok(md.includes('POST /api/v1/register'))
  })

  it('contains parameter table formatting', () => {
    assert.ok(md.includes('| Name'), 'Missing table header')
    assert.ok(md.includes('|---'), 'Missing table separator')
  })

  it('contains response codes', () => {
    assert.ok(md.includes('200'))
    assert.ok(md.includes('402'))
  })
})

// ─── Integration: API docs page links ───────────────────────────────────────

describe('API docs page — machine-readable links', async () => {
  const { apiDocsPage } = await import('../src/views/api-docs.js')
  const html = apiDocsPage()

  it('contains link to /api/v1/openapi.json', () => {
    assert.ok(html.includes('/api/v1/openapi.json'))
  })

  it('contains link to /api/v1/docs.md', () => {
    assert.ok(html.includes('/api/v1/docs.md'))
  })

  it('mentions OpenAPI 3.1', () => {
    assert.ok(html.includes('OpenAPI'))
  })
})

// ─── Integration: llms.txt links ────────────────────────────────────────────

describe('llms.txt content', async () => {
  // We can't easily test the route handler in isolation (it uses db),
  // but we can verify the template by checking the source file.
  const pagesSource = readFileSync(join(__dirname, '../src/routes/pages.js'), 'utf-8')

  it('llms.txt route contains API_SPEC line with openapi.json URL', () => {
    assert.ok(pagesSource.includes('API_SPEC:'), 'Missing API_SPEC line in llms.txt route')
    assert.ok(pagesSource.includes('openapi.json'), 'Missing openapi.json reference in llms.txt route')
  })

  it('llms.txt route contains API_DOCS_MD line with docs.md URL', () => {
    assert.ok(pagesSource.includes('API_DOCS_MD:'), 'Missing API_DOCS_MD line in llms.txt route')
    assert.ok(pagesSource.includes('docs.md'), 'Missing docs.md reference in llms.txt route')
  })
})

// ─── Verified param + domain_verified field — OpenAPI spec (#125) ────────────

describe('OpenAPI spec — verified param and domain_verified field', async () => {
  const { openapiSpec } = await import('../src/openapi.js')
  const servicesPath = openapiSpec.paths['/api/v1/services']
  const schemas = openapiSpec.components?.schemas

  it('parameters include verified', () => {
    const paramNames = servicesPath.get.parameters.map(p => p.name)
    assert.ok(paramNames.includes('verified'), 'Missing parameter: verified')
  })

  it('Service schema includes domain_verified as integer', () => {
    const prop = schemas.Service.properties.domain_verified
    assert.ok(prop, 'domain_verified missing from Service schema')
  })
})

// ─── Dual-protocol fields — OpenAPI spec (#90) ─────────────────────────────

describe('OpenAPI spec — dual-protocol fields', async () => {
  const { openapiSpec } = await import('../src/openapi.js')
  const schemas = openapiSpec.components.schemas
  const detailPath = openapiSpec.paths['/api/v1/services/{id}']
  const registerPath = openapiSpec.paths['/api/v1/register']

  it('Service schema has related_protocols as array of string', () => {
    const prop = schemas.Service.properties.related_protocols
    assert.ok(prop, 'related_protocols property missing from Service schema')
    assert.equal(prop.type, 'array')
    assert.equal(prop.items.type, 'string')
  })

  it('detail endpoint 200 response includes related_services', () => {
    const schema200 = detailPath.get.responses['200'].content['application/json'].schema
    // related_services should be in the allOf block alongside health_checks
    const extraProps = schema200.allOf[1].properties
    assert.ok(extraProps.related_services, 'related_services missing from detail 200 response')
    assert.equal(extraProps.related_services.type, 'array')
    const itemProps = extraProps.related_services.items.properties
    assert.ok(itemProps.id, 'related_services items missing id')
    assert.ok(itemProps.protocol, 'related_services items missing protocol')
    assert.ok(itemProps.health_status, 'related_services items missing health_status')
    assert.ok(itemProps.reliability_score, 'related_services items missing reliability_score')
  })

  it('registration 201 response includes also_registered', () => {
    const schema201 = registerPath.post.responses['201'].content['application/json'].schema
    const prop = schema201.properties.also_registered
    assert.ok(prop, 'also_registered missing from 201 response')
    assert.equal(prop.type, 'array')
    assert.ok(prop.items.$ref, 'also_registered items should use $ref to Service schema')
  })

  it('registration 422 response has structured content/schema with probe object', () => {
    const resp422 = registerPath.post.responses['422']
    assert.ok(resp422.content, '422 response missing content block')
    const schema = resp422.content['application/json'].schema
    assert.ok(schema.properties.probe, '422 schema missing probe property')
    const probeProps = schema.properties.probe.properties
    assert.ok(probeProps.httpStatus, 'probe missing httpStatus')
    assert.ok(probeProps.headersPresent, 'probe missing headersPresent')
    assert.ok(probeProps.bodySnippet, 'probe missing bodySnippet')
    assert.ok(probeProps.detectedProtocols, 'probe missing detectedProtocols')
    // suggestedProtocol is a top-level optional field
    assert.ok(schema.properties.suggestedProtocol, '422 schema missing suggestedProtocol')
  })
})

// ─── Dual-protocol fields — api-docs page (#90) ────────────────────────────

describe('API docs page — dual-protocol fields', async () => {
  const { apiDocsPage } = await import('../src/views/api-docs.js')
  const html = apiDocsPage()

  it('mentions related_protocols in response example', () => {
    assert.ok(html.includes('related_protocols'), 'api-docs page missing related_protocols')
  })

  it('mentions related_services for detail endpoint', () => {
    assert.ok(html.includes('related_services'), 'api-docs page missing related_services')
  })

  it('mentions also_registered for registration', () => {
    assert.ok(html.includes('also_registered'), 'api-docs page missing also_registered')
  })

  it('mentions probe diagnostics for 422 response', () => {
    assert.ok(html.includes('probe'), 'api-docs page missing probe diagnostics mention')
  })
})

// ─── Cache-Control test ─────────────────────────────────────────────────────

describe('OpenAPI route — cache headers', async () => {
  // Verify the route source sets Cache-Control
  const docsRouteSource = readFileSync(join(__dirname, '../src/routes/api/docs.js'), 'utf-8')

  it('openapi.json route sets Cache-Control public max-age=86400', () => {
    assert.ok(docsRouteSource.includes('openapi.json'), 'Missing openapi.json route')
    assert.ok(docsRouteSource.includes('86400'), 'Missing 86400 max-age for openapi.json route')
  })
})
