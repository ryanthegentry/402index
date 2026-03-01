import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { fetchBtcUsdRate, getCachedBtcUsdRate, resetCache } from '../src/services/btc-price.js'

describe('btc-price', () => {
  let originalFetch

  beforeEach(() => {
    resetCache()
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  describe('getCachedBtcUsdRate', () => {
    it('returns fallback rate (90000) before any fetch', () => {
      assert.equal(getCachedBtcUsdRate(), 90_000)
    })
  })

  describe('resetCache', () => {
    it('resets rate back to fallback', async () => {
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({ bitcoin: { usd: 105000 } }),
      })
      await fetchBtcUsdRate()
      assert.equal(getCachedBtcUsdRate(), 105000)

      resetCache()
      assert.equal(getCachedBtcUsdRate(), 90_000)
    })
  })

  describe('fetchBtcUsdRate', () => {
    it('fetches rate from API and caches it', async () => {
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({ bitcoin: { usd: 95000 } }),
      })
      const rate = await fetchBtcUsdRate()
      assert.equal(rate, 95000)
      assert.equal(getCachedBtcUsdRate(), 95000)
    })

    it('returns cached rate on second call within TTL', async () => {
      let fetchCount = 0
      globalThis.fetch = async () => {
        fetchCount++
        return {
          ok: true,
          json: async () => ({ bitcoin: { usd: 95000 } }),
        }
      }
      await fetchBtcUsdRate()
      await fetchBtcUsdRate()
      assert.equal(fetchCount, 1)
    })

    it('returns cached rate when API returns non-OK status', async () => {
      globalThis.fetch = async () => ({ ok: false, status: 500 })
      const rate = await fetchBtcUsdRate()
      assert.equal(rate, 90_000) // fallback
    })

    it('returns cached rate when API returns invalid response shape', async () => {
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({ unexpected: 'shape' }),
      })
      const rate = await fetchBtcUsdRate()
      assert.equal(rate, 90_000)
    })

    it('returns cached rate when fetch throws', async () => {
      globalThis.fetch = async () => { throw new Error('network error') }
      const rate = await fetchBtcUsdRate()
      assert.equal(rate, 90_000)
    })

    it('returns cached rate when rate is non-numeric', async () => {
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({ bitcoin: { usd: 'not a number' } }),
      })
      const rate = await fetchBtcUsdRate()
      assert.equal(rate, 90_000)
    })
  })
})
