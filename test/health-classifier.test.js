import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyHealthStatus } from '../src/health/checker.js'

describe('classifyHealthStatus', () => {
  describe('error cases', () => {
    it('returns unknown on first failure', () => {
      const result = classifyHealthStatus(null, 'timeout', 0, null, null)
      assert.equal(result.healthStatus, 'unknown')
      assert.equal(result.checkStatus, 'timeout')
      assert.equal(result.consecutiveFailures, 1)
    })

    it('returns down after 3 consecutive failures', () => {
      const result = classifyHealthStatus(null, 'connection refused', 2, null, null)
      assert.equal(result.healthStatus, 'down')
      assert.equal(result.checkStatus, 'error')
      assert.equal(result.consecutiveFailures, 3)
    })

    it('returns unknown on second failure', () => {
      const result = classifyHealthStatus(null, 'timeout', 1, null, null)
      assert.equal(result.healthStatus, 'unknown')
      assert.equal(result.consecutiveFailures, 2)
    })

    it('uses "timeout" check status for timeout errors', () => {
      const result = classifyHealthStatus(null, 'timeout', 0, null, null)
      assert.equal(result.checkStatus, 'timeout')
    })

    it('uses "error" check status for non-timeout errors', () => {
      const result = classifyHealthStatus(null, 'ECONNREFUSED', 0, null, null)
      assert.equal(result.checkStatus, 'error')
    })
  })

  describe('402 responses', () => {
    it('returns healthy for 402 response', () => {
      const result = classifyHealthStatus(402, null, 0, null, 100)
      assert.equal(result.healthStatus, 'healthy')
      assert.equal(result.checkStatus, 'healthy')
      assert.equal(result.consecutiveFailures, 0)
    })

    it('returns degraded for 402 with high latency', () => {
      const result = classifyHealthStatus(402, null, 0, 100, 250)
      assert.equal(result.healthStatus, 'degraded')
      assert.equal(result.checkStatus, 'degraded')
    })

    it('returns healthy for 402 with acceptable latency', () => {
      const result = classifyHealthStatus(402, null, 0, 100, 180)
      assert.equal(result.healthStatus, 'healthy')
    })
  })

  describe('200 responses', () => {
    it('returns degraded for 200 (possible misconfiguration)', () => {
      const result = classifyHealthStatus(200, null, 0, null, 100)
      assert.equal(result.healthStatus, 'degraded')
      assert.equal(result.checkStatus, 'degraded')
    })

    it('preserves previous failure count on 200', () => {
      const result = classifyHealthStatus(200, null, 2, null, 100)
      assert.equal(result.consecutiveFailures, 2)
    })
  })

  describe('5xx responses', () => {
    it('returns degraded for first 500 error', () => {
      const result = classifyHealthStatus(500, null, 0, null, 100)
      assert.equal(result.healthStatus, 'degraded')
      assert.equal(result.checkStatus, 'down')
      assert.equal(result.consecutiveFailures, 1)
    })

    it('returns down after 3 consecutive 5xx errors', () => {
      const result = classifyHealthStatus(503, null, 2, null, 100)
      assert.equal(result.healthStatus, 'down')
      assert.equal(result.consecutiveFailures, 3)
    })
  })

  describe('429 rate limited', () => {
    it('returns degraded with rate_limited check status', () => {
      const result = classifyHealthStatus(429, null, 0, null, 100)
      assert.equal(result.healthStatus, 'degraded')
      assert.equal(result.checkStatus, 'rate_limited')
    })

    it('preserves previous failure count on 429', () => {
      const result = classifyHealthStatus(429, null, 2, null, 100)
      assert.equal(result.consecutiveFailures, 2)
    })
  })

  describe('405 method not allowed', () => {
    it('returns degraded with method_not_allowed check status', () => {
      const result = classifyHealthStatus(405, null, 0, null, 100)
      assert.equal(result.healthStatus, 'degraded')
      assert.equal(result.checkStatus, 'method_not_allowed')
    })

    it('preserves previous failure count on 405', () => {
      const result = classifyHealthStatus(405, null, 1, null, 100)
      assert.equal(result.consecutiveFailures, 1)
    })
  })

  describe('other status codes', () => {
    it('returns degraded for 3xx responses', () => {
      const result = classifyHealthStatus(301, null, 0, null, 100)
      assert.equal(result.healthStatus, 'degraded')
      assert.equal(result.checkStatus, 'degraded')
    })

    it('returns degraded for 4xx (non-402/429/405) responses', () => {
      const result = classifyHealthStatus(403, null, 0, null, 100)
      assert.equal(result.healthStatus, 'degraded')
    })
  })
})
