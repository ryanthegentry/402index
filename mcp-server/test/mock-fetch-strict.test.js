import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { installMockFetch, restoreFetch } from './helpers/mock-fetch.js'

describe('mock-fetch strict fallback', () => {
  before(() => installMockFetch())
  after(() => restoreFetch())

  it('throws on services query with no matching fixture', async () => {
    await assert.rejects(
      () => fetch('http://mock.test/api/v1/services?limit=10'),
      /No fixture for services query/,
      'unmatched services query should throw, not silently return limit=5 fixture'
    )
  })

  it('throws on unknown pathname', async () => {
    await assert.rejects(
      () => fetch('http://mock.test/api/v1/unknown-endpoint'),
      /No fixture for URL/,
      'unknown pathname should throw'
    )
  })
})
