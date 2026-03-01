import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseL402AppsHtml, normalizeApp, normalizeApi, categorize } from '../src/aggregators/l402apps-utils.js'

describe('parseL402AppsHtml', () => {
  it('extracts __APPS__ and __APIS__ from HTML', () => {
    const html = `
      <script>
      window.__APPS__=[{"id":"abc","name":"TestApp","url":"https://test.com","description":"A test app"}];
      window.__APIS__=[{"id":"def","provider":"TestProvider","name":"TestAPI","endpoint":"https://api.test.com/v1","description":"A test API","cost":100}];
      </script>
    `
    const { apps, apis } = parseL402AppsHtml(html)
    assert.equal(apps.length, 1)
    assert.equal(apps[0].name, 'TestApp')
    assert.equal(apis.length, 1)
    assert.equal(apis[0].name, 'TestAPI')
    assert.equal(apis[0].cost, 100)
  })

  it('returns empty arrays when no data found', () => {
    const { apps, apis } = parseL402AppsHtml('<html><body>nothing here</body></html>')
    assert.deepEqual(apps, [])
    assert.deepEqual(apis, [])
  })

  it('handles nested objects in JSON', () => {
    const html = `window.__APPS__=[{"id":"a","name":"App","url":"https://x.com","description":"desc","boost":{"amount":100}}];`
    const { apps } = parseL402AppsHtml(html)
    assert.equal(apps.length, 1)
    assert.deepEqual(apps[0].boost, { amount: 100 })
  })
})

describe('normalizeApp', () => {
  it('normalizes an app with all fields', () => {
    const result = normalizeApp({
      id: 'abc123',
      name: 'Test App',
      url: 'http://test.com/',
      description: 'A test application',
    })
    assert.equal(result.name, 'Test App')
    assert.equal(result.url, 'https://test.com/')
    assert.equal(result.description, 'A test application')
    assert.equal(result.provider, 'Test App')
    assert.equal(result.source_id, 'abc123')
    assert.equal(result.price_sats, null)
    assert.ok(result.id) // UUID generated
  })

  it('throws on missing URL', () => {
    assert.throws(() => normalizeApp({ name: 'No URL' }), /missing URL/)
  })

  it('uses URL as name when name is missing', () => {
    const result = normalizeApp({ url: 'https://example.com' })
    assert.equal(result.name, 'https://example.com')
  })
})

describe('normalizeApi', () => {
  it('normalizes an API with price conversion', () => {
    const result = normalizeApi({
      id: 'api-123',
      provider: 'TestProvider',
      name: 'TestEndpoint',
      endpoint: 'http://api.test.com/v1/resource',
      description: 'A test endpoint',
      cost: 100,
    }, 90000)
    assert.equal(result.name, 'TestProvider: TestEndpoint')
    assert.equal(result.url, 'https://api.test.com/v1/resource')
    assert.equal(result.price_sats, 100)
    assert.equal(result.price_usd, (100 / 100_000_000) * 90000)
    assert.equal(result.provider, 'TestProvider')
  })

  it('handles null cost', () => {
    const result = normalizeApi({
      endpoint: 'https://api.test.com',
      name: 'Free API',
    }, 90000)
    assert.equal(result.price_sats, null)
    assert.equal(result.price_usd, null)
  })

  it('throws on missing endpoint', () => {
    assert.throws(() => normalizeApi({ name: 'No Endpoint' }, 90000), /missing endpoint/)
  })

  it('uses endpoint as name when no name/provider', () => {
    const result = normalizeApi({ endpoint: 'https://api.test.com/v1' }, 90000)
    assert.equal(result.name, 'https://api.test.com/v1')
  })
})

describe('categorize', () => {
  it('categorizes AI/ML descriptions', () => {
    assert.equal(categorize({ description: 'Run a prompt through GPT-4o-mini' }), 'ai/ml')
    assert.equal(categorize({ description: 'Sentiment analysis for text' }), 'ai/ml')
    assert.equal(categorize({ description: 'Keyword extraction and ranking' }), 'ai/ml')
  })

  it('categorizes Bitcoin/Lightning descriptions', () => {
    assert.equal(categorize({ description: 'BTC price oracle' }), 'crypto/bitcoin')
    assert.equal(categorize({ description: 'Lightning Network statistics' }), 'crypto/bitcoin')
    assert.equal(categorize({ description: 'Mempool fee heatmap' }), 'crypto/bitcoin')
  })

  it('categorizes identity/trust descriptions', () => {
    assert.equal(categorize({ description: 'Trust score for Nostr pubkeys' }), 'identity')
    assert.equal(categorize({ description: 'Sybil resistance score' }), 'identity')
    assert.equal(categorize({ description: 'Spam classification using signals' }), 'identity')
  })

  it('categorizes storage descriptions', () => {
    assert.equal(categorize({ description: 'Persistent key-value storage for agents' }), 'storage')
  })

  it('returns uncategorized for unknown descriptions', () => {
    assert.equal(categorize({ description: 'Something completely unrelated' }), 'uncategorized')
    assert.equal(categorize({}), 'uncategorized')
  })
})
