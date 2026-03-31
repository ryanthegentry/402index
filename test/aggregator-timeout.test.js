import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

describe('aggregator fetch timeouts', () => {
  let originalFetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('bazaar fetch passes AbortSignal.timeout to fetch', async () => {
    let capturedSignal = null

    globalThis.fetch = async (url, opts) => {
      capturedSignal = opts?.signal
      // Return valid response to end the poll loop
      return {
        ok: true,
        status: 200,
        json: async () => ({
          pagination: { total: 0 },
          items: [],
        }),
      }
    }

    // Dynamic import to pick up mocked fetch
    const { pollBazaar } = await import(`../src/aggregators/bazaar.js?t=${Date.now()}`)
    await pollBazaar()

    assert.ok(capturedSignal, 'fetch should receive a signal option')
    assert.ok(capturedSignal instanceof AbortSignal, 'signal should be an AbortSignal')
  })

  it('satring fetchPage passes AbortSignal.timeout to fetch', async () => {
    let capturedSignal = null

    globalThis.fetch = async (url, opts) => {
      capturedSignal = opts?.signal
      return {
        ok: true,
        status: 200,
        json: async () => ({
          total: 0,
          services: [],
        }),
      }
    }

    // Enable satring for this test
    const origEnabled = process.env.SATRING_ENABLED
    process.env.SATRING_ENABLED = 'true'

    try {
      const { pollSatring } = await import(`../src/aggregators/satring.js?t=${Date.now()}`)
      await pollSatring()

      assert.ok(capturedSignal, 'fetch should receive a signal option')
      assert.ok(capturedSignal instanceof AbortSignal, 'signal should be an AbortSignal')
    } finally {
      if (origEnabled === undefined) {
        delete process.env.SATRING_ENABLED
      } else {
        process.env.SATRING_ENABLED = origEnabled
      }
    }
  })

  it('bazaar handles fetch timeout abort gracefully', async () => {
    globalThis.fetch = async (url, opts) => {
      // Simulate AbortSignal.timeout behavior
      const err = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      throw err
    }

    const { pollBazaar } = await import(`../src/aggregators/bazaar.js?t=${Date.now() + 1}`)
    // Should not throw — catch block handles it and poll stops gracefully
    const result = await pollBazaar()
    assert.ok(result, 'pollBazaar should return a result even on timeout')
    assert.equal(result.new, 0)
    assert.equal(result.updated, 0)
  })

  it('satring handles fetch timeout abort gracefully', async () => {
    globalThis.fetch = async (url, opts) => {
      const err = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      throw err
    }

    const origEnabled = process.env.SATRING_ENABLED
    process.env.SATRING_ENABLED = 'true'

    try {
      const { pollSatring } = await import(`../src/aggregators/satring.js?t=${Date.now() + 1}`)
      const result = await pollSatring()
      assert.ok(result, 'pollSatring should return a result even on timeout')
      assert.equal(result.new, 0)
      assert.equal(result.updated, 0)
    } finally {
      if (origEnabled === undefined) {
        delete process.env.SATRING_ENABLED
      } else {
        process.env.SATRING_ENABLED = origEnabled
      }
    }
  })
})
